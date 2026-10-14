import { UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';
import { fetchWithTimeout, parseRetryAfter, withRetry } from '../../services/upstream/http';
import { hangingFetch, noSleep } from './helpers';

describe('fetchWithTimeout', () => {
  it('maps a real timeout to UpstreamUnavailable(timeout)', async () => {
    const p = fetchWithTimeout('https://x.test/', {}, { provider: 'datamuse', timeoutMs: 30, fetchImpl: hangingFetch });
    await expect(p).rejects.toMatchObject({ name: 'UpstreamUnavailable', reason: 'timeout', provider: 'datamuse' });
  });

  it('maps other failures to network without leaking the URL or message', async () => {
    const boom = Object.assign(new TypeError('fetch failed for https://x.test/?key=SECRET'), { cause: { code: 'ECONNRESET' } });
    const p = fetchWithTimeout('https://x.test/?key=SECRET', {}, {
      provider: 'google_translate',
      timeoutMs: 1000,
      fetchImpl: async () => {
        throw boom;
      },
    });
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamUnavailable);
    expect(err.reason).toBe('network');
    expect(err.message).toContain('ECONNRESET');
    expect(err.message).not.toContain('SECRET');
  });

  it("passes the response through untouched (mapping status codes is the caller's job)", async () => {
    const res = await fetchWithTimeout('https://x.test/', {}, {
      provider: 'datamuse',
      timeoutMs: 1000,
      fetchImpl: async () => new Response('x', { status: 503 }),
    });
    expect(res.status).toBe(503);
  });

  it('honours an external abort signal', async () => {
    const ac = new AbortController();
    const p = fetchWithTimeout('https://x.test/', {}, { provider: 'datamuse', timeoutMs: 5000, signal: ac.signal, fetchImpl: hangingFetch });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(UpstreamUnavailable);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');

  it('parses delta-seconds', () => {
    expect(parseRetryAfter('7', now)).toBe(7000);
    expect(parseRetryAfter('1.5', now)).toBe(1500);
  });

  it('parses an HTTP date', () => {
    expect(parseRetryAfter('Tue, 13 Oct 2026 12:00:30 GMT', now)).toBe(30_000);
  });

  it('never goes negative and is capped', () => {
    expect(parseRetryAfter('Tue, 13 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('999999', now)).toBe(3_600_000);
  });

  it('returns undefined for missing or garbage values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('withRetry', () => {
  const net = () => new UpstreamUnavailable('datamuse', 'network');
  const timeout = () => new UpstreamUnavailable('datamuse', 'timeout');

  it('retries a transient network error and then succeeds', async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 2) throw net();
        return 'ok';
      },
      { maxAttempts: 3, sleep: noSleep, random: () => 0.5 }
    );
    expect(out).toBe('ok');
    expect(n).toBe(2);
  });

  it('retries timeouts too', async () => {
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 3) throw timeout();
        return 1;
      },
      { maxAttempts: 3, sleep: noSleep }
    );
    expect(n).toBe(3);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw net();
        },
        { maxAttempts: 2, sleep: noSleep }
      )
    ).rejects.toMatchObject({ reason: 'network' });
    expect(n).toBe(2);
  });

  it.each([
    ['429', new UpstreamUnavailable('datamuse', 'rate_limited')],
    ['a 5xx answer', new UpstreamUnavailable('datamuse', 'http_5xx')],
    ['an open breaker', new UpstreamUnavailable('datamuse', 'breaker_open')],
    ['a bad response', new UpstreamUnavailable('datamuse', 'bad_response')],
    ['a config error', new UpstreamConfigError('datamuse', 'bad key')],
    ['a plain bug', new Error('boom')],
  ])('does not retry %s', async (_name, error) => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw error;
        },
        { maxAttempts: 5, sleep: noSleep }
      )
    ).rejects.toBe(error);
    expect(n).toBe(1);
  });

  it('applies full jitter within [0, min(cap, base * 2^(attempt-1))]', async () => {
    const delays: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 4) throw net();
        return 1;
      },
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 250,
        random: () => 0.999,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );
    expect(delays).toEqual([99, 199, 249]); // ceilings 100, 200, 250 (capped), each times 0.999
  });

  it('does not start a retry that cannot fit before the deadline', async () => {
    let t = 0;
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          t += 2800;
          throw net();
        },
        { maxAttempts: 3, deadlineAt: 3000, now: () => t, sleep: noSleep, random: () => 0.5, minAttemptMs: 200 }
      )
    ).rejects.toMatchObject({ reason: 'network' });
    expect(n).toBe(1);
  });

  it('passes the remaining time to each attempt', async () => {
    let t = 0;
    const seen: number[] = [];
    let n = 0;
    await withRetry(
      async (ctx) => {
        seen.push(ctx.remainingMs);
        t += 500;
        if (++n < 2) throw net();
        return 1;
      },
      { maxAttempts: 2, deadlineAt: 3000, now: () => t, sleep: noSleep, random: () => 0 }
    );
    expect(seen).toEqual([3000, 2500]);
  });
});
