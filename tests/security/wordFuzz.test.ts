/**
 * The word cleaner (F1) under hostile input (docs/lookup-spec.md §12.3): random strings, a list of nasty ones, and strings
 * built to make a regular expression crawl. Whatever comes in, the result is a 400 or a safe, normalized word, and it is
 * computed in linear time. Also over HTTP, through the real route, to see what actually reaches the database and the upstreams.
 */
import { normalizeWord, stripEdges } from '../../services/wordTranslationService';
import { bootLookupApp, type LookupApp } from '../helpers/lookupApp';

jest.setTimeout(180_000);

// ── the reference: the ORIGINAL implementation (regex based), used to prove the linear one behaves identically ──
const OLD_STRIP_RE = /^[\s.,!?;:'"()\[\]‘’“”]+|[\s.,!?;:'"()\[\]‘’“”]+$/g;
const OLD_WORD_REGEX = /^[A-Za-z]+(?:[-'][A-Za-z]+)*$/;
function oldNormalize(raw: string): { isValid: boolean; normalized: string } {
  const stripped = raw.replace(OLD_STRIP_RE, '');
  if (stripped.length === 0 || stripped.length > 50 || !OLD_WORD_REGEX.test(stripped)) return { isValid: false, normalized: '' };
  return { isValid: true, normalized: stripped.toLowerCase() };
}

// ── deterministic randomness ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABETS: string[][] = [
  [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  [...'0123456789'],
  [...`.,!?;:'"()[]{}<>/\\|@#$%^&*_+=~\`-`],
  [' ', '\t', '\n', '\r', '\v', '\f', ' ', ' ', '　', ' ', ' '],
  Array.from({ length: 33 }, (_, i) => String.fromCharCode(i === 32 ? 0x7f : i)), // control characters
  [...'éèêëàâäôöûüçñßøåæœİıŁł'], // Latin letters with marks
  [...'你好こんにちは안녕Привет مرحبا שלום'],
  ['\u202e', '\u202d', '\u202a', '\u200b', '\u200c', '\u200d', '\u200f', '\u2028', '\u2029', '\ufeff'], // bidi and zero-width
  ['́', '̈', '̧'], // combining marks
  ['😀', '🔥', '𝒽', '𝓮', 'ｈ', 'ｅ'], // astral and fullwidth
  ["'", '-', "'", '-', 'a', 'b'], // the two characters a word may contain inside
  ['%00', '%2e', '%2f', '..', '../', '..\\', '${', '{{', '}}', "'; DROP TABLE users;--", ' OR 1=1', '<script>', '</data>'],
];

function randomString(rand: () => number): string {
  const parts = 1 + Math.floor(rand() * 8);
  let s = '';
  for (let i = 0; i < parts; i++) {
    const alphabet = ALPHABETS[Math.floor(rand() * ALPHABETS.length)];
    const len = 1 + Math.floor(rand() * 12);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return s;
}

const NASTY: string[] = [
  '',
  ' ',
  '\u0000',
  'a\u0000b',
  'hello\u0000',
  '../',
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '%00',
  'hello%00',
  '%2e%2e%2f',
  '%252e%252e%252f',
  "'; DROP TABLE users;--",
  "x' OR '1'='1",
  '1 OR 1=1',
  'a;b',
  '${7*7}',
  '{{7*7}}',
  '<script>alert(1)</script>',
  '</data>',
  'a%0d%0aSet-Cookie: x=1',
  'hello\r\nHost: evil',
  '\u202ehello',
  'hel\u202elo',
  'hello\u200b',
  'hel\u200blo',
  'ｈｅｌｌｏ',
  '𝒽ello',
  'helló',
  'İstanbul',
  'straße',
  'x'.repeat(51),
  'x'.repeat(10_000),
  '-hello',
  'hello-',
  "'hello",
  'hel--lo',
  "hel''lo",
  "-'-",
  'two words',
  'tab\tseparated',
  'null',
  'undefined',
  'NaN',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
];

const SAFE_NORMALIZED = /^[a-z]+(?:[-'][a-z]+)*$/;
const SAFE_VALID_INPUTS: Array<[string, string]> = [
  ['hello', 'hello'],
  ['Hello', 'hello'],
  ['  "Don\'t!" ', "don't"],
  ['well-being', 'well-being'],
  ["O'Brien", "o'brien"],
  ['(running)', 'running'],
  ['‘quoted’', 'quoted'],
  ['hello\n', 'hello'],
  [' hello ', 'hello'],
];

describe('normalizeWord: the contract', () => {
  it.each(SAFE_VALID_INPUTS)('%j → %j', (raw, expected) => {
    expect(normalizeWord(raw)).toMatchObject({ isValid: true, normalized: expected });
  });

  it.each(NASTY.map((s) => [s.length > 40 ? `${s.slice(0, 20)}… (${s.length} chars)` : JSON.stringify(s), s]))('nasty input %s is invalid or safe', (_label, raw) => {
    const r = normalizeWord(raw as string);
    if (r.isValid) {
      expect(r.normalized).toMatch(SAFE_NORMALIZED);
      expect(r.normalized.length).toBeLessThanOrEqual(50);
    } else {
      expect(r.normalized).toBe('');
    }
  });

  it('refuses everything that is not a string', () => {
    for (const v of [undefined, null, 42, true, {}, [], ['hello'], () => 'hello', Symbol('x')] as unknown[]) {
      expect(normalizeWord(v as any)).toMatchObject({ isValid: false, normalized: '' });
    }
  });

  it('300 random strings: invalid, or a short lowercase word made of letters, hyphens and apostrophes — and the same verdict as the original implementation', () => {
    const rand = mulberry32(20261015);
    let valid = 0;
    for (let i = 0; i < 300; i++) {
      const raw = randomString(rand);
      const r = normalizeWord(raw);
      const old = oldNormalize(raw);
      expect({ raw, isValid: r.isValid, normalized: r.normalized }).toEqual({ raw, isValid: old.isValid, normalized: old.normalized });
      if (r.isValid) {
        valid++;
        expect(r.normalized).toMatch(SAFE_NORMALIZED);
        expect(r.normalized).toBe(r.display.toLowerCase());
        expect(/[\u0000-\u001f\u007f\s]/.test(r.display)).toBe(false);
      } else {
        expect(r.normalized).toBe('');
      }
    }
    expect(valid).toBeGreaterThan(0); // the generator does produce some valid words, so the property above is not vacuous
  });

  it('2000 more random strings keep the same verdict as the original implementation (stripEdges is the same function, in linear time)', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const raw = randomString(rand);
      expect(stripEdges(raw)).toBe(raw.replace(OLD_STRIP_RE, ''));
    }
  });
});

describe('normalizeWord: linear time (it used to be quadratic on a run of spaces)', () => {
  const N = 1_000_000;
  const cases: Array<[string, string]> = [
    ['a, a million spaces, a', 'a' + ' '.repeat(N) + 'a'],
    ['a million spaces then punctuation then a letter', ' '.repeat(N) + '.' + 'a'],
    ['a million dots', '.'.repeat(N)],
    ['a million letters', 'a'.repeat(N)],
    ['a million letters and a bang', 'a'.repeat(N) + '!'],
    ['letters separated by hyphens, then a bang', 'a-'.repeat(N / 2) + '!'],
    ['alternating space and dot between two letters', 'a' + ' .'.repeat(N / 2) + 'a'],
    ['a million zero-width spaces', '\u200b'.repeat(N)],
    ['a million apostrophes', "'".repeat(N)],
  ];

  it.each(cases)('%s takes well under a second', (_label, raw) => {
    const started = Date.now();
    const r = normalizeWord(raw);
    expect(Date.now() - started).toBeLessThan(1000);
    // most of these are not words; "a million spaces, a dot, a" is simply the word "a" once the edges are stripped
    if (r.isValid) expect(r.normalized).toMatch(SAFE_NORMALIZED);
    else expect(r.normalized).toBe('');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('over HTTP, through the real route', () => {
  let a: LookupApp;
  const supertest = () => import('supertest').then((m) => m.default);

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    a = await bootLookupApp();
  });
  afterAll(async () => {
    await a.close();
    jest.restoreAllMocks();
  });

  it('every nasty word is a 400 INVALID_WORD or a normal answer; never a 500; nothing but safe words reaches an upstream', async () => {
    a.mock.reset();
    const statuses = new Map<number, number>();
    for (const raw of NASTY.filter((s) => s.length <= 10_000)) {
      const res = await a.lookup(raw);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      expect([200, 400, 404, 429, 503]).toContain(res.status);
      if (res.status === 400) expect(res.body.error.code).toBe('INVALID_WORD');
    }
    expect(statuses.get(500)).toBeUndefined();
    expect(statuses.get(400)).toBeGreaterThan(30);

    const requested = [...Object.keys(a.mock.stats().fd.byWord), ...Object.keys(a.mock.stats().google.byWord), ...Object.keys(a.mock.stats().datamuse.byWord)];
    for (const w of requested) expect(w).toMatch(SAFE_NORMALIZED);
  });

  it('150 random strings through the route: same guarantees', async () => {
    a.mock.reset();
    const rand = mulberry32(99);
    for (let i = 0; i < 150; i++) {
      const raw = randomString(rand);
      const res = await a.lookup(raw);
      expect([200, 400, 404, 429, 503]).toContain(res.status);
      if (res.status === 400) expect(res.body.error.code).toBe('INVALID_WORD');
    }
    for (const w of Object.keys(a.mock.stats().fd.byWord)) expect(w).toMatch(SAFE_NORMALIZED);
  });

  it('what is stored in word_lookups for these requests is a cleaned word, never the raw input', async () => {
    await new Promise((r) => setTimeout(r, 500));
    const { rows } = await a.pool.query(`SELECT word_text FROM word_lookups WHERE user_id = $1`, [a.user.id]);
    for (const r of rows) {
      expect(r.word_text.length).toBeLessThanOrEqual(50);
      expect(r.word_text).toMatch(/^[A-Za-z]+(?:[-'][A-Za-z]+)*$/);
    }
  });

  it('a body that is not a word at all: missing, wrong type, a huge word, a huge body', async () => {
    const st = await supertest();
    const post = (body: unknown) => st(a.app).post(`/api/v1/ebooks/${a.ebookId}/lookup`).set('Authorization', `Bearer ${a.user.token}`).send(body as any);

    for (const body of [{}, { word: null }, { word: 42 }, { word: ['hello'] }, { word: { toString: 'x' } }, { word: true }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WORD');
    }

    const started = Date.now();
    const huge = await post({ word: 'a' + ' '.repeat(900_000) + 'a' }); // fits the 1 MB body limit; the quadratic regex took minutes on it
    expect(huge.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(5000);

    const tooBig = await post({ word: 'a'.repeat(2 * 1024 * 1024) });
    expect([400, 413]).toContain(tooBig.status);

    const notJson = await st(a.app).post(`/api/v1/ebooks/${a.ebookId}/lookup`).set('Authorization', `Bearer ${a.user.token}`).set('content-type', 'application/json').send('{"word": ');
    expect([400]).toContain(notJson.status);
  });

  it('the server is still healthy afterwards', async () => {
    const res = await a.lookup('hello');
    expect([200, 404, 429, 503]).toContain(res.status);
  });
});
