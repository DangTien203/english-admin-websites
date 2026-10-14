import * as Jobs from '../../models/EnrichmentJob';
import { reconcileStaleJobs } from '../../services/queue/reconcile';
import { runShutdown } from '../../services/queue/shutdown';
import { ENRICH_QUEUE } from '../../services/queue/constants';

jest.mock('../../models/EnrichmentJob');
const M = Jobs as jest.Mocked<typeof Jobs>;
const db = { query: jest.fn() };

function row(id: string, status: 'queued' | 'running' = 'queued'): Jobs.EnrichmentJobRow {
  return { id, word: `w-${id}`, status, reason: null, attempts: 1, entry_id: null, requested_by: null, model: null, input_tokens: null, output_tokens: null, created_at: new Date(), updated_at: new Date(), finished_at: null };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('reconcileStaleJobs', () => {
  it('looks for rows older than 30 minutes by default', async () => {
    M.findActiveOlderThan.mockResolvedValue([]);
    await reconcileStaleJobs({ db, boss: { findJobs: jest.fn() } });
    expect(M.findActiveOlderThan).toHaveBeenCalledWith(db, 30, undefined);
  });

  it('can be limited to a word prefix and to another age', async () => {
    M.findActiveOlderThan.mockResolvedValue([]);
    await reconcileStaleJobs({ db, boss: { findJobs: jest.fn() }, olderThanMinutes: 0, wordPrefix: 'qzq' });
    expect(M.findActiveOlderThan).toHaveBeenCalledWith(db, 0, 'qzq');
  });

  it('fails rows with no live pg-boss job as failed / stale, and leaves rows whose job is still live', async () => {
    M.findActiveOlderThan.mockResolvedValue([row('gone'), row('waiting'), row('running', 'running'), row('only-done')]);
    M.failIfActive.mockResolvedValue(true);
    const states: Record<string, string[]> = {
      gone: [],
      waiting: ['created'],
      running: ['active'],
      'only-done': ['completed', 'failed', 'cancelled'],
    };
    const findJobs = jest.fn(async (_name: string, opts: { data: any }) => states[opts.data.jobRowId].map((state) => ({ state })));

    const result = await reconcileStaleJobs({ db, boss: { findJobs } });

    expect(result).toEqual({ checked: 4, markedStale: 2, stillLive: 2 });
    expect(M.failIfActive).toHaveBeenCalledTimes(2);
    expect(M.failIfActive).toHaveBeenCalledWith(db, 'gone', 'stale');
    expect(M.failIfActive).toHaveBeenCalledWith(db, 'only-done', 'stale');
    expect(findJobs).toHaveBeenCalledWith(ENRICH_QUEUE, { data: { jobRowId: 'gone' } });
  });

  it('a retry-state job counts as live', async () => {
    M.findActiveOlderThan.mockResolvedValue([row('retrying')]);
    const result = await reconcileStaleJobs({ db, boss: { findJobs: async () => [{ state: 'retry' }] } });
    expect(result.stillLive).toBe(1);
    expect(M.failIfActive).not.toHaveBeenCalled();
  });

  it('does not count a row that another process closed in the meantime', async () => {
    M.findActiveOlderThan.mockResolvedValue([row('raced')]);
    M.failIfActive.mockResolvedValue(false);
    const result = await reconcileStaleJobs({ db, boss: { findJobs: async () => [] } });
    expect(result.markedStale).toBe(0);
  });
});

describe('runShutdown', () => {
  it('runs the steps in order and returns 0', async () => {
    const order: string[] = [];
    const code = await runShutdown([
      { name: 'a', run: async () => void order.push('a') },
      { name: 'b', run: async () => void order.push('b') },
    ]);
    expect(order).toEqual(['a', 'b']);
    expect(code).toBe(0);
  });

  it('keeps going after a failing step (the pools must still be closed) and returns 1', async () => {
    const order: string[] = [];
    const code = await runShutdown([
      { name: 'queue', run: async () => { throw new Error('stop failed'); } },
      { name: 'pool', run: async () => void order.push('pool closed') },
    ]);
    expect(order).toEqual(['pool closed']);
    expect(code).toBe(1);
  });
});
