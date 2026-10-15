/**
 * The real pg-boss cron, not a hand-sent tick: two instances (two "servers") evaluate the same schedule on the same database,
 * and every minute exactly ONE reconcile pass runs somewhere. Takes about two minutes of wall-clock time because a cron
 * expression cannot be finer than a minute. Run with: npm run test:chaos
 */
import { PgBoss } from 'pg-boss';
import pool from '../../config/db';
import { buildBossOptions, ensureQueues } from '../../services/queue/boss';
import { registerReconcileSchedule, type LockedReconcileResult } from '../../services/queue/reconcileSchedule';
import { RECONCILE_QUEUE } from '../../services/queue/constants';
import { cleanFixtures, dropSchema, queueSettings, RUN, silence, sleep, waitFor } from './chaosKit';

jest.setTimeout(300_000);
pool.on('error', () => undefined);

const settings = queueSettings('cron');
const passes: Array<{ at: number; by: 'A' | 'B'; result: LockedReconcileResult }> = [];
let bossA: PgBoss;
let bossB: PgBoss;

async function instance(name: 'A' | 'B'): Promise<PgBoss> {
  // cron checks every 2 s instead of every 30 s so the first tick is not late
  const boss = new PgBoss({ ...buildBossOptions(settings, 'worker'), instanceName: `chaos-cron-${name}`, cronMonitorIntervalSeconds: 2, cronWorkerIntervalSeconds: 1 });
  boss.on('error', () => undefined);
  await boss.start();
  await ensureQueues(boss, settings);
  await registerReconcileSchedule(boss, {
    pool: pool as any,
    cron: '* * * * *',
    wordPrefix: `qzq${RUN}`, // never look at real rows: this schema holds none of their jobs
    pollingIntervalSeconds: 0.5,
    onPass: (result) => passes.push({ at: Date.now(), by: name, result }),
  });
  return boss;
}

beforeAll(async () => {
  silence();
  bossA = await instance('A');
  bossB = await instance('B');
});
afterAll(async () => {
  await bossA?.stop({ graceful: false, close: true });
  await bossB?.stop({ graceful: false, close: true });
  await dropSchema(settings.schema);
  await cleanFixtures();
  await pool.end();
});

describe('the cron schedule on two instances', () => {
  it('fires on its own, and each minute has one pass in total — never one per instance', async () => {
    expect(await bossA.getSchedules(RECONCILE_QUEUE)).toHaveLength(1);
    expect(await bossB.getSchedules(RECONCILE_QUEUE)).toHaveLength(1); // the same row

    await waitFor(() => passes.length >= 1, 'the first cron-driven pass', 150_000, 500);
    // wait for at least one more minute boundary, so there are two minutes to compare
    const firstMinute = Math.floor(passes[0].at / 60_000);
    await waitFor(() => passes.some((p) => Math.floor(p.at / 60_000) > firstMinute), 'a pass in the next minute', 150_000, 500);
    await sleep(3000); // late duplicates would show up now

    const perMinute = new Map<number, number>();
    for (const p of passes) perMinute.set(Math.floor(p.at / 60_000), (perMinute.get(Math.floor(p.at / 60_000)) ?? 0) + 1);
    expect([...perMinute.values()].every((n) => n === 1)).toBe(true); // one pass per minute, in total, across both instances
    expect(passes.every((p) => 'ran' in p.result)).toBe(true);
  });
});
