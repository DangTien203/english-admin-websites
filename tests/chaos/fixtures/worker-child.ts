/**
 * A real worker PROCESS for the chaos tests (tests/chaos/process.chaos.test.ts): real pg-boss in the schema given by
 * CHAOS_SETTINGS, the real EnrichmentWorker, and a fake pipeline that "works" on a job for up to two minutes.
 *
 * Talks to its parent by stdout lines (READY, JOB_STARTED <word>) and by IPC: the message 'shutdown' runs the same steps as
 * SIGTERM does in worker.ts (stop pg-boss gracefully, put what is still running back to queued, close the pool). Windows has
 * no SIGTERM handlers for a child, so the parent asks over IPC; a hard kill is child.kill('SIGKILL').
 */
import 'dotenv/config';
import pool from '../../../config/db';
import { createStartedBoss, type QueueSettings } from '../../../services/queue/boss';
import { EnrichmentWorker, registerEnrichmentWorkers } from '../../../services/queue/enrichmentWorker';

const settings = JSON.parse(String(process.env.CHAOS_SETTINGS)) as QueueSettings;
const graceMs = Number(process.env.CHAOS_GRACE_MS ?? 2000);

async function main(): Promise<void> {
  const boss = await createStartedBoss(settings, 'worker');
  const worker = new EnrichmentWorker({
    db: pool,
    runEnrichment: async (job) => {
      process.stdout.write(`JOB_STARTED ${job.word}\n`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 120_000);
        job.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return { status: 'succeeded', model: 'child', inputTokens: 1, outputTokens: 1 };
    },
  });
  await registerEnrichmentWorkers(boss, worker, { concurrency: 1, pollingIntervalSeconds: 0.5, dlqPollingIntervalSeconds: 5 });

  process.on('message', async (message) => {
    if (message !== 'shutdown') return;
    try {
      await boss.stop({ graceful: true, close: true, timeout: graceMs });
    } finally {
      await worker.requeueInFlight();
      await pool.end().catch(() => undefined);
      process.exit(0);
    }
  });
  process.stdout.write('READY\n');
}

main().catch((err) => {
  process.stderr.write(`child failed: ${String(err?.message ?? err)}\n`);
  process.exit(1);
});
