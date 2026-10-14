import * as fs from 'fs';
import * as path from 'path';
import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';
import {
  accentFromAudioUrl,
  FreeDictionaryClient,
  normalizeFreeDictionaryResponse,
} from '../../services/upstream/freeDictionaryClient';
import { TokenBucket } from '../../services/upstream/tokenBucket';
import { fakeClock, hangingFetch, htmlResponse, jsonResponse, noSleep, scriptedFetch, Step } from './helpers';

const FIXTURES = path.resolve(__dirname, '../fixtures/lookup/free-dictionary');
const fixture = (word: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${word}.json`), 'utf8'));
const fixtureResponse = (word: string) => jsonResponse(200, fixture(word).body);

// The API's JSON "not found" body as documented at https://dictionaryapi.dev (the live service could not be
// made to return it during capture — every attempt hit a Cloudflare 522 — see docs/lookup-api-notes.md).
const NOT_FOUND_BODY = {
  title: 'No Definitions Found',
  message: "Sorry pal, we couldn't find definitions for the word you were looking for.",
  resolution: 'You can try the search again at later time or head to the web instead.',
};

function setup(opts: { steps?: Step[]; capacity?: number; threshold?: number } = {}) {
  const { fn, calls } = scriptedFetch(opts.steps ?? [fixtureResponse('hello')]);
  const clock = fakeClock();
  const breaker = new CircuitBreaker('free_dictionary', { failureThreshold: opts.threshold ?? 5, resetMs: 30_000, now: clock.now });
  const bucket = new TokenBucket({ capacity: opts.capacity ?? 400, windowMs: 300_000, now: clock.now });
  const client = new FreeDictionaryClient(
    { baseUrl: 'https://api.dictionaryapi.dev/api/v2/entries/en', timeoutMs: 2500 },
    { breaker, bucket, fetchImpl: fn, sleep: noSleep, random: () => 0 }
  );
  return { client, calls, breaker, bucket, clock };
}

describe('accentFromAudioUrl', () => {
  it.each([
    ['https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3', 'uk'],
    ['https://api.dictionaryapi.dev/media/pronunciations/en/ran-us.mp3', 'us'],
    ['https://api.dictionaryapi.dev/media/pronunciations/en/hello-au.mp3', 'au'],
    ['https://x.test/en/Run-US.MP3?cache=1', 'us'],
    ['https://x.test/en/cheese.mp3', null],
    ['', null],
  ])('%s → %p', (url, accent) => {
    expect(accentFromAudioUrl(url)).toBe(accent);
  });
});

describe('normalizeFreeDictionaryResponse (real captures)', () => {
  it('hello: separates UK audio from the Australian recording and keeps unlabeled IPA out of us/uk', () => {
    const entry = normalizeFreeDictionaryResponse(fixture('hello').body, 'hello')!;
    expect(entry.headword).toBe('hello');
    expect(entry.ipa).toEqual({ us: null, uk: '/həˈləʊ/', any: '/həˈləʊ/' });
    expect(entry.audio.uk).toBe('https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3');
    expect(entry.audio.us).toBeNull();
    // `any` falls back to the first recording even though it is Australian
    expect(entry.audio.any).toBe('https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3');
    expect(entry.pos).toEqual(['noun', 'verb', 'interjection']);
    expect(entry.license).toEqual({ name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0' });
    expect(entry.sourceUrls).toEqual(['https://en.wiktionary.org/wiki/hello']);
  });

  it('hello: flattens definitions in order, with examples and meaning-level synonyms/antonyms', () => {
    const { senses } = normalizeFreeDictionaryResponse(fixture('hello').body, 'hello')!;
    expect(senses.map((s) => s.pos)).toEqual(['noun', 'verb', 'interjection', 'interjection', 'interjection']);
    expect(senses[0]).toEqual({ pos: 'noun', definition: '"Hello!" or an equivalent greeting.', example: null, synonyms: ['greeting'], antonyms: [] });
    expect(senses[2].example).toBe('Hello, everyone.');
    expect(senses[2].antonyms).toEqual(['bye', 'goodbye']);
  });

  it('ubiquitous: labels US and UK from the audio file names', () => {
    const entry = normalizeFreeDictionaryResponse(fixture('ubiquitous').body, 'ubiquitous')!;
    expect(entry.ipa.us).toBe('/juˈbɪk.wɪ.təs/');
    expect(entry.ipa.uk).toBe('/juːˈbɪk.wə.təs/');
    expect(entry.ipa.any).toBe('/juˈbɪk.wɪ.təs/'); // prefers US
    expect(entry.audio.us).toMatch(/ubiquitous-us\.mp3$/);
    expect(entry.audio.uk).toMatch(/ubiquitous-uk\.mp3$/);
    expect(entry.pos).toEqual(['adjective']);
    expect(entry.senses[0].synonyms).toEqual(expect.arrayContaining(['common', 'pervasive', 'ever-present', 'omnipresent']));
  });

  it('ran: merges the three entries that share the headword into one', () => {
    const body = fixture('ran').body;
    expect(body).toHaveLength(3);
    const entry = normalizeFreeDictionaryResponse(body, 'ran')!;
    expect(entry.headword).toBe('ran');
    expect(entry.pos).toEqual(['verb', 'noun']);
    expect(entry.ipa.us).toBe('/ɹæn/');
    expect(entry.audio.us).toMatch(/ran-us\.mp3$/);
    expect(entry.sourceUrls).toEqual(expect.arrayContaining(['https://en.wiktionary.org/wiki/ran', 'https://en.wiktionary.org/wiki/run']));
    expect(new Set(entry.sourceUrls).size).toBe(entry.sourceUrls.length); // de-duplicated
    expect(entry.senses.length).toBeGreaterThan(3);
  });

  it('only merges entries with the same headword and prefers the requested one', () => {
    const raw = [
      { word: 'colour', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A hue.' }] }] },
      { word: 'color', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'US spelling.' }] }] },
    ];
    expect(normalizeFreeDictionaryResponse(raw, 'color')!.senses.map((s) => s.definition)).toEqual(['US spelling.']);
    expect(normalizeFreeDictionaryResponse(raw, 'other')!.headword).toBe('colour');
  });

  it('copes with missing optional fields', () => {
    const entry = normalizeFreeDictionaryResponse([{ word: 'x', meanings: [{ definitions: [{ definition: ' d ' }, { definition: '   ' }] }] }], 'x')!;
    expect(entry).toMatchObject({ headword: 'x', ipa: { us: null, uk: null, any: null }, audio: { us: null, uk: null, any: null }, license: null, sourceUrls: [] });
    expect(entry.senses).toEqual([{ pos: '', definition: 'd', example: null, synonyms: [], antonyms: [] }]);
  });

  it('returns null for an empty or garbage array', () => {
    expect(normalizeFreeDictionaryResponse([], 'x')).toBeNull();
    expect(normalizeFreeDictionaryResponse([null, 3, { word: '' }], 'x')).toBeNull();
  });
});

describe('FreeDictionaryClient.lookup', () => {
  it('GETs BASE_URL/<encoded word> and returns the normalized entry', async () => {
    const { client, calls } = setup();
    const result = await client.lookup('hello');
    expect(calls[0].url).toBe('https://api.dictionaryapi.dev/api/v2/entries/en/hello');
    expect(calls[0].init?.method).toBe('GET');
    expect(result).toMatchObject({ found: true, entry: { headword: 'hello' } });
  });

  it('URL-encodes the word', async () => {
    const { client, calls } = setup();
    await client.lookup('ice cream/x');
    expect(calls[0].url).toBe('https://api.dictionaryapi.dev/api/v2/entries/en/ice%20cream%2Fx');
  });

  it('a JSON 404 means "not found": no throw, and the breaker sees a healthy provider', async () => {
    const { client, breaker } = setup({ steps: [jsonResponse(404, NOT_FOUND_BODY)], threshold: 1 });
    for (let i = 0; i < 3; i++) await expect(client.lookup('asdfghjk')).resolves.toEqual({ found: false });
    expect(breaker.currentState()).toBe('closed');
  });

  it('an empty 200 array also means "not found"', async () => {
    const { client } = setup({ steps: [jsonResponse(200, [])] });
    await expect(client.lookup('x')).resolves.toEqual({ found: false });
  });

  it('an HTML 404 page (CDN anomaly seen for "run") is NOT "not found" and does not trip the breaker', async () => {
    const { client, breaker } = setup({ steps: [htmlResponse(404)], threshold: 1 });
    for (let i = 0; i < 3; i++) {
      const err = await client.lookup('run').catch((e) => e);
      expect(err).toBeInstanceOf(UpstreamUnavailable);
      expect(err).toMatchObject({ reason: 'bad_response', status: 404, affectsBreaker: false });
    }
    expect(breaker.currentState()).toBe('closed');
  });

  it('429 with Retry-After', async () => {
    const { client } = setup({ steps: [jsonResponse(429, {}, { 'retry-after': '30' })] });
    await expect(client.lookup('x')).rejects.toMatchObject({ name: 'UpstreamUnavailable', reason: 'rate_limited', retryAfterMs: 30_000 });
  });

  it('429 without Retry-After', async () => {
    const { client } = setup({ steps: [jsonResponse(429, {})] });
    const err = await client.lookup('x').catch((e) => e);
    expect(err).toMatchObject({ reason: 'rate_limited', status: 429 });
    expect(err.retryAfterMs).toBeUndefined();
  });

  it.each([500, 503, 522])('%i is UpstreamUnavailable(http_5xx)', async (status) => {
    const { client } = setup({ steps: [new Response('error code: ' + status, { status })] });
    await expect(client.lookup('x')).rejects.toMatchObject({ reason: 'http_5xx', status });
  });

  it('401/403 are configuration errors', async () => {
    const { client } = setup({ steps: [jsonResponse(403, {})] });
    await expect(client.lookup('x')).rejects.toBeInstanceOf(UpstreamConfigError);
  });

  it('a timeout is retried once, then reported as UpstreamUnavailable(timeout)', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 10, windowMs: 1000, now: clock.now });
    const client = new FreeDictionaryClient(
      { baseUrl: 'https://x.test/en', timeoutMs: 20 },
      { breaker: new CircuitBreaker('free_dictionary', { failureThreshold: 5, resetMs: 1000 }), bucket, fetchImpl: hangingFetch, sleep: noSleep, random: () => 0 }
    );
    await expect(client.lookup('x')).rejects.toMatchObject({ reason: 'timeout' });
    expect(bucket.available()).toBe(8); // two real attempts → two tokens
  });

  it('retries one network error and then succeeds', async () => {
    const { client, calls } = setup({ steps: [new TypeError('fetch failed'), fixtureResponse('hello')] });
    await expect(client.lookup('hello')).resolves.toMatchObject({ found: true });
    expect(calls).toHaveLength(2);
  });

  it('a non-JSON or non-array 200 is a bad response', async () => {
    for (const step of [new Response('<html/>', { status: 200 }), jsonResponse(200, { not: 'an array' })]) {
      const { client } = setup({ steps: [step] });
      await expect(client.lookup('x')).rejects.toMatchObject({ reason: 'bad_response', status: 200 });
    }
  });

  it('rejects an empty word', async () => {
    const { client, calls } = setup();
    await expect(client.lookup('  ')).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  describe('internal token bucket', () => {
    it('refuses with local_rate_limit (no network call) once the budget is spent', async () => {
      const { client, calls } = setup({ capacity: 2 });
      await client.lookup('hello');
      await client.lookup('hello');
      const err = await client.lookup('hello').catch((e) => e);
      expect(err).toBeInstanceOf(UpstreamUnavailable);
      expect(err.reason).toBe('local_rate_limit');
      expect(err.retryAfterMs).toBeGreaterThan(0);
      expect(calls).toHaveLength(2);
    });

    it('our own limit never counts against the breaker', async () => {
      const { client, breaker } = setup({ capacity: 1, threshold: 1 });
      await client.lookup('hello');
      for (let i = 0; i < 3; i++) await client.lookup('hello').catch(() => undefined);
      expect(breaker.currentState()).toBe('closed');
    });

    it('refills over time', async () => {
      const { client, clock } = setup({ capacity: 1 });
      await client.lookup('hello');
      await expect(client.lookup('hello')).rejects.toMatchObject({ reason: 'local_rate_limit' });
      clock.advance(300_000);
      await expect(client.lookup('hello')).resolves.toMatchObject({ found: true });
    });
  });

  describe('circuit breaker', () => {
    it('opens after repeated 5xx, then fails fast without any request or token use', async () => {
      const { client, calls, breaker, bucket } = setup({ steps: [new Response('', { status: 522 })], threshold: 2 });
      await client.lookup('a').catch(() => undefined);
      await client.lookup('b').catch(() => undefined);
      expect(breaker.currentState()).toBe('open');

      const callsBefore = calls.length;
      const tokensBefore = bucket.available();
      await expect(client.lookup('c')).rejects.toMatchObject({ reason: 'breaker_open' });
      expect(calls).toHaveLength(callsBefore);
      expect(bucket.available()).toBe(tokensBefore);
    });

    it('half-opens after the reset time and recovers on a good answer', async () => {
      const { client, breaker, clock } = setup({ steps: [new Response('', { status: 522 }), new Response('', { status: 522 }), fixtureResponse('hello')], threshold: 2 });
      await client.lookup('a').catch(() => undefined);
      await client.lookup('b').catch(() => undefined);
      expect(breaker.currentState()).toBe('open');
      clock.advance(30_000);
      await expect(client.lookup('hello')).resolves.toMatchObject({ found: true });
      expect(breaker.currentState()).toBe('closed');
    });
  });
});
