import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { DatamuseClient, DatamuseClientConfig, DATAMUSE_MAX_RESULTS } from '../../services/upstream/datamuseClient';
import { fakeClock, hangingFetch, jsonResponse, noSleep, scriptedFetch, Step } from './helpers';

const words = (...w: string[]) => w.map((word, i) => ({ word, score: 1000 - i }));

function setup(opts: { route?: (url: URL) => Response | Error; config?: Partial<DatamuseClientConfig>; threshold?: number; applyAuth?: jest.Mock } = {}) {
  const calls: URL[] = [];
  const steps: Step[] = [
    (url) => {
      const u = new URL(url);
      calls.push(u);
      const r = opts.route
        ? opts.route(u)
        : u.searchParams.has('rel_syn')
          ? jsonResponse(200, words('Big', 'large', 'huge', 'LARGE', 'happy'))
          : jsonResponse(200, words('small', 'tiny'));
      if (r instanceof Error) throw r;
      return r;
    },
  ];
  const { fn } = scriptedFetch(steps);
  const clock = fakeClock();
  const breaker = new CircuitBreaker('datamuse', { failureThreshold: opts.threshold ?? 5, resetMs: 30_000, now: clock.now });
  const onDegraded = jest.fn();
  const client = new DatamuseClient(
    { enabled: true, baseUrl: 'https://api.datamuse.com', timeoutMs: 2500, ...opts.config },
    { breaker, fetchImpl: fn, sleep: noSleep, random: () => 0, onDegraded, applyAuth: opts.applyAuth }
  );
  return { client, calls, breaker, onDegraded };
}

describe('DatamuseClient.relations', () => {
  it('runs rel_syn and rel_ant in parallel with max=20 and returns de-duplicated lowercase words', async () => {
    const { client, calls } = setup();
    const result = await client.relations('happy');
    expect(calls.map((u) => [...u.searchParams.keys()].sort())).toEqual(expect.arrayContaining([['max', 'rel_syn'], ['max', 'rel_ant']]));
    expect(calls).toHaveLength(2);
    for (const u of calls) {
      expect(u.origin + u.pathname).toBe('https://api.datamuse.com/words');
      expect(u.searchParams.get('max')).toBe(String(DATAMUSE_MAX_RESULTS));
    }
    expect(DATAMUSE_MAX_RESULTS).toBe(20);
    // 'happy' (the query itself) and the duplicate 'LARGE' are removed
    expect(result).toEqual({ synonyms: ['big', 'large', 'huge'], antonyms: ['small', 'tiny'] });
    expect(result.degraded).toBeUndefined();
  });

  it('returns empty lists immediately, with no request, when DATAMUSE_ENABLED=false', async () => {
    const { client, calls } = setup({ config: { enabled: false } });
    await expect(client.relations('happy')).resolves.toEqual({ synonyms: [], antonyms: [] });
    expect(calls).toHaveLength(0);
  });

  it('never throws: a total failure gives empty lists with degraded=true', async () => {
    const { client, onDegraded } = setup({ route: () => jsonResponse(503, {}) });
    await expect(client.relations('happy')).resolves.toEqual({ synonyms: [], antonyms: [], degraded: true });
    expect(onDegraded).toHaveBeenCalled();
  });

  it('keeps the half that worked and marks the result degraded', async () => {
    const { client } = setup({ route: (u) => (u.searchParams.has('rel_syn') ? jsonResponse(200, words('big')) : jsonResponse(429, {})) });
    await expect(client.relations('large')).resolves.toEqual({ synonyms: ['big'], antonyms: [], degraded: true });
  });

  it.each([
    ['a timeout', () => new TypeError('fetch failed')],
    ['429', () => jsonResponse(429, {}, { 'retry-after': '5' })],
    ['an HTML error page', () => new Response('<html/>', { status: 200 })],
    ['JSON that is not an array', () => jsonResponse(200, { oops: true })],
    ['a 403', () => jsonResponse(403, {})],
  ])('degrades quietly on %s', async (_name, make) => {
    const { client } = setup({ route: () => make() });
    await expect(client.relations('happy')).resolves.toEqual({ synonyms: [], antonyms: [], degraded: true });
  });

  it('a real timeout also degrades instead of throwing', async () => {
    const client = new DatamuseClient(
      { enabled: true, baseUrl: 'https://api.datamuse.com', timeoutMs: 20, maxAttempts: 1 },
      { breaker: new CircuitBreaker('datamuse', { failureThreshold: 5, resetMs: 1000 }), fetchImpl: hangingFetch }
    );
    await expect(client.relations('happy')).resolves.toEqual({ synonyms: [], antonyms: [], degraded: true });
  });

  it('with an open breaker it degrades without sending anything', async () => {
    const { client, calls, breaker } = setup({ route: () => jsonResponse(503, {}), threshold: 1 });
    await client.relations('a');
    expect(breaker.currentState()).toBe('open');
    calls.length = 0;
    await expect(client.relations('b')).resolves.toEqual({ synonyms: [], antonyms: [], degraded: true });
    expect(calls).toHaveLength(0);
  });

  it('an empty word is degraded, not an error', async () => {
    const { client, calls } = setup();
    await expect(client.relations('  ')).resolves.toEqual({ synonyms: [], antonyms: [], degraded: true });
    expect(calls).toHaveLength(0);
  });

  describe('API key handling (single hook)', () => {
    it('does not call the auth hook when there is no key', async () => {
      const applyAuth = jest.fn();
      const { client } = setup({ applyAuth });
      await client.relations('happy');
      expect(applyAuth).not.toHaveBeenCalled();
    });

    it('calls the auth hook once per request when a key is configured', async () => {
      const applyAuth = jest.fn((url: URL, _h: Headers, key: string) => url.searchParams.set('k', key));
      const { client, calls } = setup({ applyAuth, config: { apiKey: 'test-key' } });
      await client.relations('happy');
      expect(applyAuth).toHaveBeenCalledTimes(2);
      expect(calls.every((u) => u.searchParams.get('k') === 'test-key')).toBe(true);
    });

    it('the default hook is a documented no-op: the key is not invented into any parameter', async () => {
      const { client, calls } = setup({ config: { apiKey: 'test-key' } });
      await client.relations('happy');
      for (const u of calls) expect(u.toString()).not.toContain('test-key');
    });
  });
});
