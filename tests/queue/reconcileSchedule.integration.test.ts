/**
 * The 10-minute reconcile pass on a REAL PostgreSQL + pg-boss (its own schema pgboss_test_rs_<run>, dropped at the end).
 * A "tick" is sent by hand (boss.send), exactly the job pg-boss's cron creates; the real cron firing, which needs a minute of
 * wall-clock time, is exercised in tests/chaos/schedule.chaos.test.ts.
 *
 * Fixture rows are "qzq<run>…" and the pass is restricted to that prefix (wordPrefix): the pass of a test schema must never
 * look at the real rows of the dev database, whose jobs live in the real pgboss schema.
 */
import type { PgBoss } from 'pg-boss';
import pool from '../../config/db';
import { createStartedBoss, type QueueSettings } from '../../services/queue/boss';
import { ENRICH_QUEUE, RECONCILE_QUEUE } from '../../services/queue/constants';
import { didRun, registerReconcileSchedule, type LockedReconcileResult } from '../../services/queue/reconcileSchedule';

jest.setTimeout(90_000);

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const word = (tag: string) => `qzq${RUN}${tag}`;
const SETTINGS: QueueSettings = { schema: `pgboss_test_rs_${RUN}`, poolMax: 4, retryLimit: 1, retryDelaySeconds: 1, retryDelayMaxSeconds: 2, expireSeconds: 60 };

pool.on('error', () => undefined);

async function waitFor<T>(fn: () => Promise<T | false | null | undefined> | T | false | null | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const status = async (w: string) => (await pool.query(`SELECT status, reason FROM word_enrichment_jobs WHERE word = $1`, [w])).rows[0];
async function insertBackdated(w: string): Promise<string> {
  // an explicit updated_at is kept on INSERT (the trigger only fires on UPDATE)
  const { rows } = await pool.query(
    `INSERT INTO word_enrichment_jobs (word, status, created_at, updated_at) VALUES ($1, 'queued', NOW() - interval '2 hours', NOW() - interval '2 hours') RETURNING id`,
    [w]
  );
  return rows[0].id;
}

let boss: PgBoss;
const passes: LockedReconcileResult[] = [];

beforeAll(async () => {
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  boss = await createStartedBoss(SETTINGS, 'worker');
  await registerReconcileSchedule(boss, { pool: pool as any, wordPrefix: `qzq${RUN}`, pollingIntervalSeconds: 0.5, onPass: (r) => passes.push(r) });
});

afterAll(async () => {
  await boss?.stop({ graceful: false, close: true });
  await pool.query(`DELETE FROM word_enrichment_jobs WHERE word LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DROP SCHEMA IF EXISTS ${SETTINGS.schema} CASCADE`);
  await pool.end();
});

describe('the schedule', () => {
  it('is stored in pg-boss as ONE schedule of the reconcile queue, every 10 minutes', async () => {
    const schedules = await boss.getSchedules(RECONCILE_QUEUE);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ name: RECONCILE_QUEUE, cron: '*/10 * * * *' });
    expect(await boss.getQueue(RECONCILE_QUEUE)).toMatchObject({ policy: 'exclusive', retryLimit: 0 });
  });

  it('registering again (every process start-up does) does not add a second schedule', async () => {
    await registerReconcileSchedule(boss, { pool: pool as any, wordPrefix: `qzq${RUN}`, pollingIntervalSeconds: 0.5, onPass: (r) => passes.push(r) });
    expect(await boss.getSchedules(RECONCILE_QUEUE)).toHaveLength(1);
  });

  it('the cron is evaluated by this instance (worker role) and by no sender', async () => {
    const { rows } = await pool.query(`SELECT schedule, supervise FROM ${SETTINGS.schema}.instance WHERE name = 'enrichment-worker' ORDER BY started_on DESC LIMIT 1`);
    expect(rows[0]).toMatchObject({ schedule: true, supervise: true });
  });
});

describe('a tick', () => {
  it('marks a stuck row failed / stale and leaves a row whose pg-boss job is still alive', async () => {
    const stuck = word('stuck');
    const alive = word('alive');
    await insertBackdated(stuck); // no pg-boss job at all
    const aliveId = await insertBackdated(alive);
    // a waiting pg-boss job for the second one (startAfter keeps it from being picked up: no worker on this queue here)
    const sent = await boss.send(ENRICH_QUEUE, { word: alive, requestedBy: null, ebookId: null, jobRowId: aliveId }, { singletonKey: alive, startAfter: 3600 });
    expect(sent).not.toBeNull();

    const before = passes.length;
    expect(await boss.send(RECONCILE_QUEUE)).not.toBeNull(); // what the cron does at a tick
    const pass = await waitFor(() => passes[before], 'a reconcile pass');

    expect(didRun(pass)).toBe(true);
    expect(didRun(pass) && pass.result).toMatchObject({ checked: 2, markedStale: 1, stillLive: 1 });
    expect(await status(stuck)).toEqual({ status: 'failed', reason: 'stale' });
    expect(await status(alive)).toEqual({ status: 'queued', reason: null });
  });

  it('while another pass holds the advisory lock this one does nothing; once it lets go, the next tick works', async () => {
    const w = word('locked');
    await insertBackdated(w);

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('enrich:reconcile', 0))`); // another pass, somewhere

      const before = passes.length;
      await boss.send(RECONCILE_QUEUE);
      const skipped = await waitFor(() => passes[before], 'the skipped pass');
      expect(skipped).toEqual({ ran: false, reason: 'lock_held' });
      expect(await status(w)).toEqual({ status: 'queued', reason: null });
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }

    const before = passes.length;
    await boss.send(RECONCILE_QUEUE);
    const pass = await waitFor(() => passes[before], 'the next pass');
    expect(didRun(pass)).toBe(true);
    expect(await status(w)).toEqual({ status: 'failed', reason: 'stale' });
  });

  it('a pass running right now blocks the next tick at the queue (exclusive policy): sending while one waits returns null', async () => {
    // Park a tick that nobody can take: a second queue with the same options and NO worker.
    await boss.createQueue('dictionary.enrich_word.reconcile.parked', { policy: 'exclusive', retryLimit: 0 });
    expect(await boss.send('dictionary.enrich_word.reconcile.parked')).not.toBeNull();
    expect(await boss.send('dictionary.enrich_word.reconcile.parked')).toBeNull();
  });
});

describe('two processes on the same database (two pg-boss instances, same schema)', () => {
  it('one tick is handled by exactly one of them', async () => {
    const second = await createStartedBoss(SETTINGS, 'worker');
    const secondPasses: LockedReconcileResult[] = [];
    try {
      await registerReconcileSchedule(second, { pool: pool as any, wordPrefix: `qzq${RUN}`, pollingIntervalSeconds: 0.5, onPass: (r) => secondPasses.push(r) });

      const firstBefore = passes.length;
      for (let i = 0; i < 4; i++) {
        await boss.send(RECONCILE_QUEUE);
        await waitFor(() => passes.length + secondPasses.length > firstBefore + i, `tick ${i + 1} handled`);
      }
      await new Promise((r) => setTimeout(r, 2500)); // nothing else may show up afterwards
      expect(passes.length - firstBefore + secondPasses.length).toBe(4); // 4 ticks, 4 passes in total: never two for one tick
    } finally {
      await second.stop({ graceful: false, close: true });
    }
  });
});
