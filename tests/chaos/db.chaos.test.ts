/**
 * The database drops connections while a job is running (Neon restarts or suspends its compute; a failover). The job must
 * be retried and must not leave a row hanging in queued / running. Real PostgreSQL and pg-boss in a private schema; the
 * connections are really terminated with pg_terminate_backend. Run with: npm run test:chaos
 *
 * Only connections of THIS test are ever terminated: they carry an application_name with the run code, so a developer's own
 * worker or API on the same dev database is never touched.
 */
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import pool from '../../config/db';
import { attachPoolErrorHandlers } from '../../config/poolErrors';
import * as Jobs from '../../models/EnrichmentJob';
import { buildBossOptions, ensureQueues, type QueueSettings } from '../../services/queue/boss';
import { ENRICH_QUEUE } from '../../services/queue/constants';
import { EnrichmentWorker, registerEnrichmentWorkers } from '../../services/queue/enrichmentWorker';
import { PgBossEnrichmentEnqueuer } from '../../services/queue/pgBossEnqueuer';
import type { EnrichmentJob, EnrichmentOutcome } from '../../services/enrichment/pipeline';
import { cleanFixtures, dropSchema, queueSettings, RUN, rowsOf, silence, waitFor, word } from './chaosKit';

jest.setTimeout(240_000);
pool.on('error', () => undefined);

const APP_NAME_JOBS = `chaos-db-jobs-${RUN}`;
const APP_NAME_BOSS = `chaos-db-boss-${RUN}`;

/** Terminates the backends of this test (and only these). Returns how many were killed. */
async function killMine(names: string[]): Promise<number> {
  const { rows } = await pool.query(
    `SELECT pid, pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = ANY($1::text[])`,
    [names]
  );
  return rows.filter((r) => r.ok).length;
}

type Behavior = (job: EnrichmentJob, attempt: number) => Promise<EnrichmentOutcome>;

async function setup(tag: string, behavior: Behavior, over: Partial<QueueSettings> = {}) {
  const settings = queueSettings(tag, { retryLimit: 3, expireSeconds: 10, ...over });
  const boss = new PgBoss({ ...buildBossOptions(settings, 'worker'), application_name: APP_NAME_BOSS, superviseIntervalSeconds: 2, monitorIntervalSeconds: 2 });
  boss.on('error', () => undefined); // pg-boss reports the dropped connections here; the point is that the process survives
  await boss.start();
  await ensureQueues(boss, settings);

  // The worker's own pool, wired exactly like config/db.ts wires the application pool (tests/db/poolError.test.ts proves that one).
  // A different application_name lets this test terminate ITS connections without touching anything else on the dev database.
  const jobsPool = new Pool({ ...(pool as any).options, max: 4, application_name: APP_NAME_JOBS });
  attachPoolErrorHandlers(jobsPool);

  const attempts = new Map<string, number>();
  const worker = new EnrichmentWorker({
    db: jobsPool,
    runEnrichment: async (job) => {
      const n = (attempts.get(job.word) ?? 0) + 1;
      attempts.set(job.word, n);
      return behavior(job, n);
    },
  });
  await registerEnrichmentWorkers(boss, worker, { concurrency: 1, pollingIntervalSeconds: 0.5, dlqPollingIntervalSeconds: 5 });
  const enqueuer = new PgBossEnrichmentEnqueuer({ pool: pool as any, getBoss: async () => boss, maxJobsPerDay: 1000, usageProvider: `enrichment_chaos_${tag}_${RUN}` });
  return {
    settings, boss, jobsPool, attempts, enqueuer,
    done: (w: string, status = 'succeeded') => waitFor(async () => (await rowsOf(w)).find((r) => r.status === status), `${w} to be ${status}`, 120_000),
    async stop() {
      await boss.stop({ graceful: false, close: true });
      await jobsPool.end().catch(() => undefined);
      await dropSchema(settings.schema);
    },
  };
}

const ok: EnrichmentOutcome = { status: 'succeeded', model: 'fake', inputTokens: 1, outputTokens: 1 };

beforeAll(() => silence());
afterAll(async () => {
  await cleanFixtures();
  await pool.end();
});

describe('the connection of the write dies in the middle of the job (inside a transaction, like S6)', () => {
  it('the error is treated as a transient failure: the row goes back to queued, pg-boss retries, the second attempt succeeds', async () => {
    const h = await setup('dbtx', async (_job, attempt) => {
      if (attempt > 1) return ok;
      // a pooled client in the middle of a transaction, exactly the state persistEntry is in
      const client = await h.jobsPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT 1');
        expect(await killMine([APP_NAME_JOBS])).toBeGreaterThanOrEqual(1); // the server drops the connection
        await client.query('SELECT 2'); // → "terminating connection due to administrator command"
        return ok;
      } finally {
        client.release(true); // destroyed, not pooled
      }
    });
    try {
      const w = word('txdie');
      await h.enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null });

      const row = await h.done(w);
      expect(row.attempts).toBe(2);
      expect(h.attempts.get(w)).toBe(2);
      expect((await rowsOf(w)).filter((r) => r.status === 'running' || r.status === 'queued')).toEqual([]); // nothing hangs
      expect((await h.boss.findJobs(ENRICH_QUEUE, { key: w }))[0].state).toBe('completed');
    } finally {
      await h.stop();
    }
  });
});

describe('the ledger write itself fails (the connection was dropped just before it)', () => {
  it('the result is not lost and the row is not left running: retried, then succeeded', async () => {
    let fail = 1;
    const h = await setup('dbfinish', async () => ok);
    // The worker's database handle fails ONE terminal write, the way a dropped connection would.
    const realQuery = h.jobsPool.query.bind(h.jobsPool);
    (h.jobsPool as any).query = async (sql: string, params?: any[]) => {
      if (fail > 0 && /SET status = \$2, reason = \$3, entry_id = \$4/.test(sql)) {
        fail--;
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
      }
      return realQuery(sql, params);
    };
    try {
      const w = word('finishfails');
      await h.enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null });
      const row = await h.done(w);
      expect(row.attempts).toBe(2); // the first run's result could not be written, so the job ran again
      expect((await rowsOf(w)).filter((r) => r.status === 'running' || r.status === 'queued')).toEqual([]);
    } finally {
      await h.stop();
    }
  });
});

describe('every connection of the process is dropped while the job runs (a restart of the database)', () => {
  it('the worker and pg-boss reconnect, nothing crashes, and the job still reaches a terminal state', async () => {
    const h = await setup('dball', async (_job, attempt) => {
      if (attempt === 1) {
        expect(await killMine([APP_NAME_JOBS, APP_NAME_BOSS])).toBeGreaterThanOrEqual(1); // the app's pool AND pg-boss's own pool
        await new Promise((r) => setTimeout(r, 300));
      }
      return ok;
    });
    try {
      const w = word('allgone');
      await h.enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null });

      // Either the first run could still report its result over a fresh connection, or pg-boss missed the completion and
      // retried the job after its expiry: both are fine, losing the job or leaving the row hanging is not.
      const row = await h.done(w);
      expect(row.status).toBe('succeeded');
      await waitFor(async () => (await h.boss.findJobs(ENRICH_QUEUE, { key: w }))[0]?.state === 'completed', 'the pg-boss job to complete', 90_000);
      expect((await rowsOf(w)).filter((r) => r.status === 'running' || r.status === 'queued')).toEqual([]);
      expect(await Jobs.hasActiveForWord(pool as any, w)).toBe(false);
    } finally {
      await h.stop();
    }
  });
});
