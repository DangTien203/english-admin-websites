import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import type { EnrichmentEnqueuer } from '../lookup/enqueuer';
import { getBoss } from './boss';
import { PgBossEnrichmentEnqueuer } from './pgBossEnqueuer';

export { startEnrichmentRuntime } from './runtime';
export { stopBoss } from './boss';

/** The production enqueuer: real pool, real pg-boss (started on first use), the configured daily cap. */
export function createPgBossEnqueuer(): EnrichmentEnqueuer {
  return new PgBossEnrichmentEnqueuer({
    pool: pool as any,
    getBoss: () => getBoss(),
    maxJobsPerDay: lookupConfig.queue.maxJobsPerDay,
  });
}
