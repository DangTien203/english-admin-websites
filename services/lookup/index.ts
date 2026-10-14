import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { createPgBossEnqueuer } from '../queue';
import { currentPeriod } from '../upstream/apiUsage';
import { getUpstreamClients, UpstreamClients } from '../upstream';
import { EnrichmentEnqueuer, NoopEnqueuer } from './enqueuer';
import { FallbackFastTranslator, FastTranslator, GoogleFastTranslator } from './fastTranslator';
import { HaikuFastTranslator } from './haikuFastTranslator';
import { getRefDb } from './refDb';
import { WordLookupService } from './lookupService';
import { UserRateLimiter } from './rateLimiter';
import { SingleFlight } from './singleFlight';
import type { Db, UpstreamBundle } from './types';

/**
 * Production wiring of the word-lookup fast path (config + real clients + real database).
 * Created lazily, once per process.
 */

let enqueuer: EnrichmentEnqueuer | undefined;
let service: WordLookupService | undefined;
// Module-level so replacing the enqueuer does not reset the rate-limit counters or in-flight lookups.
let rateLimiter: UserRateLimiter | undefined;
let singleFlight: SingleFlight<UpstreamBundle> | undefined;

/** ENRICHMENT_ENABLED=true → the pg-boss enqueuer (P5); otherwise the Noop one, which reports 'disabled'. */
function getEnqueuer(): EnrichmentEnqueuer {
  enqueuer ??= lookupConfig.flags.enrichmentEnabled ? createPgBossEnqueuer() : new NoopEnqueuer();
  return enqueuer;
}

/** Replaces the enqueuer (tests). */
export function setEnrichmentEnqueuer(next: EnrichmentEnqueuer): void {
  enqueuer = next;
  service = undefined; // rebuilt with the new enqueuer on next use
}

/** Usage ledger name for the fast-path Haiku calls (api_usage_counters.provider). */
export const HAIKU_FAST_USAGE_PROVIDER = 'anthropic_fast';

/** LOOKUP_FAST_TRANSLATOR: google (default) or haiku-with-automatic-Google-fallback. */
export function buildFastTranslator(clients: UpstreamClients): FastTranslator {
  const google = new GoogleFastTranslator(clients.google);
  if (lookupConfig.lookup.fastTranslator !== 'haiku') return google;

  const haiku = new HaikuFastTranslator({
    client: clients.anthropicFast,
    maxMeanings: lookupConfig.lookup.maxMeanings,
    recordUsage: async ({ inputTokens, outputTokens }) => {
      const period = currentPeriod('day');
      await clients.usage.add(HAIKU_FAST_USAGE_PROVIDER, 'input_tokens', period, inputTokens);
      await clients.usage.add(HAIKU_FAST_USAGE_PROVIDER, 'output_tokens', period, outputTokens);
    },
  });
  return new FallbackFastTranslator(haiku, google, (reason, err) =>
    console.warn(JSON.stringify({ evt: 'fast_translator_fallback', from: 'haiku', to: 'google', reason, error: String((err as Error)?.message ?? err).slice(0, 160) }))
  );
}

export function getWordLookupService(): WordLookupService {
  if (service) return service;

  const clients = getUpstreamClients();
  service = new WordLookupService({
    db: pool,
    refDb: getRefDb(),
    translator: buildFastTranslator(clients),
    google: clients.google,
    freeDictionary: clients.freeDictionary,
    enqueuer: getEnqueuer(),
    rateLimiter: (rateLimiter ??= new UserRateLimiter(lookupConfig.lookup.missRateLimitPerMin)),
    singleFlight: (singleFlight ??= new SingleFlight<UpstreamBundle>()),
    config: {
      totalDeadlineMs: lookupConfig.lookup.totalDeadlineMs,
      maxMeanings: lookupConfig.lookup.maxMeanings,
      translateDefinitions: lookupConfig.lookup.translateDefinitions,
      maxDefinitionChars: lookupConfig.google.maxDefinitionChars,
      translationFallbackEnabled: lookupConfig.flags.translationFallbackEnabled,
      enrichmentEnabled: lookupConfig.flags.enrichmentEnabled,
    },
  });
  return service;
}
