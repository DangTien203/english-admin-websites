import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';
import { GoogleTranslateClient, GoogleTranslateClientConfig } from '../../services/upstream/googleTranslateClient';
import { fakeClock, hangingFetch, jsonResponse, noSleep, scriptedFetch, Step } from './helpers';

const KEY = 'AIza-test-key-0123456789';

function googleOk(...texts: string[]) {
  return jsonResponse(200, { data: { translations: texts.map((t) => ({ translatedText: t, detectedSourceLanguage: 'en' })) } });
}

function setup(opts: { steps?: Step[]; config?: Partial<GoogleTranslateClientConfig>; reserve?: boolean; threshold?: number } = {}) {
  const { fn, calls } = scriptedFetch(opts.steps ?? [googleOk('Xin chào')]);
  const usage = {
    reserve: jest.fn(async () => opts.reserve ?? true),
    release: jest.fn(async () => undefined),
  };
  const clock = fakeClock();
  const breaker = new CircuitBreaker('google_translate', { failureThreshold: opts.threshold ?? 5, resetMs: 30_000, now: clock.now });
  const client = new GoogleTranslateClient(
    { apiKey: KEY, baseUrl: 'https://translation.googleapis.com/language/translate/v2', monthlyCharLimit: 450_000, timeoutMs: 2500, ...opts.config },
    { usage, breaker, fetchImpl: fn, now: () => new Date('2026-10-13T12:00:00Z'), sleep: noSleep, random: () => 0 }
  );
  return { client, calls, usage, breaker, clock };
}

describe('GoogleTranslateClient', () => {
  describe('request', () => {
    it('POSTs JSON with q as an array, en → vi, format=text', async () => {
      const { client, calls } = setup({ steps: [googleOk('Xin chào', 'Tạm biệt')] });
      await expect(client.translate(['hello', 'goodbye'])).resolves.toEqual(['Xin chào', 'Tạm biệt']);
      expect(calls).toHaveLength(1);
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ q: ['hello', 'goodbye'], source: 'en', target: 'vi', format: 'text' });
    });

    it('sends the key in a header and never in the URL', async () => {
      const { client, calls } = setup();
      await client.translate(['hello']);
      expect(calls[0].url).not.toContain(KEY);
      expect(calls[0].url).not.toContain('key=');
      expect((calls[0].init?.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    });

    it('returns [] for no input without calling anything', async () => {
      const { client, calls, usage } = setup();
      await expect(client.translate([])).resolves.toEqual([]);
      expect(calls).toHaveLength(0);
      expect(usage.reserve).not.toHaveBeenCalled();
    });

    it('rejects oversized input before reserving or calling', async () => {
      const { client, calls, usage } = setup();
      await expect(client.translate(Array.from({ length: 129 }, () => 'a'))).rejects.toThrow(RangeError);
      await expect(client.translate(['x'.repeat(30_001)])).rejects.toThrow(RangeError);
      expect(calls).toHaveLength(0);
      expect(usage.reserve).not.toHaveBeenCalled();
    });
  });

  describe('response handling', () => {
    it('decodes residual HTML entities and trims', async () => {
      const { client } = setup({ steps: [googleOk('  Đây là &quot;chó&quot; &amp; mèo&#39;s  ')] });
      await expect(client.translate(['x'])).resolves.toEqual(['Đây là "chó" & mèo\'s']);
    });

    it('keeps plain text with quotes and angle brackets untouched', async () => {
      const text = '<b>in đậm</b> và 5 < 6 > 3 "được trích dẫn"';
      const { client } = setup({ steps: [googleOk(text)] });
      await expect(client.translate(['x'])).resolves.toEqual([text]);
    });

    it('fails when the result array length does not match the input', async () => {
      const { client } = setup({ steps: [googleOk('one')] });
      const err = await client.translate(['a', 'b']).catch((e) => e);
      expect(err).toBeInstanceOf(UpstreamUnavailable);
      expect(err).toMatchObject({ reason: 'bad_response', status: 200 });
      expect(err.message).toContain('expected 2 translations, got 1');
    });

    it.each([
      ['not JSON', new Response('<html>oops</html>', { status: 200 })],
      ['no data.translations', jsonResponse(200, { data: {} })],
      ['a non-string translatedText', jsonResponse(200, { data: { translations: [{ translatedText: 5 }] } })],
    ])('treats %s as a bad response', async (_name, response) => {
      const { client } = setup({ steps: [response] });
      await expect(client.translate(['a'])).rejects.toMatchObject({ name: 'UpstreamUnavailable', reason: 'bad_response' });
    });
  });

  describe('error classification', () => {
    it('429 with Retry-After', async () => {
      const { client } = setup({ steps: [jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '12' })] });
      await expect(client.translate(['a'])).rejects.toMatchObject({ reason: 'rate_limited', status: 429, retryAfterMs: 12_000 });
    });

    it('429 without Retry-After', async () => {
      const { client } = setup({ steps: [jsonResponse(429, {})] });
      const err = await client.translate(['a']).catch((e) => e);
      expect(err).toMatchObject({ reason: 'rate_limited', status: 429 });
      expect(err.retryAfterMs).toBeUndefined();
    });

    it.each([500, 502, 503])('%i is UpstreamUnavailable(http_5xx) and is not retried', async (status) => {
      const { client, calls } = setup({ steps: [jsonResponse(status, {})] });
      await expect(client.translate(['a'])).rejects.toMatchObject({ reason: 'http_5xx', status });
      expect(calls).toHaveLength(1);
    });

    it.each([400, 401, 403])('%i is an UpstreamConfigError and is not retried', async (status) => {
      const { client, calls } = setup({ steps: [jsonResponse(status, { error: { message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } })] });
      const err = await client.translate(['a']).catch((e) => e);
      expect(err).toBeInstanceOf(UpstreamConfigError);
      expect(err.status).toBe(status);
      expect(err.message).toContain('API_KEY_INVALID');
      expect(calls).toHaveLength(1);
    });

    it('a timeout becomes UpstreamUnavailable(timeout)', async () => {
      const client = new GoogleTranslateClient(
        { apiKey: KEY, baseUrl: 'https://x.test/', monthlyCharLimit: 1000, timeoutMs: 20, maxAttempts: 1 },
        {
          usage: { reserve: async () => true, release: async () => undefined },
          breaker: new CircuitBreaker('google_translate', { failureThreshold: 5, resetMs: 1000 }),
          fetchImpl: hangingFetch,
        }
      );
      await expect(client.translate(['a'])).rejects.toMatchObject({ name: 'UpstreamUnavailable', reason: 'timeout' });
    });

    it('retries ONE transient network error, then succeeds, reserving the budget only once', async () => {
      const { client, calls, usage } = setup({ steps: [new TypeError('fetch failed'), googleOk('ok')] });
      await expect(client.translate(['hello'])).resolves.toEqual(['ok']);
      expect(calls).toHaveLength(2);
      expect(usage.reserve).toHaveBeenCalledTimes(1);
    });

    it('never puts the API key into an error message', async () => {
      const { client } = setup({ steps: [jsonResponse(403, { error: { message: `bad key ${KEY}` } })] });
      const err = await client.translate(['a']).catch((e) => e);
      expect(err.message).not.toContain(KEY);
      expect(err.message).toContain('<key>');
    });
  });

  describe('API key', () => {
    it.each([undefined, ''])('throws UpstreamConfigError without any network or budget use when the key is %p', async (apiKey) => {
      const { client, calls, usage } = setup({ config: { apiKey } });
      expect(client.enabled).toBe(false);
      await expect(client.translate(['hello'])).rejects.toBeInstanceOf(UpstreamConfigError);
      expect(calls).toHaveLength(0);
      expect(usage.reserve).not.toHaveBeenCalled();
    });
  });

  describe('monthly character budget', () => {
    it('reserves the TOTAL length of all strings for the current UTC month', async () => {
      const { client, usage } = setup({ steps: [googleOk('a', 'b')] });
      await client.translate(['hello', 'abc']);
      expect(usage.reserve).toHaveBeenCalledWith('google_translate', 'chars', '2026-10', 8, 450_000);
    });

    it('throws BudgetExceeded and does not call Google when the limit would be exceeded', async () => {
      const { client, calls, breaker } = setup({ reserve: false });
      const err = await client.translate(['hello']).catch((e) => e);
      expect(err).toBeInstanceOf(BudgetExceeded);
      expect(err.reason).toBe('monthly_chars');
      expect(calls).toHaveLength(0);
      expect(breaker.snapshot().consecutiveFailures).toBe(0); // a spent budget is not an outage
    });

    it('gives the characters back when Google rejected the request (5xx, 429, config error)', async () => {
      for (const response of [jsonResponse(503, {}), jsonResponse(429, {}), jsonResponse(403, {})]) {
        const { client, usage } = setup({ steps: [response] });
        await client.translate(['hello']).catch(() => undefined);
        expect(usage.release).toHaveBeenCalledWith('google_translate', 'chars', '2026-10', 5);
      }
    });

    it('keeps the reservation when the outcome is unknown (timeout / bad body)', async () => {
      const { client, usage } = setup({ steps: [googleOk('one')] });
      await client.translate(['a', 'b']).catch(() => undefined); // length mismatch: Google processed it
      expect(usage.release).not.toHaveBeenCalled();
    });
  });

  describe('circuit breaker', () => {
    it('opens after repeated failures and then neither reserves budget nor calls Google', async () => {
      const { client, calls, usage, breaker } = setup({ steps: [jsonResponse(503, {})], threshold: 2 });
      await client.translate(['a']).catch(() => undefined);
      await client.translate(['a']).catch(() => undefined);
      expect(breaker.currentState()).toBe('open');

      calls.length = 0;
      usage.reserve.mockClear();
      await expect(client.translate(['a'])).rejects.toMatchObject({ reason: 'breaker_open' });
      expect(calls).toHaveLength(0);
      expect(usage.reserve).not.toHaveBeenCalled();
    });

    it('a 403 (config error) opens the circuit at once', async () => {
      const { client, breaker } = setup({ steps: [jsonResponse(403, {})] });
      await client.translate(['a']).catch(() => undefined);
      expect(breaker.currentState()).toBe('open');
    });
  });
});
