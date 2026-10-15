import pool from '../../config/db';
import { LookupHealthService, RECENT_FAILURES_LIMIT, type HealthSnapshot } from '../../services/lookup/health';
import { LookupMetrics } from '../../services/lookup/metrics';
import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { UpstreamUnavailable } from '../../services/upstream/errors';
import { currentPeriod } from '../../services/upstream/apiUsage';

jest.setTimeout(60_000);

const NOW = new Date('2026-10-15T09:30:00Z');
const MONTH = '2026-10';
const DAY = '2026-10-15';

/** A scripted database: answers the five statements the health service issues, records nothing else. */
function fakeDb(opts: { usage?: Array<[string, string, string, number]>; byStatus?: Record<string, number>; failures?: any[]; queueRows?: any[]; schemaExists?: boolean; failOn?: string[] } = {}) {
  const sqls: string[] = [];
  return {
    sqls,
    db: {
      async query(sql: string, params: any[] = []) {
        sqls.push(sql);
        const fail = (what: string) => {
          if (opts.failOn?.includes(what)) throw new Error(`${what} is down`);
        };
        if (sql.includes('FROM api_usage_counters')) {
          fail('usage');
          expect(params).toEqual([MONTH, `${MONTH}-%`, DAY]);
          return { rows: (opts.usage ?? []).map(([provider, unit, period, used]) => ({ provider, unit, period, used: String(used) })) };
        }
        if (sql.includes('GROUP BY status')) {
          fail('jobs');
          return { rows: Object.entries(opts.byStatus ?? {}).map(([status, n]) => ({ status, n })) };
        }
        if (sql.includes('FROM word_enrichment_jobs') && sql.includes('LIMIT')) {
          fail('failures');
          expect(params).toEqual([RECENT_FAILURES_LIMIT]);
          return { rows: opts.failures ?? [] };
        }
        if (sql.includes('to_regclass')) {
          fail('queue');
          expect(params).toEqual(['"pgboss".job']);
          return { rows: [{ t: opts.schemaExists === false ? null : 'pgboss.job' }] };
        }
        if (sql.includes('.job WHERE name IN')) {
          return { rows: opts.queueRows ?? [] };
        }
        throw new Error('unexpected SQL ' + sql.slice(0, 60));
      },
    },
  };
}

function breakers() {
  const clock = { t: 1_000_000 };
  const make = (provider: any) => new CircuitBreaker(provider, { failureThreshold: 2, resetMs: 30_000, now: () => clock.t });
  const all = { google_translate: make('google_translate'), free_dictionary: make('free_dictionary'), datamuse: make('datamuse'), anthropic: make('anthropic'), anthropic_fast: make('anthropic') };
  return { all, snapshots: () => Object.fromEntries(Object.entries(all).map(([k, b]) => [k, b.snapshot()])) as any, clock };
}

const service = (d: ReturnType<typeof fakeDb>, b = breakers(), extra: Partial<ConstructorParameters<typeof LookupHealthService>[0]> = {}) =>
  new LookupHealthService({ db: d.db, breakers: b.snapshots, limits: { googleMonthlyChars: 450_000, maxJobsPerDay: 500 }, queueSchema: 'pgboss', now: () => NOW, counters: () => ({ 'job.succeeded': 3 }), ...extra });

describe('LookupHealthService.getSnapshot (fake database)', () => {
  it('reports the state of every breaker, including the separate one of the lookup fast path', async () => {
    const b = breakers();
    const boom = () => Promise.reject(new UpstreamUnavailable('google_translate', 'http_5xx', { status: 503 }));
    await b.all.google_translate.exec(boom).catch(() => undefined);
    await b.all.google_translate.exec(boom).catch(() => undefined); // threshold 2 → open
    await b.all.anthropic_fast.exec(boom).catch(() => undefined);

    const s = await service(fakeDb(), b).getSnapshot();
    expect(Object.keys(s.breakers).sort()).toEqual(['anthropic', 'anthropic_fast', 'datamuse', 'free_dictionary', 'google_translate']);
    expect(s.breakers.google_translate).toMatchObject({ state: 'open', consecutiveFailures: 2 });
    expect(s.breakers.google_translate.openedAt).toEqual(expect.any(Number));
    expect(s.breakers.anthropic_fast).toMatchObject({ state: 'closed', consecutiveFailures: 1 });
    expect(s.breakers.anthropic).toMatchObject({ state: 'closed', consecutiveFailures: 0 });

    b.clock.t += 31_000; // past UPSTREAM_BREAKER_RESET_MS: the open circuit reports half_open
    expect((await service(fakeDb(), b).getSnapshot()).breakers.google_translate.state).toBe('half_open');
  });

  it('Google characters this month against the monthly limit', async () => {
    const d = fakeDb({ usage: [['google_translate', 'chars', MONTH, 123_456]] });
    const s = await service(d).getSnapshot();
    expect(s.google).toEqual({ period: MONTH, charsUsed: 123_456, monthlyCharLimit: 450_000, remaining: 326_544 });
  });

  it('remaining never goes below zero when the counter is past the limit', async () => {
    const s = await service(fakeDb({ usage: [['google_translate', 'chars', MONTH, 500_000]] })).getSnapshot();
    expect(s.google).toMatchObject({ charsUsed: 500_000, remaining: 0 });
  });

  it('Anthropic tokens this month: the enrichment job and (summed over days) the fast path', async () => {
    const d = fakeDb({
      usage: [
        ['anthropic', 'input_tokens', MONTH, 90_000],
        ['anthropic', 'output_tokens', MONTH, 12_000],
        ['anthropic_fast', 'input_tokens', `${MONTH}-14`, 400],
        ['anthropic_fast', 'input_tokens', `${MONTH}-15`, 600],
        ['anthropic_fast', 'output_tokens', `${MONTH}-15`, 90],
      ],
    });
    const s = await service(d).getSnapshot();
    expect(s.anthropic).toEqual({ period: MONTH, enrichment: { inputTokens: 90_000, outputTokens: 12_000 }, fastPath: { inputTokens: 1000, outputTokens: 90 } });
  });

  it('jobs today against ENRICHMENT_MAX_JOBS_PER_DAY, and jobs by status', async () => {
    const d = fakeDb({ usage: [['enrichment', 'jobs', DAY, 37]], byStatus: { succeeded: 30, queued: 2, failed: 5 } });
    const s = await service(d).getSnapshot();
    expect(s.jobs).toEqual({ today: { period: DAY, used: 37, limit: 500, remaining: 463 }, byStatus: { succeeded: 30, queued: 2, failed: 5 } });
  });

  it('queue depth: waiting = created + retry, plus the dead letter queue', async () => {
    const d = fakeDb({
      queueRows: [
        { name: 'dictionary.enrich_word', state: 'created', n: 4 },
        { name: 'dictionary.enrich_word', state: 'retry', n: 2 },
        { name: 'dictionary.enrich_word', state: 'active', n: 1 },
        { name: 'dictionary.enrich_word', state: 'completed', n: 90 },
        { name: 'dictionary.enrich_word.dlq', state: 'created', n: 3 },
      ],
    });
    const s = await service(d).getSnapshot();
    expect(s.queue).toEqual({
      schema: 'pgboss',
      main: { waiting: 6, active: 1, byState: { created: 4, retry: 2, active: 1, completed: 90 } },
      deadLetter: { waiting: 3, byState: { created: 3 } },
    });
  });

  it('queue is null when pg-boss was never installed (ENRICHMENT_ENABLED never on), and nothing is created', async () => {
    const d = fakeDb({ schemaExists: false });
    const s = await service(d).getSnapshot();
    expect(s.queue).toBeNull();
    expect(d.sqls.every((q) => /^\s*(SELECT|WITH)/i.test(q))).toBe(true); // read-only
  });

  it('recent failures: reason, time, word and attempts — no user, no ebook — newest first, at most 20', async () => {
    const d = fakeDb({
      failures: [
        { word: 'alpha', status: 'failed', reason: 'upstream_error', attempts: 4, at: new Date('2026-10-15T09:00:00Z'), requested_by: 'SECRET-USER', ebook_id: 'SECRET-EBOOK' },
        { word: 'beta', status: 'skipped', reason: 'budget', attempts: 1, at: new Date('2026-10-15T08:00:00Z') },
      ],
    });
    const s = await service(d).getSnapshot();
    expect(s.recentFailures).toEqual([
      { at: '2026-10-15T09:00:00.000Z', word: 'alpha', status: 'failed', reason: 'upstream_error', attempts: 4 },
      { at: '2026-10-15T08:00:00.000Z', word: 'beta', status: 'skipped', reason: 'budget', attempts: 1 },
    ]);
    expect(JSON.stringify(s)).not.toMatch(/SECRET/);
    expect(d.sqls.find((q) => q.includes('LIMIT'))).toMatch(/status = 'failed' OR \(status = 'skipped' AND reason = 'budget'\)/);
    expect(d.sqls.find((q) => q.includes('LIMIT'))).not.toMatch(/requested_by|ebook/);
  });

  it('carries the in-memory lookup metrics and the queue counters', async () => {
    const m = new LookupMetrics();
    m.record({ outcome: 'temporary', source: 'translation', partial: true, latencyMs: 120 });
    const s = await service(fakeDb(), breakers(), { metrics: m }).getSnapshot();
    expect(s.lookups).toMatchObject({ total: 1, bySource: { translation: 1 }, partial: { count: 1, of: 1, rate: 1 }, latency: { p50: 120, p95: 120 } });
    expect(s.counters).toEqual({ 'job.succeeded': 3 });
    expect(s.generatedAt).toBe(NOW.toISOString());
  });

  it('a failing section becomes { error } and the others are still returned', async () => {
    const d = fakeDb({ failOn: ['failures', 'queue'], usage: [['google_translate', 'chars', MONTH, 10]], byStatus: { queued: 1 } });
    const s = await service(d).getSnapshot();
    expect(s.recentFailures).toEqual({ error: 'failures is down' });
    expect(s.queue).toEqual({ error: 'queue is down' });
    expect(s.google).toMatchObject({ charsUsed: 10 });
    expect(s.jobs).toMatchObject({ byStatus: { queued: 1 } });

    const all = await service(fakeDb({ failOn: ['usage'] })).getSnapshot();
    expect(all.google).toEqual({ error: 'usage is down' });
    expect(all.anthropic).toEqual({ error: 'usage is down' });
    expect(all.jobs).toEqual({ error: 'usage is down' });
    expect(all.breakers).toBeDefined();
  });

  it('survives clients that cannot be built (bad configuration): no breakers, the rest is reported', async () => {
    const s = await service(fakeDb(), breakers(), { breakers: () => { throw new Error('config'); } }).getSnapshot();
    expect(s.breakers).toEqual({});
    expect(s.google).toMatchObject({ period: MONTH });
  });

  it('refuses a queue schema name that is not a plain identifier (it is spliced into SQL)', async () => {
    const s = await service(fakeDb(), breakers(), { queueSchema: 'pgboss"; DROP TABLE users; --' }).getSnapshot();
    expect(s.queue).toEqual({ error: 'invalid queue schema name' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('LookupHealthService on the real database (read-only, plus failed-job fixtures)', () => {
  const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  let snapshot: HealthSnapshot;

  beforeAll(async () => {
    // 22 failed jobs finished tomorrow, so they are the newest in the table whatever else it holds
    for (let i = 0; i < 22; i++) {
      await pool.query(
        `INSERT INTO word_enrichment_jobs (word, status, reason, attempts, finished_at) VALUES ($1, 'failed', 'upstream_error', 3, NOW() + make_interval(hours => 24, mins => $2::int))`,
        [`qzq${RUN}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, i]
      );
    }
    snapshot = await new LookupHealthService({
      db: pool,
      breakers: () => ({}),
      limits: { googleMonthlyChars: 450_000, maxJobsPerDay: 500 },
      queueSchema: 'pgboss',
    }).getSnapshot();
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM word_enrichment_jobs WHERE word LIKE $1`, [`qzq${RUN}%`]);
    await pool.end();
  });

  it('every section works against the real tables', () => {
    expect(snapshot.google).not.toHaveProperty('error');
    expect(snapshot.anthropic).not.toHaveProperty('error');
    expect(snapshot.jobs).not.toHaveProperty('error');
    expect(snapshot.queue === null || !('error' in (snapshot.queue as object))).toBe(true);
    expect(snapshot.recentFailures).not.toHaveProperty('error');
    expect((snapshot.google as any).period).toBe(currentPeriod('month'));
    expect((snapshot.jobs as any).byStatus.failed).toBeGreaterThanOrEqual(22);
  });

  it('returns exactly the 20 newest failures, newest first, with no personal column', () => {
    const list = snapshot.recentFailures as unknown as Array<Record<string, unknown>>;
    expect(list).toHaveLength(RECENT_FAILURES_LIMIT);
    expect(list.every((f) => String(f.word).startsWith(`qzq${RUN}`))).toBe(true);
    const times = list.map((f) => Date.parse(String(f.at)));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    for (const f of list) expect(Object.keys(f).sort()).toEqual(['at', 'attempts', 'reason', 'status', 'word']);
  });
});
