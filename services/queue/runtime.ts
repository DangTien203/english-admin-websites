import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { runEnrichment } from '../enrichment/pipeline';
import { getBoss, stopBoss, type BossRole } from './boss';
import { SHUTDOWN_GRACE_MS } from './constants';
import { EnrichmentWorker, registerEnrichmentWorkers } from './enrichmentWorker';
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

let poolErrorLoggerAttached = false;

/**
 * A pg.Pool emits 'error' when an IDLE connection is dropped by the server (Neon does this when a compute
 * suspends). Without a listener that event is an uncaught exception and kills a long-running process.
 */
function logPoolErrors(): void {
  if (poolErrorLoggerAttached) return;
  poolErrorLoggerAttached = true;
  pool.on('error', (err) => logEvent('error', 'pg_pool_error', { error: errMessage(err) }));
}

export async function startEnrichmentRuntime(mode: 'api' | 'worker'): Promise<EnrichmentRuntime | null> {
  const flags = lookupConfig.flags;
  if (mode === 'api' && !flags.enrichmentEnabled) return null;
  if (mode === 'worker' && !flags.enrichmentWorkerEnabled) return null;

  logPoolErrors();
  const runWorker = flags.enrichmentWorkerEnabled;
  const role: BossRole = runWorker ? 'worker' : 'sender';
  const boss = await getBoss(role);

  let worker: EnrichmentWorker | null = null;
  if (runWorker) {
    worker = new EnrichmentWorker({ db: pool, runEnrichment });
    await registerEnrichmentWorkers(boss, worker, { concurrency: lookupConfig.queue.workerConcurrency });
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
