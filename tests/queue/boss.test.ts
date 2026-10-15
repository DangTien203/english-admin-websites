import {
  buildBossOptions,
  ensureQueues,
  enrichQueueOptions,
  type QueueSettings,
} from '../../services/queue/boss';
import { ENRICH_DLQ, ENRICH_QUEUE, JOB_EXPIRE_FLOOR_SECONDS, computeJobExpireSeconds } from '../../services/queue/constants';

const settings: QueueSettings = {
  schema: 'pgboss',
  poolMax: 5,
  retryLimit: 3,
  retryDelaySeconds: 30,
  expireSeconds: 300,
};

beforeEach(() => {
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('computeJobExpireSeconds', () => {
  it('never goes below the 300 s floor', () => {
    expect(JOB_EXPIRE_FLOOR_SECONDS).toBe(300);
    expect(computeJobExpireSeconds(1000)).toBe(300);
    expect(computeJobExpireSeconds(60_000)).toBe(300); // default ANTHROPIC_TIMEOUT_MS_ENRICH
  });

  it('is always above the Anthropic timeout, even for the largest allowed one (600 s)', () => {
    for (const timeoutMs of [1000, 60_000, 120_000, 300_000, 600_000]) {
      expect(computeJobExpireSeconds(timeoutMs)).toBeGreaterThan(timeoutMs / 1000);
    }
    expect(computeJobExpireSeconds(600_000)).toBe(1260);
  });
});

describe('buildBossOptions', () => {
  it('uses PGBOSS_SCHEMA and PGBOSS_POOL_MAX', () => {
    const o = buildBossOptions({ ...settings, schema: 'pgboss_x', poolMax: 7 }, 'worker', { connectionString: 'postgres://u:p@h/db' });
    expect(o).toMatchObject({ schema: 'pgboss_x', max: 7, connectionString: 'postgres://u:p@h/db' });
  });

  it('only the worker role evaluates the cron schedule (the 10-minute reconcile pass); a sender never does', () => {
    expect(buildBossOptions(settings, 'worker', {}).schedule).toBe(true);
    expect(buildBossOptions(settings, 'sender', {}).schedule).toBe(false);
  });

  it('worker role keeps pg-boss maintenance on; sender role switches it off', () => {
    expect(buildBossOptions(settings, 'worker', {}).supervise).toBe(true);
    expect(buildBossOptions(settings, 'sender', {}).supervise).toBe(false);
  });

  it('names the instance and the connection so they can be told apart in pg_stat_activity', () => {
    expect(buildBossOptions(settings, 'sender', {})).toMatchObject({ application_name: 'wordygo-enrichment-sender', instanceName: 'enrichment-sender' });
    expect(buildBossOptions(settings, 'worker', {})).toMatchObject({ application_name: 'wordygo-enrichment-worker', instanceName: 'enrichment-worker' });
  });
});

describe('enrichQueueOptions (spec §7)', () => {
  it('exclusive policy, dead letter queue, retries with backoff, expiry', () => {
    expect(enrichQueueOptions(settings)).toEqual({
      policy: 'exclusive',
      deadLetter: ENRICH_DLQ,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 300,
    });
  });

  it('retryDelayMax only when asked for', () => {
    expect(enrichQueueOptions({ ...settings, retryDelayMaxSeconds: 2 })).toMatchObject({ retryDelayMax: 2 });
  });
});

describe('ensureQueues', () => {
  /** A pg-boss stand-in whose getQueue() returns what createQueue was last given. */
  function fakeBoss(existing?: Partial<Record<string, unknown>>) {
    const calls: string[] = [];
    const queues = new Map<string, any>();
    if (existing) queues.set(ENRICH_QUEUE, existing);
    const boss = {
      createQueue: jest.fn(async (name: string, options?: any) => {
        calls.push(`createQueue:${name}`);
        if (!queues.has(name)) queues.set(name, { name, policy: 'standard', ...options });
      }),
      getQueue: jest.fn(async (name: string) => queues.get(name) ?? null),
      updateQueue: jest.fn(async (name: string, options: any) => {
        calls.push(`updateQueue:${name}`);
        queues.set(name, { ...queues.get(name), ...options });
      }),
    };
    return { boss: boss as any, calls, queues };
  }

  it('creates the dead letter queue BEFORE the main queue', async () => {
    const { boss, calls } = fakeBoss();
    await ensureQueues(boss, settings);
    expect(calls.slice(0, 2)).toEqual([`createQueue:${ENRICH_DLQ}`, `createQueue:${ENRICH_QUEUE}`]);
  });

  it('can run twice in a row; the second run changes nothing', async () => {
    const { boss, calls } = fakeBoss();
    await ensureQueues(boss, settings);
    await ensureQueues(boss, settings);
    expect(boss.updateQueue).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.startsWith('createQueue'))).toHaveLength(4);
  });

  it('applies changed settings to an existing queue with updateQueue (createQueue would ignore them)', async () => {
    const { boss } = fakeBoss({ name: ENRICH_QUEUE, policy: 'exclusive', deadLetter: ENRICH_DLQ, retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 });
    await ensureQueues(boss, { ...settings, retryLimit: 5 });
    expect(boss.updateQueue).toHaveBeenCalledWith(ENRICH_QUEUE, expect.objectContaining({ retryLimit: 5, retryDelay: 30, retryBackoff: true, deadLetter: ENRICH_DLQ }));
    expect(boss.updateQueue.mock.calls[0][1]).not.toHaveProperty('policy'); // policy cannot be updated
  });

  it('refuses a pre-existing queue that is not exclusive (the one-job-per-word guarantee depends on it)', async () => {
    const { boss } = fakeBoss({ name: ENRICH_QUEUE, policy: 'standard' });
    await expect(ensureQueues(boss, settings)).rejects.toThrow(/policy "standard", expected "exclusive"/);
  });
});
