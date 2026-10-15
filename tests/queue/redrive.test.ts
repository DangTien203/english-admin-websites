import { applyRedrive, DEFAULT_REDRIVE_LIMIT, MAX_REDRIVE_LIMIT, planRedrive, type RedrivePlan } from '../../services/queue/redrive';
import { ENRICH_DLQ } from '../../services/queue/constants';

/** Scripted database: the DLQ listing, the ledger rows, the entry-exists probe and the active-row probe. */
function fakeDb(opts: { dlq: Array<{ id: string; word?: string | null; jobRowId?: string | null; created?: string; requestedBy?: string | null }>; ledger?: Record<string, any>; entries?: string[]; active?: string[] }) {
  const sqls: Array<{ sql: string; params?: any[] }> = [];
  return {
    sqls,
    query: async (sql: string, params: any[] = []) => {
      sqls.push({ sql, params });
      if (sql.includes('.job') && sql.includes('LIMIT')) {
        return {
          rows: opts.dlq.map((d) => ({
            id: d.id,
            created_on: d.created ?? '2026-10-15T08:00:00Z',
            data: d.word === null ? {} : { word: d.word, requestedBy: d.requestedBy ?? null, ebookId: null, jobRowId: d.jobRowId ?? null },
          })),
        };
      }
      if (sql.includes('SELECT * FROM word_enrichment_jobs WHERE id')) return { rows: opts.ledger?.[params[0]] ? [opts.ledger[params[0]]] : [] };
      if (sql.includes('AS found')) return { rows: [{ found: (opts.entries ?? []).includes(params[0]) }] };
      if (sql.includes("status IN ('queued', 'running') LIMIT 1")) return { rows: (opts.active ?? []).includes(params[0]) ? [{ x: 1 }] : [] };
      throw new Error('unexpected SQL ' + sql.slice(0, 70));
    },
  };
}

const failedRow = (id: string, reason = 'dead_letter', attempts = 4) => ({ id, word: 'x', status: 'failed', reason, attempts, entry_id: null });

describe('planRedrive', () => {
  it('lists the dead-lettered jobs of the dead letter queue with bound parameters only (the schema is a checked identifier)', async () => {
    const db = fakeDb({ dlq: [] });
    await planRedrive({ db, schema: 'pgboss' }, { words: [' Alpha ', 'beta'], dlqJobIds: ['00000000-0000-0000-0000-000000000001'], limit: 5 });
    const q = db.sqls[0];
    expect(q.sql).toContain('FROM "pgboss".job');
    expect(q.params).toEqual([ENRICH_DLQ, ['alpha', 'beta'], ['00000000-0000-0000-0000-000000000001'], 5]);
    expect(q.sql).not.toMatch(/alpha|beta/);
  });

  it('refuses a schema name that is not a plain identifier', async () => {
    await expect(planRedrive({ db: fakeDb({ dlq: [] }), schema: 'pgboss"; DROP TABLE users; --' })).rejects.toThrow('invalid queue schema name');
  });

  it('clamps the limit: default 20, at least 1, at most 500', async () => {
    const limits: number[] = [];
    for (const limit of [undefined, 0, -3, 99999]) {
      const db = fakeDb({ dlq: [] });
      await planRedrive({ db, schema: 'pgboss' }, { limit });
      limits.push(db.sqls[0].params![3]);
    }
    expect(limits).toEqual([DEFAULT_REDRIVE_LIMIT, 1, 1, MAX_REDRIVE_LIMIT]);
  });

  it('a failed word with nothing in the way is marked for redrive and carries its ledger history', async () => {
    const db = fakeDb({ dlq: [{ id: 'd1', word: 'alpha', jobRowId: 'r1', requestedBy: 'u1' }], ledger: { r1: failedRow('r1', 'upstream_error', 4) } });
    const plan = await planRedrive({ db, schema: 'pgboss' });
    expect(plan.items).toEqual([
      expect.objectContaining({ dlqJobId: 'd1', word: 'alpha', requestedBy: 'u1', ledgerStatus: 'failed', ledgerReason: 'upstream_error', ledgerAttempts: 4, verdict: 'redrive' }),
    ]);
    expect(plan.scanned).toBe(1);
  });

  it('skips a word that has an entry now, an active row, or a ledger row that is not failed', async () => {
    const db = fakeDb({
      dlq: [
        { id: 'd1', word: 'hasentry', jobRowId: 'r1' },
        { id: 'd2', word: 'isactive', jobRowId: 'r2' },
        { id: 'd3', word: 'alreadydone', jobRowId: 'r3' },
        { id: 'd4', word: 'norow', jobRowId: 'r4' }, // the ledger row was purged: still fine to redrive
      ],
      ledger: { r1: failedRow('r1'), r2: failedRow('r2'), r3: { ...failedRow('r3'), status: 'succeeded' } },
      entries: ['hasentry'],
      active: ['isactive'],
    });
    const plan = await planRedrive({ db, schema: 'pgboss' });
    expect(plan.items.map((i) => [i.word, i.verdict, i.skip])).toEqual([
      ['hasentry', 'skip', 'entry_exists'],
      ['isactive', 'skip', 'active_row'],
      ['alreadydone', 'skip', 'ledger_not_failed'],
      ['norow', 'redrive', undefined],
    ]);
  });

  it('only the NEWEST dead letter of a word counts; a payload without a word is skipped', async () => {
    const db = fakeDb({ dlq: [{ id: 'new', word: 'alpha', jobRowId: 'r1' }, { id: 'old', word: 'alpha', jobRowId: 'r0' }, { id: 'junk', word: null }], ledger: { r1: failedRow('r1'), r0: failedRow('r0') } });
    const plan = await planRedrive({ db, schema: 'pgboss' });
    expect(plan.items.map((i) => [i.dlqJobId, i.verdict, i.skip])).toEqual([['new', 'redrive', undefined], ['old', 'skip', 'newer_dead_letter'], ['junk', 'skip', 'bad_payload']]);
  });

  it('--reason keeps only jobs whose ledger row carries it', async () => {
    const db = fakeDb({ dlq: [{ id: 'd1', word: 'alpha', jobRowId: 'r1' }, { id: 'd2', word: 'beta', jobRowId: 'r2' }], ledger: { r1: failedRow('r1', 'upstream_error'), r2: failedRow('r2', 'stale') } });
    const plan = await planRedrive({ db, schema: 'pgboss' }, { reasons: ['upstream_error'] });
    expect(plan.items.map((i) => [i.word, i.verdict, i.skip])).toEqual([['alpha', 'redrive', undefined], ['beta', 'skip', 'reason_filter']]);
  });

  it('writes nothing: every statement is a SELECT', async () => {
    const db = fakeDb({ dlq: [{ id: 'd1', word: 'alpha', jobRowId: 'r1' }], ledger: { r1: failedRow('r1') } });
    await planRedrive({ db, schema: 'pgboss' });
    expect(db.sqls.every((q) => /^\s*SELECT/i.test(q.sql))).toBe(true);
  });
});

describe('applyRedrive', () => {
  const plan = (words: string[], skip: string[] = []): RedrivePlan => ({
    schema: 'pgboss',
    scanned: words.length + skip.length,
    items: [
      ...words.map((word, i) => ({ dlqJobId: `d${i}`, deadLetteredAt: `2026-10-15T0${i}:00:00Z`, word, requestedBy: 'u1', ebookId: 'e1', jobRowId: `r${i}`, ledgerStatus: 'failed', ledgerReason: 'dead_letter', ledgerAttempts: 4, verdict: 'redrive' as const })),
      ...skip.map((word) => ({ dlqJobId: `s-${word}`, deadLetteredAt: '2026-10-15T00:00:00Z', word, requestedBy: null, ebookId: null, jobRowId: null, ledgerStatus: null, ledgerReason: null, ledgerAttempts: null, verdict: 'skip' as const, skip: 'entry_exists' as const })),
    ],
  });

  it('sends only the items marked for redrive, through the enqueuer, oldest first, with the original requester and ebook', async () => {
    const enqueue = jest.fn(async (_input: { word: string; requestedBy: string | null; ebookId: string | null }) => ({ status: 'queued' as const }));
    const out = await applyRedrive({ enqueuer: { enqueue } }, plan(['newest', 'oldest'], ['left']));
    expect(enqueue.mock.calls.map(([i]) => i)).toEqual([
      { word: 'oldest', requestedBy: 'u1', ebookId: 'e1' },
      { word: 'newest', requestedBy: 'u1', ebookId: 'e1' },
    ]);
    expect(out).toMatchObject({ attempted: 2, byStatus: { queued: 2 }, stoppedByDailyCap: false });
  });

  it('reports what the enqueuer said for each word and stops at the daily cap', async () => {
    const answers: any[] = [{ status: 'queued' }, { status: 'skipped', reason: 'daily_cap' }, { status: 'queued' }];
    const enqueue = jest.fn(async () => answers.shift());
    const out = await applyRedrive({ enqueuer: { enqueue } }, plan(['c', 'b', 'a']));
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(out.stoppedByDailyCap).toBe(true);
    expect(out.byStatus).toEqual({ queued: 1, 'skipped:daily_cap': 1 });
  });

  it('an empty plan sends nothing', async () => {
    const enqueue = jest.fn();
    expect(await applyRedrive({ enqueuer: { enqueue } }, plan([], ['left']))).toMatchObject({ attempted: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
