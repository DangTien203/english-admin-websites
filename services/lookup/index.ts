import { Pool } from 'pg';
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { getUpstreamClients } from '../upstream';
import { EnrichmentEnqueuer, NoopEnqueuer } from './enqueuer';
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

export function getWordLookupService(): WordLookupService {
  if (service) return service;

  const clients = getUpstreamClients();
  service = new WordLookupService({
    db: pool,
    refDb: getRefDb(),
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
