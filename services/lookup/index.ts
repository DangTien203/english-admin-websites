import { Pool } from 'pg';
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { currentPeriod } from '../upstream/apiUsage';
import { getUpstreamClients, UpstreamClients } from '../upstream';
import { EnrichmentEnqueuer, NoopEnqueuer } from './enqueuer';
import { FallbackFastTranslator, FastTranslator, GoogleFastTranslator } from './fastTranslator';
import { HaikuFastTranslator } from './haikuFastTranslator';
import { WordLookupService } from './lookupService';
import { UserRateLimiter } from './rateLimiter';
import { SingleFlight } from './singleFlight';
import type { Db, UpstreamBundle } from './types';

/**
 * Production wiring of the word-lookup fast path (config + real clients + real database).
 * Created lazily, once per process.
 */

let enqueuer: EnrichmentEnqueuer = new NoopEnqueuer();
let refPool: Pool | undefined;
let service: WordLookupService | undefined;
// Module-level so replacing the enqueuer does not reset the rate-limit counters or in-flight lookups.
let rateLimiter: UserRateLimiter | undefined;
let singleFlight: SingleFlight<UpstreamBundle> | undefined;

/** P5 registers the real queue here; until then the Noop enqueuer reports 'disabled'. */
export function setEnrichmentEnqueuer(next: EnrichmentEnqueuer): void {
  enqueuer = next;
  service = undefined; // rebuilt with the new enqueuer on next use
}

/** The main pool, or a small dedicated pool when REFDATA_DATABASE_URL puts ref_* tables elsewhere. */
function getRefDb(): Db {
  const url = lookupConfig.refdata.databaseUrl;
  if (!url) return pool;
  refPool ??= new Pool({
    connectionString: url,
    max: 3,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  return refPool;
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
    enqueuer,
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
