import * as Jobs from '../../models/EnrichmentJob';
import { EnrichmentWorker, type WorkerJob } from '../../services/queue/enrichmentWorker';
import type { EnrichmentJob, EnrichmentOutcome } from '../../services/enrichment/pipeline';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';
import { counterSnapshot, resetCounters } from '../../services/queue/log';

jest.mock('../../models/EnrichmentJob');
const M = Jobs as jest.Mocked<typeof Jobs>;

const db = { query: jest.fn() };
const ROW = 'row-1';

function row(over: Partial<Jobs.EnrichmentJobRow> = {}): Jobs.EnrichmentJobRow {
  return {
    id: ROW, word: 'ubiquitous', status: 'queued', reason: null, attempts: 0, entry_id: null, requested_by: 'user-1',
    model: null, input_tokens: null, output_tokens: null, created_at: new Date(), updated_at: new Date(), finished_at: null,
    ...over,
  };
}

function job(over: Partial<WorkerJob> = {}): WorkerJob {
  return {
    id: 'pg-job-1',
    data: { word: 'ubiquitous', requestedBy: 'user-1', ebookId: 'ebook-1', jobRowId: ROW },
    retryCount: 0,
    retryLimit: 3,
    signal: new AbortController().signal,
    ...over,
  };
}

function setup(run: (j: EnrichmentJob) => Promise<EnrichmentOutcome>) {
  const runEnrichment = jest.fn(run);
  const worker = new EnrichmentWorker({ db, runEnrichment });
  return { worker, runEnrichment };
}

beforeEach(() => {
  jest.resetAllMocks();
  resetCounters();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  // default: the row exists and markRunning moves it to running with attempts + 1
  M.findById.mockResolvedValue(row());
  M.markRunning.mockResolvedValue(row({ status: 'running', attempts: 1 }));
  M.finish.mockResolvedValue(undefined);
  M.markQueued.mockResolvedValue(undefined);
  M.failIfActive.mockResolvedValue(true);
  M.requeueRunning.mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

describe('lifecycle: row → running → result', () => {
  it('marks the row running (attempts + 1) BEFORE calling the pipeline, then records the outcome', async () => {
    const order: string[] = [];
    M.markRunning.mockImplementation(async () => (order.push('markRunning'), row({ status: 'running', attempts: 1 })));
    M.finish.mockImplementation(async () => void order.push('finish'));
    const { worker, runEnrichment } = setup(async () => (order.push('pipeline'), { status: 'succeeded', entryId: 'entry-1', model: 'haiku', inputTokens: 100, outputTokens: 50 }));

    await worker.handle([job()]);

    expect(order).toEqual(['markRunning', 'pipeline', 'finish']);
    expect(runEnrichment).toHaveBeenCalledWith({
      word: 'ubiquitous', requestedBy: 'user-1', ebookId: 'ebook-1', jobRowId: ROW, attempt: 1, signal: expect.any(AbortSignal),
    });
    expect(M.finish).toHaveBeenCalledWith(db, ROW, {
      status: 'succeeded', reason: null, entryId: 'entry-1', model: 'haiku', inputTokens: 100, outputTokens: 50,
    });
    expect(counterSnapshot()['job.succeeded']).toBe(1);
  });

  it.each([
    ['succeeded', 'form_linked'],
    ['rejected', 'proper_noun'],
    ['skipped', 'pipeline_not_ready'],
    ['failed', 'invalid_output'],
  ] as const)('a returned %s outcome (%s) is recorded and the job completes: no retry', async (status, reason) => {
    const { worker } = setup(async () => ({ status, reason }));
    await expect(worker.handle([job()])).resolves.toBeUndefined(); // resolving = pg-boss completes the job
    expect(M.finish).toHaveBeenCalledWith(db, ROW, expect.objectContaining({ status, reason }));
    expect(M.markQueued).not.toHaveBeenCalled();
    expect(M.failIfActive).not.toHaveBeenCalled();
  });

  it('the P5 placeholder pipeline ends as skipped / pipeline_not_ready', async () => {
    const { createPipeline } = await import('../../services/enrichment/pipeline');
    const worker = new EnrichmentWorker({ db, runEnrichment: createPipeline({ ensureTopics: async () => undefined }) });
    await worker.handle([job()]);
    expect(M.finish).toHaveBeenCalledWith(db, ROW, expect.objectContaining({ status: 'skipped', reason: 'pipeline_not_ready' }));
  });

  it('only the job data fields reach the pipeline (no personal data)', async () => {
    const { worker, runEnrichment } = setup(async () => ({ status: 'skipped' }));
    await worker.handle([job()]);
    expect(Object.keys(runEnrichment.mock.calls[0][0]).sort()).toEqual(['attempt', 'ebookId', 'jobRowId', 'requestedBy', 'signal', 'word']);
  });
});

describe('a) the row is missing or already closed', () => {
  it('re-creates a missing row under the same id and carries on', async () => {
    M.findById.mockResolvedValue(null);
    M.recreateQueued.mockResolvedValue(row());
    const { worker, runEnrichment } = setup(async () => ({ status: 'skipped' }));
    await worker.handle([job()]);
    expect(M.recreateQueued).toHaveBeenCalledWith(db, { id: ROW, word: 'ubiquitous', requestedBy: 'user-1' });
    expect(runEnrichment).toHaveBeenCalledTimes(1);
  });

  it('missing row AND the word already has another active row: nothing to do, job completes, no pipeline call', async () => {
    M.findById.mockResolvedValue(null);
    M.recreateQueued.mockResolvedValue(null);
    const { worker, runEnrichment } = setup(async () => ({ status: 'skipped' }));
    await expect(worker.handle([job()])).resolves.toBeUndefined();
    expect(runEnrichment).not.toHaveBeenCalled();
    expect(M.markRunning).not.toHaveBeenCalled();
  });

  it('a closed row whose word has a newer active row (unique violation on markRunning): completes without running', async () => {
    M.markRunning.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const { worker, runEnrichment } = setup(async () => ({ status: 'skipped' }));
    await expect(worker.handle([job()])).resolves.toBeUndefined();
    expect(runEnrichment).not.toHaveBeenCalled();
  });

  it('any other database error while claiming propagates (pg-boss retries the job)', async () => {
    M.markRunning.mockRejectedValue(new Error('connection lost'));
    const { worker } = setup(async () => ({ status: 'skipped' }));
    await expect(worker.handle([job()])).rejects.toThrow('connection lost');
  });

  it('a payload without jobRowId or word is dropped without retry', async () => {
    const { worker, runEnrichment } = setup(async () => ({ status: 'skipped' }));
    await expect(worker.handle([job({ data: { word: 'x' } as any })])).resolves.toBeUndefined();
    await expect(worker.handle([job({ data: {} as any })])).resolves.toBeUndefined();
    expect(runEnrichment).not.toHaveBeenCalled();
    expect(M.findById).not.toHaveBeenCalled();
  });
});

describe('e) UpstreamUnavailable / unexpected error → retry through pg-boss', () => {
  const unavailable = () => new UpstreamUnavailable('anthropic', 'http_5xx', { status: 503 });

  it('not the last attempt: row back to queued (reason upstream_error, attempts kept) and the error is rethrown', async () => {
    const err = unavailable();
    const { worker } = setup(async () => { throw err; });
    await expect(worker.handle([job({ retryCount: 1, retryLimit: 3 })])).rejects.toBe(err);
    expect(M.markQueued).toHaveBeenCalledWith(db, ROW, 'upstream_error');
    expect(M.failIfActive).not.toHaveBeenCalled();
    expect(M.finish).not.toHaveBeenCalled();
    expect(counterSnapshot()['job.retry']).toBe(1);
  });

  it('an unknown error is treated the same way', async () => {
    const { worker } = setup(async () => { throw new TypeError('x is not a function'); });
    await expect(worker.handle([job()])).rejects.toThrow('x is not a function');
    expect(M.markQueued).toHaveBeenCalledWith(db, ROW, 'upstream_error');
  });

  it('LAST attempt (retryCount === retryLimit, read from the pg-boss metadata): row failed / upstream_error BEFORE throwing', async () => {
    const order: string[] = [];
    M.failIfActive.mockImplementation(async () => (order.push('failIfActive'), true));
    const { worker } = setup(async () => { throw unavailable(); });
    const p = worker.handle([job({ retryCount: 3, retryLimit: 3 })]).catch((e) => (order.push('thrown'), Promise.reject(e)));
    await expect(p).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(order).toEqual(['failIfActive', 'thrown']);
    expect(M.failIfActive).toHaveBeenCalledWith(db, ROW, 'upstream_error');
    expect(M.markQueued).not.toHaveBeenCalled();
    expect(counterSnapshot()['job.failed']).toBe(1);
  });

  it('retryLimit 0: the very first attempt is already the last one', async () => {
    const { worker } = setup(async () => { throw unavailable(); });
    await expect(worker.handle([job({ retryCount: 0, retryLimit: 0 })])).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(M.failIfActive).toHaveBeenCalledWith(db, ROW, 'upstream_error');
  });

  it('the attempt before the last one still retries (retryCount = retryLimit - 1)', async () => {
    const { worker } = setup(async () => { throw unavailable(); });
    await expect(worker.handle([job({ retryCount: 2, retryLimit: 3 })])).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(M.markQueued).toHaveBeenCalledWith(db, ROW, 'upstream_error');
    expect(M.failIfActive).not.toHaveBeenCalled();
  });

  it('a pipeline that returns garbage is handled like a thrown error (the row never stays running)', async () => {
    const { worker } = setup(async () => ({ status: 'maybe' }) as any);
    await expect(worker.handle([job()])).rejects.toThrow(/invalid outcome/);
    expect(M.markQueued).toHaveBeenCalledWith(db, ROW, 'upstream_error');
    expect(M.finish).not.toHaveBeenCalled();
  });

  it('a failing result write falls into the same path', async () => {
    M.finish.mockRejectedValue(new Error('write failed'));
    const { worker } = setup(async () => ({ status: 'succeeded' }));
    await expect(worker.handle([job()])).rejects.toThrow('write failed');
    expect(M.markQueued).toHaveBeenCalledWith(db, ROW, 'upstream_error');
  });
});

describe('f) UpstreamConfigError', () => {
  it('failed / config_error, logged at error level, NOT retried (the handler resolves)', async () => {
    const { worker } = setup(async () => { throw new UpstreamConfigError('anthropic', 'invalid x-api-key', 401); });
    await expect(worker.handle([job()])).resolves.toBeUndefined();
    expect(M.finish).toHaveBeenCalledWith(db, ROW, { status: 'failed', reason: 'config_error' });
    expect(M.markQueued).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"reason":"config_error"'));
  });
});

describe('f2) EnrichmentConfigError (e.g. topics_not_seeded)', () => {
  it('failed / config_error, logged at error level with its code, NOT retried', async () => {
    const { EnrichmentConfigError } = await import('../../services/enrichment/errors');
    const { worker } = setup(async () => {
      throw new EnrichmentConfigError('topics_not_seeded', 'topics_not_seeded: 3 of 30 topic tags are missing from the "tags" table: a, b, c. Run docs/seed-topics.sql.');
    });
    await expect(worker.handle([job()])).resolves.toBeUndefined();
    expect(M.finish).toHaveBeenCalledWith(db, ROW, { status: 'failed', reason: 'config_error' });
    expect(M.markQueued).not.toHaveBeenCalled();
    expect(M.failIfActive).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"code":"topics_not_seeded"'));
  });
});

describe('g) BudgetExceeded', () => {
  it('skipped / budget, logged at error level, NOT retried', async () => {
    const { worker } = setup(async () => { throw new BudgetExceeded('anthropic', 'spend_limit'); });
    await expect(worker.handle([job()])).resolves.toBeUndefined();
    expect(M.finish).toHaveBeenCalledWith(db, ROW, { status: 'skipped', reason: 'budget' });
    expect(M.markQueued).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"reason":"budget"'));
  });
});

describe('shutdown / expiry (job.signal aborted)', () => {
  it('pg-boss already gave up on this attempt: no result is written, the row goes back to queued, no throw', async () => {
    const ac = new AbortController();
    const { worker } = setup(async () => {
      ac.abort(); // grace period ended while the pipeline was running
      return { status: 'succeeded' };
    });
    await expect(worker.handle([job({ signal: ac.signal })])).resolves.toBeUndefined();
    expect(M.markQueued).toHaveBeenCalledWith(db, ROW, null);
    expect(M.finish).not.toHaveBeenCalled();
  });

  it('same when the pipeline throws because of the abort: no retry bookkeeping, row queued', async () => {
    const ac = new AbortController();
    const { worker } = setup(async () => {
      ac.abort();
      throw new Error('aborted');
    });
    await expect(worker.handle([job({ signal: ac.signal })])).resolves.toBeUndefined();
    expect(M.markQueued).toHaveBeenCalledWith(db, ROW, null);
    expect(M.failIfActive).not.toHaveBeenCalled();
  });

  it('inFlight tracks the running row and is emptied afterwards', async () => {
    let seen: string[] = [];
    const { worker } = setup(async () => {
      seen = [...worker.inFlight];
      return { status: 'skipped' };
    });
    await worker.handle([job()]);
    expect(seen).toEqual([ROW]);
    expect(worker.inFlight.size).toBe(0);
  });

  it('inFlight is emptied after an error too', async () => {
    const { worker } = setup(async () => { throw new Error('x'); });
    await worker.handle([job()]).catch(() => undefined);
    expect(worker.inFlight.size).toBe(0);
  });

  it('requeueInFlight() puts the rows of handlers still running back to queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { worker } = setup(async () => (await gate, { status: 'skipped' }));
    const running = worker.handle([job()]);
    await new Promise((r) => setImmediate(r));
    M.requeueRunning.mockResolvedValue([ROW]);

    await expect(worker.requeueInFlight()).resolves.toEqual([ROW]);
    expect(M.requeueRunning).toHaveBeenCalledWith(db, [ROW]);

    release();
    await running;
  });

  it('requeueInFlight() with nothing running does not touch the database', async () => {
    const { worker } = setup(async () => ({ status: 'skipped' }));
    await expect(worker.requeueInFlight()).resolves.toEqual([]);
    expect(M.requeueRunning).not.toHaveBeenCalled();
  });
});

describe('dead letter queue worker', () => {
  const dlqJob = () => job({ data: { word: 'ubiquitous', requestedBy: 'user-1', ebookId: 'ebook-1', jobRowId: ROW } });

  it('fails a row that is still queued / running with reason dead_letter, logged at error level', async () => {
    M.findById.mockResolvedValue(row({ status: 'running' }));
    const { worker } = setup(async () => ({ status: 'skipped' }));
    await worker.handleDeadLetter([dlqJob()]);
    expect(M.failIfActive).toHaveBeenCalledWith(db, ROW, 'dead_letter');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"evt":"enrich_dead_letter"'));
    expect(counterSnapshot()['job.dead_letter']).toBe(1);
  });

  it('a row already closed (failed / upstream_error by the last attempt) is left alone but still logged', async () => {
    M.findById.mockResolvedValue(row({ status: 'failed', reason: 'upstream_error' }));
    M.failIfActive.mockResolvedValue(false);
    const { worker } = setup(async () => ({ status: 'skipped' }));
    await worker.handleDeadLetter([dlqJob()]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"row_changed":false'));
  });

  it('a missing row does not crash the handler', async () => {
    M.findById.mockResolvedValue(null);
    M.failIfActive.mockResolvedValue(false);
    const { worker } = setup(async () => ({ status: 'skipped' }));
    await expect(worker.handleDeadLetter([dlqJob()])).resolves.toBeUndefined();
  });
});
