/**
 * Word translation fallback — POST /api/v1/ebooks/:id/lookup behavior when
 * a word is not in `dictionary_entries`.
 *
 * Strategy: stub `global.fetch` per-test so the real service paths run end-to-end
 * (cache lookup, parallel calls, INSERT) but external HTTP is deterministic + fast.
 *
 * Module-level mocking of `services/wordTranslationService` does NOT work here
 * because `translateWord` calls `callGoogleTranslate` / `callFreeDictionary`
 * via local references, not via the exports object — Jest module mocks would
 * be silently bypassed.
 */
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { normalizeWord } from '../services/wordTranslationService';

const TS = Date.now();
const EMAIL = `wordtrans-${TS}@example.com`;
// Suffix is digit-free so it passes normalizeWord's letter-only rule.
const SUFFIX = `xq${TS.toString(36).replace(/\d/g, 'a')}`;
const FALLBACK_WORD = `xtfallback${SUFFIX}`;
const ANOTHER_FALLBACK = `ytfallback${SUFFIX}`;
const DISABLED_WORD = `disabled${SUFFIX}`;

let access_token = '';
let userId = '';
let ebookId = '';
let dictWord = '';
let dictEntryId = '';
let originalFallbackEnv: string | undefined;
let originalApiKey: string | undefined;
let originalFetch: typeof global.fetch;

beforeAll(async () => {
  originalFallbackEnv = process.env.TRANSLATION_FALLBACK_ENABLED;
  originalApiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  originalFetch = global.fetch;

  process.env.TRANSLATION_FALLBACK_ENABLED = 'true';
  process.env.GOOGLE_TRANSLATE_API_KEY = 'test-fake-key';

  const reg = await request(app).post('/api/v1/auth/register').send({
    email: EMAIL,
    password: 'password123',
    full_name: 'WordTrans Tester',
  });
  if (reg.status !== 201) throw new Error(`Register failed: ${JSON.stringify(reg.body)}`);
  access_token = reg.body.data.access_token;

  const { rows: uRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
  userId = uRows[0].id;

  const { rows: [eb] } = await pool.query(
    `INSERT INTO ebooks (title, author, level, required_plan, status, epub_file_url)
     VALUES ($1, 'Author', 'beginner', 'free', 'published', '/test.epub')
     RETURNING id`,
    [`WordTrans Ebook ${TS}`]
  );
  ebookId = eb.id;

  dictWord = `wtword${SUFFIX}`;
  const { rows: [ent] } = await pool.query(
    `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, published, source)
     VALUES ($1, $1, $2, 'nhà', TRUE, 'manual')
     RETURNING id`,
    [dictWord, ['noun']]
  );
  dictEntryId = ent.id;
});

afterAll(async () => {
  global.fetch = originalFetch;

  await pool.query(`DELETE FROM word_translation_cache WHERE word = ANY($1::text[])`, [
    [FALLBACK_WORD.toLowerCase(), ANOTHER_FALLBACK.toLowerCase(), DISABLED_WORD.toLowerCase()],
  ]);
  await pool.query(`DELETE FROM dictionary_entries WHERE id = $1`, [dictEntryId]);
  await pool.query(`DELETE FROM ebooks WHERE id = $1`, [ebookId]);
  await pool.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);

  if (originalFallbackEnv === undefined) delete process.env.TRANSLATION_FALLBACK_ENABLED;
  else process.env.TRANSLATION_FALLBACK_ENABLED = originalFallbackEnv;

  if (originalApiKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
  else process.env.GOOGLE_TRANSLATE_API_KEY = originalApiKey;

  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Fetch stub helpers
// ─────────────────────────────────────────────────────────────────────────────

interface StubResponse {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

/** Build a minimal fake Response for fetch stubs. */
function fakeResponse(body: unknown, status = 200): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

/**
 * Install a fetch stub that routes by URL substring.
 *  - googleBody / googleStatus → for translation.googleapis.com
 *  - freeDictBody / freeDictStatus → for api.dictionaryapi.dev
 */
function stubFetch(opts: {
  google?: { body: unknown; status?: number } | 'reject';
  freeDict?: { body: unknown; status?: number } | 'reject';
}) {
  const fetchFn = jest.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('translation.googleapis.com')) {
      if (opts.google === 'reject') throw new Error('network down');
      if (!opts.google) return fakeResponse({}, 200);
      return fakeResponse(opts.google.body, opts.google.status ?? 200);
    }
    if (u.includes('api.dictionaryapi.dev')) {
      if (opts.freeDict === 'reject') throw new Error('network down');
      if (!opts.freeDict) return fakeResponse([], 404);
      return fakeResponse(opts.freeDict.body, opts.freeDict.status ?? 200);
    }
    throw new Error(`Unexpected fetch URL: ${u}`);
  });
  // Cast through unknown — our stub doesn't implement the full Response interface
  // but the service only reads `.ok`, `.status`, `.text()`, `.json()`.
  global.fetch = fetchFn as unknown as typeof global.fetch;
  return fetchFn;
}

beforeEach(() => {
  global.fetch = originalFetch; // reset between tests
});

// ─────────────────────────────────────────────────────────────────────────────
//  normalizeWord — pure unit
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeWord', () => {
  test('strips trailing punctuation, preserves display casing', () => {
    const r = normalizeWord('Least,');
    expect(r.isValid).toBe(true);
    expect(r.display).toBe('Least');
    expect(r.normalized).toBe('least');
  });

  test('rejects empty / whitespace-only', () => {
    expect(normalizeWord('').isValid).toBe(false);
    expect(normalizeWord('   ').isValid).toBe(false);
  });

  test('rejects digits', () => {
    expect(normalizeWord('123').isValid).toBe(false);
    expect(normalizeWord('abc123').isValid).toBe(false);
  });

  test('rejects symbols', () => {
    expect(normalizeWord('hello@world').isValid).toBe(false);
  });

  test('accepts hyphens and apostrophes inside word', () => {
    expect(normalizeWord("don't").isValid).toBe(true);
    expect(normalizeWord('well-being').isValid).toBe(true);
  });

  test('rejects words longer than 50 chars', () => {
    expect(normalizeWord('a'.repeat(51)).isValid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  /lookup — dictionary path
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /lookup — dictionary source', () => {
  test('returns source=dictionary with EntryDetail fields flat', async () => {
    const fetchStub = stubFetch({});

    const res = await request(app)
      .post(`/api/v1/ebooks/${ebookId}/lookup`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ word: dictWord });

    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('dictionary');
    expect(res.body.data.headword).toBe(dictWord);
    expect(res.body.data.id).toBe(dictEntryId);
    expect(res.body.data.lookup_context).toEqual({
      source: 'ebook',
      ebook_id: ebookId,
      paragraph_id: null,
    });
    // No external calls on dictionary path.
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('inserts word_lookups row with lookup_result=dictionary, entry_id set', async () => {
    stubFetch({});
    await request(app)
      .post(`/api/v1/ebooks/${ebookId}/lookup`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ word: dictWord });

    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await pool.query(
      `SELECT entry_id, word_text, lookup_result FROM word_lookups
        WHERE user_id = $1 AND lookup_result = 'dictionary' AND word_text = $2
        ORDER BY created_at DESC LIMIT 1`,
      [userId, dictWord]
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].entry_id).toBe(dictEntryId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  /lookup — translation path
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /lookup — translation source', () => {
  test('cache miss: parallel calls, returns source=translation cached=false', async () => {
    const fetchStub = stubFetch({
      google: {
        body: { data: { translations: [{ translatedText: 'từ thử nghiệm' }] } },
      },
      freeDict: {
        body: [
          {
            phonetic: '/test/',
            phonetics: [{ text: '/test/', audio: 'https://example.com/test.mp3' }],
            meanings: [
              {
                partOfSpeech: 'noun',
                definitions: [{ definition: 'A test word.', example: 'This is a test.' }],
              },
            ],
          },
        ],
      },
    });

    const res = await request(app)
      .post(`/api/v1/ebooks/${ebookId}/lookup`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ word: FALLBACK_WORD });

    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('translation');
    expect(res.body.data.translation_vi).toBe('từ thử nghiệm');
    expect(res.body.data.phonetic).toBe('/test/');
    expect(res.body.data.audio_url).toBe('https://example.com/test.mp3');
    expect(res.body.data.pos).toBe('noun');
    expect(res.body.data.definitions_en).toEqual(['A test word.']);
    expect(res.body.data.providers).toEqual(
      expect.arrayContaining(['google_translate', 'free_dictionary_api'])
    );
    expect(res.body.data.cached).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  test('cache hit on second call: cached=true, no external calls', async () => {
    // Sanity: cache row should exist from previous test.
    const { rows: cached } = await pool.query(
      `SELECT word FROM word_translation_cache WHERE word = $1`,
      [FALLBACK_WORD.toLowerCase()]
    );
    expect(cached.length).toBe(1);

    const fetchStub = stubFetch({});
    const res = await request(app)
      .post(`/api/v1/ebooks/${ebookId}/lookup`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ word: FALLBACK_WORD });

    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('translation');
    expect(res.body.data.cached).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('inserts word_lookups row with lookup_result=translation, entry_id=NULL', async () => {
    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await pool.query(
      `SELECT entry_id, word_text, lookup_result FROM word_lookups
        WHERE user_id = $1 AND word_text = $2 AND lookup_result = 'translation'
        ORDER BY created_at DESC LIMIT 1`,
      [userId, FALLBACK_WORD]
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].entry_id).toBeNull();
  });

  test('punctuation around word still hits translation cache (normalize first)', async () => {
    const fetchStub = stubFetch({});
    const res = await request(app)
      .post(`/api/v1/ebooks/${ebookId}/lookup`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ word: `${FALLBACK_WORD},` });

    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('translation');
    expect(res.body.data.cached).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  /lookup — error paths
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /lookup — errors', () => {
  test('400 INVALID_WORD for empty', async () => {
    const res = await request(app)
      .post(`/api/v1/ebooks/${ebookId}/lookup`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ word: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_WORD');
  });

  test('400 INVALID_WORD for digits-only', async () => {
    const res = await request(app)
      .post(`/api/v1/ebooks/${ebookId}/lookup`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ word: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_WORD');
  });

  test('503 TRANSLATION_UNAVAILABLE when both providers fail', async () => {
    stubFetch({
      google: 'reject',
      freeDict: 'reject',
    });

    const res = await request(app)
      .post(`/api/v1/ebooks/${ebookId}/lookup`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ word: ANOTHER_FALLBACK });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TRANSLATION_UNAVAILABLE');

    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await pool.query(
      `SELECT lookup_result FROM word_lookups
        WHERE user_id = $1 AND word_text = $2
        ORDER BY created_at DESC LIMIT 1`,
      [userId, ANOTHER_FALLBACK]
    );
    expect(rows[0]?.lookup_result).toBe('not_found');
  });

  test('404 ENTRY_NOT_FOUND when TRANSLATION_FALLBACK_ENABLED is off', async () => {
    process.env.TRANSLATION_FALLBACK_ENABLED = 'false';
    const fetchStub = stubFetch({});
    try {
      const res = await request(app)
        .post(`/api/v1/ebooks/${ebookId}/lookup`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ word: DISABLED_WORD });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ENTRY_NOT_FOUND');
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      process.env.TRANSLATION_FALLBACK_ENABLED = 'true';
    }
  });
});
