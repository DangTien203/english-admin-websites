import { LookupMetrics, percentile } from '../../services/lookup/metrics';
import { WordLookupService } from '../../services/lookup/lookupService';
import { fdFound, flush, input, makeHarness, realFdEntry } from '../lookup/serviceHarness';
import { UserRateLimiter } from '../../services/lookup/rateLimiter';

describe('percentile (nearest rank)', () => {
  it('matches the textbook definition', () => {
    const v = [15, 20, 35, 40, 50];
    expect(percentile(v, 50)).toBe(35);
    expect(percentile(v, 95)).toBe(50);
    expect(percentile(v, 100)).toBe(50);
    expect(percentile(v, 0)).toBe(15);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it('p50 and p95 of 1..100', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
  });
});

describe('LookupMetrics', () => {
  const sample = (outcome: string, source: string, partial = false, latencyMs = 10) => ({ outcome, source, partial, latencyMs });

  it('counts by source, by outcome and by both', () => {
    const m = new LookupMetrics();
    m.record(sample('hit', 'dictionary'));
    m.record(sample('hit', 'dictionary'));
    m.record(sample('temporary', 'translation'));
    m.record(sample('not_found', 'none'));
    m.record(sample('unavailable', 'none'));
    m.record(sample('rate_limited', 'none'));
    const s = m.snapshot();
    expect(s.total).toBe(6);
    expect(s.bySource).toEqual({ dictionary: 2, translation: 1, none: 3 });
    expect(s.byOutcome).toEqual({ hit: 2, temporary: 1, not_found: 1, unavailable: 1, rate_limited: 1 });
    expect(s.bySourceOutcome).toMatchObject({ 'dictionary:hit': 2, 'translation:temporary': 1, 'none:not_found': 1 });
  });

  it('the partial rate is the share of partial answers among answers that carry a body', () => {
    const m = new LookupMetrics();
    expect(m.snapshot().partial).toEqual({ count: 0, of: 0, rate: 0 });
    m.record(sample('temporary', 'translation', true));
    m.record(sample('temporary', 'translation', false));
    m.record(sample('temporary', 'translation', false));
    m.record(sample('temporary', 'translation', false));
    m.record(sample('hit', 'dictionary', false)); // not an answer with a body: not in the denominator
    m.record(sample('not_found', 'none', true)); // a flag on a non-answer is ignored
    expect(m.snapshot().partial).toEqual({ count: 1, of: 4, rate: 0.25 });
  });

  it('latency p50, p95 and max over the last N lookups only (ring buffer)', () => {
    const m = new LookupMetrics(5);
    for (const ms of [1000, 1000, 1000, 1000, 1000]) m.record(sample('hit', 'dictionary', false, ms));
    for (const ms of [10, 20, 30, 40, 50]) m.record(sample('hit', 'dictionary', false, ms)); // pushes the slow ones out
    const s = m.snapshot();
    expect(s.total).toBe(10);
    expect(s.latency).toEqual({ samples: 5, p50: 30, p95: 50, max: 50 });
  });

  it('copes with nonsense latencies and starts empty', () => {
    const m = new LookupMetrics();
    expect(m.snapshot().latency).toEqual({ samples: 0, p50: null, p95: null, max: null });
    m.record(sample('hit', 'dictionary', false, NaN));
    m.record(sample('hit', 'dictionary', false, -5));
    expect(m.snapshot().latency).toMatchObject({ samples: 2, max: 0 });
  });

  it('reset() starts over, and the window must be >= 1', () => {
    const m = new LookupMetrics();
    m.record(sample('hit', 'dictionary'));
    m.reset();
    expect(m.snapshot()).toMatchObject({ total: 0, bySource: {}, byOutcome: {} });
    expect(() => new LookupMetrics(0)).toThrow(RangeError);
  });

  it('memory stays bounded: a million samples keep one ring and a handful of keys', () => {
    const m = new LookupMetrics(500);
    for (let i = 0; i < 1_000_000; i++) m.record(sample(i % 2 ? 'hit' : 'temporary', i % 2 ? 'dictionary' : 'translation', false, i % 1000));
    const s = m.snapshot();
    expect(s.total).toBe(1_000_000);
    expect(s.latency.samples).toBe(500);
    expect(Object.keys(s.bySourceOutcome)).toHaveLength(2);
  });
});

describe('WordLookupService feeds the metrics (spec §12.2)', () => {
  it('records one sample per lookup with the same outcome and source as the log line', async () => {
    const recorded: any[] = [];
    const h = makeHarness({ db: { local: (w) => (w === 'known' ? { id: 'e1', headword: 'known', lemma: 'known' } : undefined) } });
    const service = new WordLookupService({ ...(h.service as any).deps, metrics: { record: (s: any) => recorded.push(s) } });

    await service.lookup(input('known'));
    await service.lookup(input('hello'));
    await flush();

    expect(recorded).toEqual([
      expect.objectContaining({ outcome: 'hit', source: 'dictionary', partial: false }),
      expect.objectContaining({ outcome: 'temporary', source: 'translation', partial: false }),
    ]);
    expect(recorded[1].latencyMs).toEqual(expect.any(Number));
  });

  it('counts the other outcomes too: not_found, unavailable, rate_limited, partial', async () => {
    const m = new LookupMetrics();
    const limiter = new UserRateLimiter(2);
    const base = makeHarness({
      limiter,
      fd: async (word) => (word === 'nope' ? { found: false } : word === 'down' ? Promise.reject(new Error('down')) : fdFound(realFdEntry('hello'))),
      google: async (texts) => {
        if (texts[0] === 'down' || texts[0] === 'nope' || texts[0] === 'nog') throw new Error('google down');
        return texts.map((t) => (t.includes(': ') ? 'Nghĩa: Định nghĩa' : 'Chào'));
      },
    });
    const service = new WordLookupService({ ...(base.service as any).deps, metrics: m });

    await service.lookup(input('hello', 'u1')); // temporary, full
    await service.lookup(input('nog', 'u1')); // F, not G → partial (rate limit of u1 is now spent)
    expect((await service.lookup(input('third', 'u1'))).kind).toBe('rate_limited');
    await service.lookup(input('nope', 'u2')); // not G, FD404
    await service.lookup(input('down', 'u2')); // not G, FDerr

    const s = m.snapshot();
    expect(s.byOutcome).toEqual({ temporary: 2, rate_limited: 1, not_found: 1, unavailable: 1 });
    expect(s.partial).toEqual({ count: 1, of: 2, rate: 0.5 });
  });

  it('a counter that throws never breaks a lookup', async () => {
    const h = makeHarness();
    const service = new WordLookupService({ ...(h.service as any).deps, metrics: { record: () => { throw new Error('boom'); } } });
    await expect(service.lookup(input('hello'))).resolves.toMatchObject({ kind: 'temporary' });
  });
});
