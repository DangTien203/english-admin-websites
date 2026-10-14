import 'dotenv/config';
// Validates the lookup / enrichment env vars at boot, like app.ts does.
import { lookupConfig } from './config/lookup';
import pool from './config/db';
import { startEnrichmentRuntime } from './services/queue';
import { logEvent, errMessage } from './services/queue/log';
import { installShutdownHandlers } from './services/queue/shutdown';

/**
 * Dedicated enrichment worker process (`npm run worker`; production: `node dist/worker.js`).
 * Same code as the worker that can run inside the API process (services/queue/runtime.ts).
 *
 * SIGTERM / SIGINT: stop fetching jobs, give running ones up to 30 s, put what is still running back to
 * `queued`, close the pools, exit.
 */
async function main(): Promise<void> {
  if (!lookupConfig.flags.enrichmentWorkerEnabled) {
    console.log('ENRICHMENT_WORKER_ENABLED=false: the enrichment worker is switched off, nothing to do.');
    await pool.end().catch(() => undefined);
    return;
  }

  const runtime = await startEnrichmentRuntime('worker');
  if (!runtime) {
    console.log('Enrichment worker not started.');
    await pool.end().catch(() => undefined);
    return;
  }

  installShutdownHandlers([
    { name: 'stop_queue', run: () => runtime.stop() },
    { name: 'close_pool', run: () => pool.end() },
  ]);

  console.log(
    `Enrichment worker running (schema "${lookupConfig.queue.schema}", concurrency ${lookupConfig.queue.workerConcurrency}). Ctrl+C / SIGTERM to stop.`
  );
}

main().catch(async (err) => {
  logEvent('error', 'worker_start_failed', { error: errMessage(err) });
  await pool.end().catch(() => undefined);
  process.exit(1);
});
