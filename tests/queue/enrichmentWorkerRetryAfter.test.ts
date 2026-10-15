/**
 * Spec §11.4: "Anthropic 429 with retry-after: wait, then retry through pg-boss." The worker holds the handler for the time the
 * provider asked for (capped), THEN puts the row back to queued and rethrows so pg-boss schedules the retry.
 */
import * as Jobs from '../../models/EnrichmentJob';
import { EnrichmentWorker, MAX_RETRY_AFTER_WAIT_MS, retryAfterWaitMs, type WorkerJob } from '../../services/queue/enrichmentWorker';
import { BudgetExceeded, UpstreamUnavailable } from '../../services/upstream/errors';

jest.mock('../../models/EnrichmentJob');
const M = Jobs as jest.Mocked<typeof Jobs>;
const db = { query: jest.fn() };
const ROW = 'row-1';

const row = (over: Partial<Jobs.EnrichmentJobRow> = {}): Jobs.EnrichmentJobRow => ({
  id: ROW, word: 'ubiquitous', status: 'queued', reason: null, attempts: 0, entry_id: null, requested_by: null,
  model: null, input_tokens: null, output_tokens: null, created_at: new Date(), updated_at: new Date(), finished_at: null, ...over,
});
const job = (over: Partial<WorkerJob> = {}): WorkerJob => ({
  id: 'pg-job-1', data: { word: 'ubiquitous', requestedBy: null, ebookId: null, jobRowId: ROW }, retryCount: 0, retryLimit: 3, signal: new AbortController().signal, ...over,
});
const rateLimited = (retryAfterMs?: number) => new UpstreamUnavailable('anthropic', 'rate_limited', { status: 429, retryAfterMs });

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  M.findById.mockResolvedValue(row());
  M.markRunning.mockResolvedValue(row({ status: 'running', attempts: 1 }));
  M.markQueued.mockResolvedValue(undefined);
  M.failIfActive.mockResolvedValue(true);
  M.finish.mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('retryAfterWaitMs', () => {
  it('is the Retry-After of a 429, capped; nothing for anything else', () => {
    expect(retryAfterWaitMs(rateLimited(2000))).toBe(2000);
    expect(retryAfterWaitMs(rateLimited(3_600_000))).toBe(MAX_RETRY_AFTER_WAIT_MS);
    expect(retryAfterWaitMs(rateLimited(undefined))).toBe(0);
    expect(retryAfterWaitMs(rateLimited(0))).toBe(0);
    expect(retryAfterWaitMs(new UpstreamUnavailable('anthropic', 'http_5xx', { status: 503, retryAfterMs: 5000 }))).toBe(0);
    expect(retryAfterWaitMs(new BudgetExceeded('anthropic', 'spend_limit', { retryAfterMs: 5000 }))).toBe(0);
    expect(retryAfterWaitMs(new Error('x'))).toBe(0);
  });
});

describe('the worker honours Retry-After before handing the job back', () => {
  it('waits for the time the provider asked for, THEN requeues the row and rethrows', async () => {
    const order: string[] = [];
    const sleep = jest.fn(async (ms: number, _signal?: AbortSignal) => void order.push(`sleep:${ms}`));
    M.markQueued.mockImplementation(async () => void order.push('markQueued'));
    const err = rateLimited(7000);
    const worker = new EnrichmentWorker({ db, sleep, runEnrichment: async () => { throw err; } });

    await expect(worker.handle([job({ retryCount: 0, retryLimit: 3 })])).rejects.toBe(err);
    expect(order).toEqual(['sleep:7000', 'markQueued']);
    expect(M.markQueued).toHaveBeenCalledWith(db, ROW, 'upstream_error');
    expect(sleep.mock.calls[0][1]).toBeInstanceOf(AbortSignal); // the wait ends early when the process is shutting down
  });

  it('a 429 without Retry-After does not wait', async () => {
    const sleep = jest.fn(async () => undefined);
    const worker = new EnrichmentWorker({ db, sleep, runEnrichment: async () => { throw rateLimited(undefined); } });
    await expect(worker.handle([job()])).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(sleep).not.toHaveBeenCalled();
    expect(M.markQueued).toHaveBeenCalled();
  });

  it('the LAST attempt does not wait: it fails the row at once and goes to the dead letter queue', async () => {
    const sleep = jest.fn(async () => undefined);
    const worker = new EnrichmentWorker({ db, sleep, runEnrichment: async () => { throw rateLimited(7000); } });
    await expect(worker.handle([job({ retryCount: 3, retryLimit: 3 })])).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(sleep).not.toHaveBeenCalled();
    expect(M.failIfActive).toHaveBeenCalledWith(db, ROW, 'upstream_error');
  });

  it('a spend limit is never waited for and never retried', async () => {
    const sleep = jest.fn(async () => undefined);
    const worker = new EnrichmentWorker({ db, sleep, runEnrichment: async () => { throw new BudgetExceeded('anthropic', 'spend_limit', { retryAfterMs: 5000 }); } });
    await expect(worker.handle([job()])).resolves.toBeUndefined();
    expect(sleep).not.toHaveBeenCalled();
    expect(M.finish).toHaveBeenCalledWith(db, ROW, { status: 'skipped', reason: 'budget' });
  });

  it('the real wait is cut short by the abort signal (shutdown)', async () => {
    const ac = new AbortController();
    const worker = new EnrichmentWorker({ db, runEnrichment: async () => { throw rateLimited(50_000); } });
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 100);
    // the signal is aborted when the pipeline returns/throws? it is not yet here; the wait itself must end on abort
    const p = worker.handle([job({ signal: ac.signal })]);
    await expect(p).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
