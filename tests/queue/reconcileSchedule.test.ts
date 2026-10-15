import { RECONCILE_CRON, RECONCILE_LOCK_KEY, didRun, registerReconcileSchedule, runLockedReconcile, type ReconcilePool } from '../../services/queue/reconcileSchedule';
import { RECONCILE_QUEUE } from '../../services/queue/constants';

/** A pool whose clients record their statements and answer the ones runLockedReconcile issues. */
function fakePool(opts: { lock?: boolean; stale?: any[]; rollbackFails?: boolean; failOn?: string } = {}) {
  const log: string[] = [];
  const released: Array<unknown> = [];
  const client = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      const s = sql.trim();
      log.push(s.split('\n')[0].slice(0, 60));
      if (s === 'BEGIN' || s === 'COMMIT') return { rows: [] };
      if (s === 'ROLLBACK') {
        if (opts.rollbackFails) throw new Error('rollback failed');
        return { rows: [] };
      }
      if (s.includes('pg_try_advisory_xact_lock')) {
        expect(params).toEqual([RECONCILE_LOCK_KEY]);
        return { rows: [{ locked: opts.lock ?? true }] };
      }
      if (s.includes('FROM word_enrichment_jobs')) {
        if (opts.failOn === 'scan') throw new Error('scan failed');
        return { rows: opts.stale ?? [] };
      }
      if (s.includes('UPDATE word_enrichment_jobs')) return { rows: [{ id: params?.[0] }] };
      throw new Error('unexpected SQL ' + s.slice(0, 60));
    }),
    release: jest.fn((e?: unknown) => void released.push(e)),
  };
  const pool = { query: client.query, connect: jest.fn(async () => client) } as unknown as ReconcilePool;
  return { pool, client, log, released };
}

describe('constants', () => {
  it('runs every 10 minutes on its own queue', () => {
    expect(RECONCILE_CRON).toBe('*/10 * * * *');
    expect(RECONCILE_QUEUE).toBe('dictionary.enrich_word.reconcile');
  });
});

describe('runLockedReconcile', () => {
  it('takes the advisory lock inside a transaction, reconciles with that transaction, commits and releases the connection', async () => {
    const stale = [{ id: 'r1', word: 'alpha', status: 'queued' }];
    const f = fakePool({ stale });
    const boss = { findJobs: jest.fn(async () => []) }; // pg-boss has no live job for the row

    const out = await runLockedReconcile({ pool: f.pool, boss });
    expect(didRun(out) && out.result).toMatchObject({ checked: 1, markedStale: 1, stillLive: 0 });
    expect(f.log[0]).toBe('BEGIN');
    expect(f.log[1]).toContain('pg_try_advisory_xact_lock');
    expect(f.log[f.log.length - 1]).toBe('COMMIT');
    expect(f.log).not.toContain('ROLLBACK');
    expect(f.released).toEqual([undefined]); // returned to the pool normally
  });

  it('does nothing when another pass holds the lock', async () => {
    const f = fakePool({ lock: false, stale: [{ id: 'r1', word: 'alpha', status: 'queued' }] });
    const boss = { findJobs: jest.fn(async () => []) };
    const out = await runLockedReconcile({ pool: f.pool, boss });
    expect(out).toEqual({ ran: false, reason: 'lock_held' });
    expect(boss.findJobs).not.toHaveBeenCalled();
    expect(f.log).toEqual(['BEGIN', expect.stringContaining('pg_try_advisory_xact_lock'), 'ROLLBACK']);
  });

  it('an error rolls back, releases the connection and is rethrown', async () => {
    const f = fakePool({ failOn: 'scan' });
    await expect(runLockedReconcile({ pool: f.pool, boss: { findJobs: async () => [] } })).rejects.toThrow('scan failed');
    expect(f.log).toContain('ROLLBACK');
    expect(f.released).toEqual([undefined]);
  });

  it('a connection whose ROLLBACK failed is destroyed, not pooled', async () => {
    const f = fakePool({ failOn: 'scan', rollbackFails: true });
    await expect(runLockedReconcile({ pool: f.pool, boss: { findJobs: async () => [] } })).rejects.toThrow('scan failed');
    expect(f.released).toEqual([true]);
  });

  it('passes the word prefix and the age threshold on (tests and maintenance on one word family)', async () => {
    const f = fakePool();
    await runLockedReconcile({ pool: f.pool, boss: { findJobs: async () => [] }, wordPrefix: 'qzqabc', olderThanMinutes: 5 });
    const scan = f.client.query.mock.calls.find(([sql]) => String(sql).includes('FROM word_enrichment_jobs'))!;
    expect(scan[1]).toEqual([5, 'qzqabc']);
  });
});

describe('registerReconcileSchedule', () => {
  function fakeBoss() {
    const calls: Array<[string, ...unknown[]]> = [];
    let handler: (jobs: unknown[]) => Promise<void> = async () => undefined;
    const boss = {
      createQueue: jest.fn(async (...a: unknown[]) => void calls.push(['createQueue', ...a])),
      schedule: jest.fn(async (...a: unknown[]) => void calls.push(['schedule', ...a])),
      work: jest.fn(async (name: string, options: unknown, h: (jobs: unknown[]) => Promise<void>) => {
        calls.push(['work', name, options]);
        handler = h;
        return 'work-1';
      }),
      findJobs: jest.fn(async () => []),
    };
    return { boss: boss as any, calls, tick: () => handler([{}]) };
  }

  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('creates the exclusive queue BEFORE scheduling, schedules every 10 minutes, then starts ONE handler at a time', async () => {
    const b = fakeBoss();
    const out = await registerReconcileSchedule(b.boss, { pool: fakePool().pool });
    expect(out).toEqual({ workId: 'work-1', cron: '*/10 * * * *', queue: RECONCILE_QUEUE });
    expect(b.calls.map((c) => c[0])).toEqual(['createQueue', 'schedule', 'work']);
    expect(b.calls[0]).toEqual(['createQueue', RECONCILE_QUEUE, expect.objectContaining({ policy: 'exclusive', retryLimit: 0 })]);
    expect(b.calls[1]).toEqual(['schedule', RECONCILE_QUEUE, '*/10 * * * *', null]);
    expect(b.calls[2][2]).toMatchObject({ localConcurrency: 1, batchSize: 1 });
  });

  it('each tick runs one locked pass and tells the observer; a lock held elsewhere is a quiet skip', async () => {
    const seen: unknown[] = [];
    const b = fakeBoss();
    await registerReconcileSchedule(b.boss, { pool: fakePool().pool, onPass: (r) => seen.push(r) });
    await b.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ran: true });

    const b2 = fakeBoss();
    await registerReconcileSchedule(b2.boss, { pool: fakePool({ lock: false }).pool, onPass: (r) => seen.push(r) });
    await b2.tick();
    expect(seen[1]).toEqual({ ran: false, reason: 'lock_held' });
  });

  it('a failing pass is logged and rethrown (pg-boss fails the job; the next tick is the retry); a throwing observer changes nothing', async () => {
    const b = fakeBoss();
    await registerReconcileSchedule(b.boss, { pool: fakePool({ failOn: 'scan', stale: [] }).pool });
    await expect(b.tick()).rejects.toThrow('scan failed');
    expect((console.error as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]).evt)).toContain('enrich_reconcile_failed');

    const b2 = fakeBoss();
    await registerReconcileSchedule(b2.boss, { pool: fakePool().pool, onPass: () => { throw new Error('observer'); } });
    await expect(b2.tick()).resolves.toBeUndefined();
  });

  it('accepts another cron expression (tests use every minute)', async () => {
    const b = fakeBoss();
    await registerReconcileSchedule(b.boss, { pool: fakePool().pool, cron: '* * * * *', queueName: 'q.test' });
    expect(b.boss.schedule).toHaveBeenCalledWith('q.test', '* * * * *', null);
  });
});
