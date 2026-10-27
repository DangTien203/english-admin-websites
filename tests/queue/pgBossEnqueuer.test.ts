import { PgBossEnrichmentEnqueuer } from '../../services/queue/pgBossEnqueuer';
import { ENRICH_QUEUE } from '../../services/queue/constants';
import { counterSnapshot, resetCounters } from '../../services/queue/log';
import { makeEnqueuerFakes, type FakeOptions } from './helpers';

const NOW = new Date('2026-10-14T10:00:00Z');
const input = { word: 'Ubiquitous', requestedBy: 'user-1', ebookId: 'ebook-1' };

function build(opts: FakeOptions = {}, extra: { maxJobsPerDay?: number; now?: () => Date } = {}) {
  const f = makeEnqueuerFakes(opts);
  const enqueuer = new PgBossEnrichmentEnqueuer({
    pool: f.pool,
    getBoss: f.getBoss,
    usageFor: f.usageFor,
    maxJobsPerDay: extra.maxJobsPerDay ?? 500,
    now: extra.now ?? (() => NOW),
  });
  return { ...f, enqueuer };
}

beforeEach(() => {
  resetCounters();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('a) word cleaning', () => {
  it.each(['full-time', 'T-shirt', 'well-being', "o'clock", 'good-for-nothing'])('queues the hyphenated / apostrophe word %j (valid headword), lower-cased', async (word) => {
    const t = build();
    await expect(t.enqueuer.enqueue({ ...input, word })).resolves.toEqual(expect.objectContaining({ status: 'queued' }));
    const [, data, options] = t.send.mock.calls[0];
    expect((data as any).word).toBe(word.toLowerCase());
    expect(options?.singletonKey).toBe(word.toLowerCase());
  });

  it.each(['', '   ', '12345', 'two words', 'a'.repeat(51), 'café!?', '<script>', '-abc', 'abc-', 'a--b', 'ice cream', 'abc123'])(
    'rejects %j as invalid_word without touching anything',
    async (word) => {
      const t = build();
      await expect(t.enqueuer.enqueue({ ...input, word })).resolves.toEqual({ status: 'skipped', reason: 'invalid_word' });
      expect(t.pool.query).not.toHaveBeenCalled();
      expect(t.getBoss).not.toHaveBeenCalled();
      expect(t.usage.reserve).not.toHaveBeenCalled();
    }
  );

  it('uses the fast path cleaner: strips punctuation and lowercases', async () => {
    const t = build();
    await t.enqueuer.enqueue({ ...input, word: '  "Ubiquitous!" ' });
    const [, data, options] = t.send.mock.calls[0];
    expect((data as any).word).toBe('ubiquitous');
    expect(options?.singletonKey).toBe('ubiquitous');
  });
});

describe('b) an active row already exists', () => {
  it('returns already_queued, takes no daily slot, opens no transaction', async () => {
    const t = build({ activeRow: true });
    await expect(t.enqueuer.enqueue(input)).resolves.toEqual({ status: 'already_queued' });
    expect(t.usage.reserve).not.toHaveBeenCalled();
    expect(t.pool.connect).not.toHaveBeenCalled();
    expect(t.send).not.toHaveBeenCalled();
    expect(counterSnapshot()['enqueue.already_queued']).toBe(1);
  });
});

describe('c) the dictionary already has the word', () => {
  it('returns skipped / exists, takes no daily slot', async () => {
    const t = build({ entryExists: true });
    await expect(t.enqueuer.enqueue(input)).resolves.toEqual({ status: 'skipped', reason: 'exists' });
    expect(t.usage.reserve).not.toHaveBeenCalled();
    expect(t.pool.connect).not.toHaveBeenCalled();
  });

  it('checks headword, lemma and word forms, published or not, case-insensitively', async () => {
    const t = build();
    await t.enqueuer.enqueue(input);
    const sql = t.poolSql.find((q) => q.sql.includes('AS found'))!.sql;
    expect(sql).toMatch(/LOWER\(headword\) = \$1 OR LOWER\(lemma\) = \$1/);
    expect(sql).toMatch(/word_forms WHERE LOWER\(form_value\) = \$1/);
    expect(sql).not.toMatch(/published/i);
  });
});

describe('d) daily cap', () => {
  it('skipped / daily_cap when the cap is used up: no row, no job, transaction rolled back, counter bumped', async () => {
    const t = build({ capAvailable: false });
    await expect(t.enqueuer.enqueue(input)).resolves.toEqual({ status: 'skipped', reason: 'daily_cap' });
    expect(t.events).toEqual(['getBoss', 'connect', 'BEGIN', 'reserve', 'ROLLBACK']);
    expect(t.send).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"evt":"enrich_daily_cap"'));
    expect(counterSnapshot()['enqueue.skipped.daily_cap']).toBe(1);
    expect(t.client.release).toHaveBeenCalledWith(undefined);
  });

  it('reserves ONE job on the enrichment/jobs counter for the UTC day, inside the transaction', async () => {
    const t = build({}, { maxJobsPerDay: 7, now: () => new Date('2026-10-14T23:30:00-05:00') });
    await t.enqueuer.enqueue(input);
    expect(t.usageFor).toHaveBeenCalledWith(t.client); // bound to the transaction's connection
    expect(t.usage.reserve).toHaveBeenCalledWith('enrichment', 'jobs', '2026-10-15', 1, 7);
  });
});

describe('e) ledger row', () => {
  it('lost the unique-index race: already_queued, rolled back (which gives the slot back), nothing sent', async () => {
    const t = build({ insertConflict: true });
    await expect(t.enqueuer.enqueue(input)).resolves.toEqual({ status: 'already_queued' });
    expect(t.events).toEqual(['getBoss', 'connect', 'BEGIN', 'reserve', 'insert_row', 'ROLLBACK']);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.usage.release).not.toHaveBeenCalled(); // not needed: the reservation lived in the rolled back transaction
  });

  it('stores the requesting user on the row, with ON CONFLICT DO NOTHING on the partial unique index', async () => {
    const t = build();
    await t.enqueuer.enqueue(input);
    const insert = t.clientSql.find((q) => q.sql.includes('INSERT INTO word_enrichment_jobs'))!;
    expect(insert.params).toEqual(['ubiquitous', 'user-1']);
    expect(insert.sql).toMatch(/ON CONFLICT \(word\) WHERE status IN \('queued', 'running'\) DO NOTHING/);
  });
});

describe('f) boss.send', () => {
  it('queued: row, job and cap commit together, in this order', async () => {
    const t = build();
    await expect(t.enqueuer.enqueue(input)).resolves.toEqual({ status: 'queued' });
    expect(t.events).toEqual(['getBoss', 'connect', 'BEGIN', 'reserve', 'insert_row', 'send', 'COMMIT']);
    expect(counterSnapshot()['enqueue.queued']).toBe(1);
  });

  it('sends to dictionary.enrich_word with singletonKey = word and ONLY word, requestedBy, ebookId, jobRowId', async () => {
    const t = build();
    await t.enqueuer.enqueue(input);
    const [name, data, options] = t.send.mock.calls[0];
    expect(name).toBe(ENRICH_QUEUE);
    expect(data).toEqual({ word: 'ubiquitous', requestedBy: 'user-1', ebookId: 'ebook-1', jobRowId: 'row-1' });
    expect(Object.keys(data).sort()).toEqual(['ebookId', 'jobRowId', 'requestedBy', 'word']);
    expect(options?.singletonKey).toBe('ubiquitous');
    expect(options?.startAfter).toBeUndefined();
  });

  it('passes the transaction to pg-boss as its `db` (executeSql runs on the same connection)', async () => {
    const t = build();
    await t.enqueuer.enqueue(input);
    const options = t.send.mock.calls[0][2] as any;
    await options.db.executeSql('SELECT 1', []);
    expect(t.clientSql.at(-1)).toEqual({ sql: 'SELECT 1', params: [] });
  });

  it('startAfterSeconds becomes startAfter (seconds)', async () => {
    const t = build();
    await t.enqueuer.enqueue({ ...input, startAfterSeconds: 60 });
    expect(t.send.mock.calls[0][2]).toMatchObject({ startAfter: 60 });
  });

  it('send() returned null: row kept as skipped/duplicate, slot given back, committed, already_queued', async () => {
    const t = build({ sendResult: null });
    await expect(t.enqueuer.enqueue(input)).resolves.toEqual({ status: 'already_queued' });
    expect(t.events).toEqual(['getBoss', 'connect', 'BEGIN', 'reserve', 'insert_row', 'send', 'update_row:skipped:duplicate', 'release', 'COMMIT']);
    expect(t.usage.release).toHaveBeenCalledWith('enrichment', 'jobs', '2026-10-14', 1);
  });

  it('send() threw: rolled back (row, job and slot vanish), audit row failed/queue_error, error rethrown', async () => {
    const t = build({ sendResult: new Error('connection terminated') });
    await expect(t.enqueuer.enqueue(input)).rejects.toThrow('connection terminated');
    expect(t.events).toEqual(['getBoss', 'connect', 'BEGIN', 'reserve', 'insert_row', 'send', 'ROLLBACK', 'audit:ubiquitous']);
    expect(t.events).not.toContain('COMMIT');
    expect(t.poolSql.find((q) => q.sql.includes("'failed', 'queue_error'"))).toBeDefined();
    expect(counterSnapshot()['enqueue.queue_error']).toBe(1);
    expect(t.client.release).toHaveBeenCalledWith(undefined);
  });

  it('a failing ROLLBACK destroys the connection instead of returning it to the pool', async () => {
    const t = build({ sendResult: new Error('boom'), rollbackFails: true });
    await expect(t.enqueuer.enqueue(input)).rejects.toThrow('boom');
    expect(t.client.release).toHaveBeenCalledWith(true);
  });

  it('pg-boss cannot start: throws before a slot or a connection is used', async () => {
    const t = build({ getBossFails: true });
    await expect(t.enqueuer.enqueue(input)).rejects.toThrow('pg-boss is down');
    expect(t.pool.connect).not.toHaveBeenCalled();
    expect(t.usage.reserve).not.toHaveBeenCalled();
  });
});
