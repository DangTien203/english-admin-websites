import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { EnrichmentConfigError } from '../enrichment/errors';
import { runEnrichment } from '../enrichment/pipeline';
import { loadTopicIds } from '../enrichment/topics';
import { getBoss, stopBoss, type BossRole } from './boss';
import { SHUTDOWN_GRACE_MS } from './constants';
import { EnrichmentWorker, registerEnrichmentWorkers } from './enrichmentWorker';
import { registerReconcileSchedule } from './reconcileSchedule';
import { errMessage, logEvent } from './log';

/**
 * Starts the queue side of this process. Two modes share all the code:
 *
 *   'api'    inside the web server. Does nothing unless ENRICHMENT_ENABLED=true (default: untouched database).
 *            Sender only when ENRICHMENT_WORKER_ENABLED=false; otherwise it also runs the worker.
 *   'worker' the dedicated `npm run worker` process. Runs when ENRICHMENT_WORKER_ENABLED=true, whatever
 *            ENRICHMENT_ENABLED says (that flag only stops NEW jobs from being sent, spec §11.8).
 */
export interface EnrichmentRuntime {
  role: BossRole;
  worker: EnrichmentWorker | null;
  /** Graceful stop: stop fetching, give running jobs SHUTDOWN_GRACE_MS, requeue what is left, close pg-boss. */
  stop(): Promise<void>;
}

export async function startEnrichmentRuntime(mode: 'api' | 'worker'): Promise<EnrichmentRuntime | null> {
  const flags = lookupConfig.flags;
  if (mode === 'api' && !flags.enrichmentEnabled) return null;
  if (mode === 'worker' && !flags.enrichmentWorkerEnabled) return null;

  // The pool's 'error' listener (idle connections dropped by Neon) lives in config/db.ts, for every process.
  const runWorker = flags.enrichmentWorkerEnabled;
  const role: BossRole = runWorker ? 'worker' : 'sender';

  if (runWorker) {
    // Fail loudly at start, BEFORE any job is taken: without the 30 topic tags every job would end failed / config_error
    // for good (no retry), so a worker that started anyway would drain the whole queue into failed rows.
    // Nothing is registered and pg-boss is not even started; the jobs stay queued until the tags are seeded.
    // Only a missing seed is a configuration problem; a database error propagates as it is.
    try {
      await loadTopicIds(pool);
    } catch (err) {
      if (err instanceof EnrichmentConfigError) logEvent('error', 'topics_not_seeded', { code: err.code, error: errMessage(err) });
      throw err;
    }
  }

  const boss = await getBoss(role);

  let worker: EnrichmentWorker | null = null;
  if (runWorker) {
    worker = new EnrichmentWorker({ db: pool, runEnrichment });
    await registerEnrichmentWorkers(boss, worker, { concurrency: lookupConfig.queue.workerConcurrency });
    // Every 10 minutes: rows stuck in queued / running with no pg-boss job behind them become failed / stale.
    await registerReconcileSchedule(boss, { pool: pool as any });
  }
  logEvent('info', 'enrichment_runtime_started', {
    mode,
    role,
    schema: lookupConfig.queue.schema,
    concurrency: runWorker ? lookupConfig.queue.workerConcurrency : 0,
    sending: flags.enrichmentEnabled,
  });

  return {
    role,
    worker,
    async stop() {
      try {
        await stopBoss(SHUTDOWN_GRACE_MS);
      } finally {
        // Anything still running when the grace period ended: pg-boss retries its job, so the row must say `queued`.
        await worker?.requeueInFlight();
      }
    },
  };
}
