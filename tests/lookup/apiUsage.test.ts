import { ApiUsage, currentPeriod } from '../../services/upstream/apiUsage';

function fakeDb(rows: any[] = []) {
  const query = jest.fn(async (_sql: string, _params?: any[]) => ({ rows }));
  return { db: { query }, query };
}

describe('currentPeriod', () => {
  it('uses UTC month / day keys', () => {
    expect(currentPeriod('month', new Date('2026-10-13T12:00:00Z'))).toBe('2026-10');
    expect(currentPeriod('day', new Date('2026-10-13T12:00:00Z'))).toBe('2026-10-13');
  });

  it('is based on UTC, not the machine time zone', () => {
    // 23:30 on Dec 31 in UTC-5 is already January 1 in UTC.
    const d = new Date('2026-12-31T23:30:00-05:00');
    expect(currentPeriod('month', d)).toBe('2027-01');
    expect(currentPeriod('day', d)).toBe('2027-01-01');
    // 00:30 on Nov 1 in UTC+7 is still Oct 31 in UTC.
    expect(currentPeriod('month', new Date('2026-11-01T00:30:00+07:00'))).toBe('2026-10');
  });
});

describe('ApiUsage.reserve', () => {
  it('returns true when the guarded upsert returns a row', async () => {
    const { db, query } = fakeDb([{ used: '150' }]);
    await expect(new ApiUsage(db).reserve('google_translate', 'chars', '2026-10', 50, 450_000)).resolves.toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['google_translate', '2026-10', 'chars', 50, 450_000]);
    expect(sql).toMatch(/ON CONFLICT \(provider, period, unit\) DO UPDATE/);
    expect(sql).toMatch(/WHERE api_usage_counters\.used \+ EXCLUDED\.used <= \$5/);
    expect(sql).toMatch(/RETURNING used/);
  });

  it('returns false when the limit guard rejects the update (no row returned)', async () => {
    const { db } = fakeDb([]);
    await expect(new ApiUsage(db).reserve('google_translate', 'chars', '2026-10', 50, 100)).resolves.toBe(false);
  });

  it('refuses an amount larger than the limit without touching the database', async () => {
    const { db, query } = fakeDb([{ used: '1' }]);
    await expect(new ApiUsage(db).reserve('google_translate', 'chars', '2026-10', 101, 100)).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('treats a zero amount as trivially reserved, with no query', async () => {
    const { db, query } = fakeDb();
    await expect(new ApiUsage(db).reserve('enrichment', 'jobs', '2026-10-13', 0, 500)).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects invalid amounts', async () => {
    const usage = new ApiUsage(fakeDb().db);
    await expect(usage.reserve('p', 'u', '2026-10', -1, 10)).rejects.toThrow(RangeError);
    await expect(usage.reserve('p', 'u', '2026-10', 1.5, 10)).rejects.toThrow(RangeError);
  });
});

describe('ApiUsage other operations', () => {
  it('add() upserts without a limit check', async () => {
    const { db, query } = fakeDb();
    await new ApiUsage(db).add('anthropic', 'input_tokens', '2026-10-13', 1234);
    expect(query.mock.calls[0][0]).not.toMatch(/<=/);
    expect(query.mock.calls[0][1]).toEqual(['anthropic', '2026-10-13', 'input_tokens', 1234]);
  });

  it('release() never goes below zero', async () => {
    const { db, query } = fakeDb();
    await new ApiUsage(db).release('google_translate', 'chars', '2026-10', 40);
    expect(query.mock.calls[0][0]).toMatch(/GREATEST\(used - \$4, 0\)/);
  });

  it('getUsed() converts the BIGINT string and defaults to 0', async () => {
    await expect(new ApiUsage(fakeDb([{ used: '9007199254' }]).db).getUsed('p', 'u', '2026-10')).resolves.toBe(9007199254);
    await expect(new ApiUsage(fakeDb([]).db).getUsed('p', 'u', '2026-10')).resolves.toBe(0);
  });
});
