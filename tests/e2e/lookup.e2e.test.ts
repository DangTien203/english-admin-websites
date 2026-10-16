/**
 * End-to-end tests of POST /api/v1/ebooks/:id/lookup over HTTP (docs/lookup-spec.md §4–§6, §11.8, §12.1).
 *
 * The real Express app, real middleware and a real PostgreSQL (the dev database, like every other suite); the three
 * external services are the mock upstream server (scripts/mock-upstream) on 127.0.0.1. No real service is called and no
 * real API key is configured. Everything created here is named "qzq<run>…" / "e2e-<run>-…" and removed at the end.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bootLookupApp, fixtureWord, type LookupApp } from '../helpers/lookupApp';
import type { EnqueueInput } from '../../services/lookup/enqueuer';

jest.setTimeout(60_000);

const CONTRACT = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/lookup/response-contract.json'), 'utf8'));

// Every console line of the app is captured: the structured `lookup` log is part of what is checked (spec §12.1).
const infoLines: Array<Record<string, any>> = [];
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation((line: unknown) => {
    try {
      infoLines.push(JSON.parse(String(line)));
    } catch {
      /* not a JSON log line */
    }
  });
});
afterAll(() => jest.restoreAllMocks());

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Every field of the contract is present with one of the allowed types. */
function expectContract(body: Record<string, unknown>, contract: Record<string, string>): void {
  for (const [field, allowed] of Object.entries(contract)) {
    expect(Object.prototype.hasOwnProperty.call(body, field)).toBe(true);
    expect(allowed.split('|')).toContain(typeOf(body[field]));
  }
}

const lookupRow = (a: LookupApp, word: string) =>
  a.waitFor(
    async () => (await a.pool.query(`SELECT lookup_result, entry_id FROM word_lookups WHERE user_id = $1 AND word_text = $2 ORDER BY created_at DESC LIMIT 1`, [a.user.id, word])).rows[0],
    `word_lookups row of ${word}`
  );

const noUpstreamCalls = (a: LookupApp) => expect(a.mock.stats().total).toBe(0);

async function insertEntry(a: LookupApp, headword: string, formValue?: string): Promise<string> {
  const { rows } = await a.pool.query(
    `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, published, source) VALUES ($1, $1, ARRAY['verb']::varchar[], 'chạy', TRUE, 'manual') RETURNING id`,
    [headword]
  );
  if (formValue) await a.pool.query(`INSERT INTO word_forms (entry_id, form_type, form_value) VALUES ($1, 'plural', $2)`, [rows[0].id, formValue]);
  return rows[0].id;
}

async function trustWord(a: LookupApp, word: string): Promise<void> {
  await a.pool.query(`INSERT INTO ref_word_frequency (word, zipf, rank) VALUES ($1, 1.0, 999999) ON CONFLICT (word) DO NOTHING`, [word]);
}

// ═════════════════════════════════════════════════════════════════════════════
describe('the merge matrix of spec §6, over HTTP', () => {
  let a: LookupApp;
  const enqueued: EnqueueInput[] = [];
  const w = {
    fg: fixtureWord('fg'), // F and G
    fNoG: fixtureWord('fnog'), // F, not G
    gFd404: fixtureWord('gfdfour'), // G and FD404
    gFdErr: fixtureWord('gfderr'), // G and FDerr
    noGFd404: fixtureWord('nogfdfour'), // not G, FD404
    noGFdErr: fixtureWord('nogfderr'), // not G, FDerr (a trusted word: the reference data knows it)
    noGFdErrUnknown: fixtureWord('nogfderru'), // not G, FDerr (nobody knows the word)
  };

  beforeAll(async () => {
    a = await bootLookupApp({ env: { ENRICHMENT_ENABLED: 'true', UPSTREAM_BREAKER_FAILURE_THRESHOLD: '100' } });
    a.setEnqueuer({
      enqueue: async (input) => {
        enqueued.push(input);
        return { status: 'queued' };
      },
    });
    await trustWord(a, w.noGFd404);
    await trustWord(a, w.noGFdErr);
    a.mock.setControl({
      rules: [
        { provider: 'google', words: [w.fNoG, w.noGFd404, w.noGFdErr, w.noGFdErrUnknown], behavior: { mode: 'status', status: 503 } },
        { provider: 'fd', words: [w.gFd404, w.noGFd404], behavior: { mode: 'not_found' } },
        { provider: 'fd', words: [w.gFdErr, w.noGFdErr, w.noGFdErrUnknown], behavior: { mode: 'status', status: 503 } },
      ],
    });
  });
  afterAll(() => a.close());
  beforeEach(() => {
    enqueued.length = 0;
  });

  it('F and G → 200 complete, nothing missing, a job is sent, word_lookups says translation', async () => {
    const res = await a.lookup(w.fg);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const d = res.body.data;
    expect(res.body.success).toBe(true);
    expect(d).toMatchObject({ source: 'translation', temporary: true, word: w.fg, headword: w.fg, partial: false, missing: [], cached: false });
    expect(d.translation_vi).toEqual(expect.any(String));
    expect(d.translation_vi.toLowerCase()).not.toBe(w.fg); // never the looked-up word itself
    expect(d.meanings_vi.length).toBeGreaterThan(0);
    expect(d.meanings_vi.length).toBeLessThanOrEqual(4);
    expect(d.pos_list.length).toBeGreaterThan(0);
    expect(d.ipa).toEqual(d.phonetic);
    expect(d.senses.length).toBeGreaterThan(0);
    expect(d.senses.length).toBeLessThanOrEqual(4);
    for (const s of d.senses) expect(s).toMatchObject({ pos: expect.any(String), definition_en: expect.any(String), definition_vi: expect.any(String), gloss_vi: expect.any(String) });
    expect(d.providers).toEqual(expect.arrayContaining(['google_translate', 'free_dictionary_api']));
    expect(d.attribution.length).toBeGreaterThan(0);
    expect(d.attribution[0]).toMatchObject({ name: expect.any(String), license: expect.any(String), url: expect.any(String) });
    expect(d.enrichment).toEqual({ status: 'queued' });
    expect(d.lookup_context).toEqual({ source: 'ebook', ebook_id: a.ebookId, paragraph_id: null });

    await a.settle(); // the job is sent after the answer
    expect(enqueued).toEqual([{ word: w.fg, requestedBy: a.user.id, ebookId: a.ebookId, startAfterSeconds: undefined }]);
    expect((await lookupRow(a, w.fg)).lookup_result).toBe('translation');
  });

  it('F, not G → 200 partial, translation_vi null, missing translation_vi (never the word itself)', async () => {
    const res = await a.lookup(w.fNoG);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ source: 'translation', partial: true, translation_vi: null, meanings_vi: [] });
    expect(d.missing).toContain('translation_vi');
    expect(d.pos_list.length).toBeGreaterThan(0);
    expect(d.senses.length).toBeGreaterThan(0);
    for (const s of d.senses) expect(s.definition_vi).toBeNull(); // step 2 needs the fast translator to have worked
    expect(d.providers).toEqual(['free_dictionary_api']);
    await a.settle();
    expect(enqueued.map((e) => e.word)).toEqual([w.fNoG]); // Free Dictionary knows it: a trusted word
    expect((await lookupRow(a, w.fNoG)).lookup_result).toBe('translation');
  });

  it('G and FD404 → 200 partial with pos, definition_en, ipa, audio_url missing; the job is only sent for a trusted word', async () => {
    const res = await a.lookup(w.gFd404);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.partial).toBe(true);
    expect(d.translation_vi).toEqual(expect.any(String));
    expect(d.missing).toEqual(expect.arrayContaining(['pos', 'definition_en', 'ipa', 'audio_url']));
    expect(d).toMatchObject({ pos: null, ipa: null, audio_url: null, pos_list: [], senses: [], attribution: [] });
    expect(d.enrichment).toEqual({ status: 'skipped', reason: 'unknown_word' });
    await a.settle();
    expect(enqueued).toEqual([]);
    expect((await lookupRow(a, w.gFd404)).lookup_result).toBe('translation');
  });

  it('G and FDerr → the same partial answer as FD404', async () => {
    const res = await a.lookup(w.gFdErr);
    expect(res.status).toBe(200);
    expect(res.body.data.partial).toBe(true);
    expect(res.body.data.translation_vi).toEqual(expect.any(String));
    expect(res.body.data.missing).toEqual(expect.arrayContaining(['pos', 'definition_en', 'ipa', 'audio_url']));
    expect((await lookupRow(a, w.gFdErr)).lookup_result).toBe('translation');
  });

  it('not G and FD404 → 404 ENTRY_NOT_FOUND, word_lookups not_found, NO job even for a word the reference data knows', async () => {
    const res = await a.lookup(w.noGFd404);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTRY_NOT_FOUND' } });
    expect(res.headers['cache-control']).toBe('no-store');
    await a.settle();
    expect(enqueued).toEqual([]);
    expect((await lookupRow(a, w.noGFd404)).lookup_result).toBe('not_found');
  });

  it('not G and FDerr → 503 TRANSLATION_UNAVAILABLE, not_found, and a trusted word gets a job that starts 60 s later', async () => {
    const res = await a.lookup(w.noGFdErr);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: { code: 'TRANSLATION_UNAVAILABLE' } });
    expect(res.headers['cache-control']).toBe('no-store');
    await a.settle();
    expect(enqueued).toEqual([{ word: w.noGFdErr, requestedBy: a.user.id, ebookId: a.ebookId, startAfterSeconds: 60 }]);
    expect((await lookupRow(a, w.noGFdErr)).lookup_result).toBe('not_found');
  });

  it('not G and FDerr, a word nobody knows → 503 and no job', async () => {
    const res = await a.lookup(w.noGFdErrUnknown);
    expect(res.status).toBe(503);
    await a.settle();
    expect(enqueued).toEqual([]);
    expect((await lookupRow(a, w.noGFdErrUnknown)).lookup_result).toBe('not_found');
  });

  // Spec 1.5: the job send and the word_lookups insert run after the answer. The sender below can only finish when the test lets it,
  // so an answer that waited for it would never arrive (the test would time out instead of passing).
  it('the answer does not wait for the job send, and word_lookups is still written', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: EnqueueInput[] = [];
    a.setEnqueuer({
      enqueue: async (input) => {
        sent.push(input);
        await gate;
        return { status: 'queued' };
      },
    });
    const word = fixtureWord('slowsend');
    try {
      const res = await a.lookup(word);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ source: 'translation', partial: false });
      expect(res.body.data.enrichment).toEqual({ status: 'queued' });
      await a.waitFor(async () => sent.length > 0, 'the background send to start');
      expect((await lookupRow(a, word)).lookup_result).toBe('translation'); // the insert does not queue behind the send either
    } finally {
      release();
      await a.settle();
      a.setEnqueuer({
        enqueue: async (input) => {
          enqueued.push(input);
          return { status: 'queued' };
        },
      });
    }
    expect(sent.map((s) => s.word)).toEqual([word]);
  });

  it('a send that throws leaves the answer and word_lookups alone and is reported as one structured error line', async () => {
    const errors = console.error as unknown as jest.Mock;
    a.setEnqueuer({
      enqueue: async () => {
        throw new Error('queue is down');
      },
    });
    const word = fixtureWord('sendfails');
    try {
      const before = errors.mock.calls.length;
      const res = await a.lookup(word);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ source: 'translation', partial: false, enrichment: { status: 'queued' } });
      await a.settle();
      expect((await lookupRow(a, word)).lookup_result).toBe('translation');
      const reported = errors.mock.calls
        .slice(before)
        .map((c) => {
          try {
            return JSON.parse(String(c[0]));
          } catch {
            return null;
          }
        })
        .filter((l) => l?.evt === 'lookup_background_error');
      expect(reported).toEqual([{ evt: 'lookup_background_error', task: 'enrich', word, error: 'queue is down' }]);
    } finally {
      a.setEnqueuer({
        enqueue: async (input) => {
          enqueued.push(input);
          return { status: 'queued' };
        },
      });
    }
  });

  it('writes one structured log line per lookup with the spec §12.1 fields and no external content', async () => {
    const word = fixtureWord('logline');
    const before = infoLines.length;
    await a.lookup(word);
    const line = infoLines.slice(before).find((l) => l.evt === 'lookup' && l.word === word);
    expect(line).toBeDefined();
    for (const field of ['evt', 'word', 'outcome', 'source', 'partial', 'latency_ms', 'google_ms', 'fd_ms', 'enrichment_status']) expect(line).toHaveProperty(field);
    expect(line).toMatchObject({ outcome: 'temporary', source: 'translation', partial: false, enrichment_status: 'queued' });
    expect(line!.latency_ms).toEqual(expect.any(Number));
    // nothing but statuses: no definition, translation or API key text
    expect(JSON.stringify(line)).not.toMatch(/định nghĩa|dịch |test-google-key|Hello/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('dictionary hits make no outside request (F4, F4b)', () => {
  let a: LookupApp;
  const headword = fixtureWord('run');
  const viaForm = fixtureWord('runs'); // a word_forms.form_value
  const inflected = fixtureWord('ran'); // only known through ref_wiktionary_en
  let entryId: string;

  beforeAll(async () => {
    a = await bootLookupApp();
    entryId = await insertEntry(a, headword, viaForm);
    await a.pool.query(
      `INSERT INTO ref_wiktionary_en (word, pos, etymology_number, lemma_of, data) VALUES ($1, 'verb', NULL, $2, $3::jsonb)`,
      [inflected, headword, JSON.stringify({ word: inflected, pos: 'verb', senses: [{ glosses: [`simple past of ${headword}`], tags: ['form-of', 'past'], form_of: [{ word: headword }] }] })]
    );
  });
  afterAll(() => a.close());
  beforeEach(() => a.mock.reset());

  it('headword → source dictionary, the entry, no matched_form, 0 outside requests', async () => {
    const res = await a.lookup(headword);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ source: 'dictionary', id: entryId, headword, lookup_context: { source: 'ebook', ebook_id: a.ebookId, paragraph_id: null } });
    expect(res.body.data).not.toHaveProperty('matched_form');
    expect(res.headers['cache-control']).not.toBe('no-store');
    noUpstreamCalls(a);
    expect((await lookupRow(a, headword)).lookup_result).toBe('dictionary');
  });

  it('a form stored in word_forms → the entry with matched_form, 0 outside requests', async () => {
    const res = await a.lookup(viaForm);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ source: 'dictionary', id: entryId, matched_form: viaForm });
    noUpstreamCalls(a);
  });

  it('F4b: an inflection known only to ref_wiktionary_en → the entry of its lemma, matched_form, 0 outside requests, and the form is remembered', async () => {
    const res = await a.lookup(inflected);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ source: 'dictionary', id: entryId, matched_form: inflected });
    noUpstreamCalls(a);

    const remembered = await a.waitFor(
      async () => (await a.pool.query(`SELECT form_type FROM word_forms WHERE entry_id = $1 AND form_value = $2`, [entryId, inflected])).rows[0],
      'the word_forms row written in the background'
    );
    expect(remembered.form_type).toBe('past_simple');

    // the second time it is a plain F4 hit
    const again = await a.lookup(inflected);
    expect(again.body.data).toMatchObject({ source: 'dictionary', id: entryId, matched_form: inflected });
    noUpstreamCalls(a);
  });

  it('is case-insensitive and ignores punctuation around the word', async () => {
    const res = await a.lookup(`  "${headword.toUpperCase()}!" `);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ source: 'dictionary', id: entryId });
    noUpstreamCalls(a);
  });

  it('does not count against the per-user miss limit (see the 429 test) and never creates a job or a Google character', async () => {
    const before = (await a.pool.query(`SELECT used FROM api_usage_counters WHERE provider = 'google_translate' AND unit = 'chars' AND period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`)).rows[0]?.used;
    for (let i = 0; i < 5; i++) await a.lookup(headword);
    const after = (await a.pool.query(`SELECT used FROM api_usage_counters WHERE provider = 'google_translate' AND unit = 'chars' AND period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`)).rows[0]?.used;
    expect(after).toEqual(before);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('error responses', () => {
  let a: LookupApp;
  beforeAll(async () => {
    a = await bootLookupApp();
  });
  afterAll(() => a.close());
  beforeEach(() => a.mock.reset());

  it('400 INVALID_WORD for bad input, before any dictionary or outside request', async () => {
    const bad = ['', '   ', 'two words', 'abc123', 'x'.repeat(51), 'a\u0000b', 'café', '‮evil', '<script>', '../etc/passwd', "a'; DROP TABLE users;--"];
    for (const word of bad) {
      const res = await a.lookup(word);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, error: { code: 'INVALID_WORD' } });
    }
    noUpstreamCalls(a);
  });

  it('401 without a token, and the endpoint stays authenticated', async () => {
    const supertest = (await import('supertest')).default;
    const res = await supertest(a.app).post(`/api/v1/ebooks/${a.ebookId}/lookup`).send({ word: 'hello' });
    expect(res.status).toBe(401);
    noUpstreamCalls(a);
  });

  it('503 and 404 carry Cache-Control: no-store', async () => {
    const down = fixtureWord('errdown');
    const nope = fixtureWord('errnope');
    a.mock.setControl({
      rules: [
        { provider: 'google', words: [down, nope], behavior: { mode: 'status', status: 503 } },
        { provider: 'fd', words: [down], behavior: { mode: 'status', status: 503 } },
        { provider: 'fd', words: [nope], behavior: { mode: 'not_found' } },
      ],
    });
    expect((await a.lookup(down)).headers['cache-control']).toBe('no-store');
    expect((await a.lookup(nope)).headers['cache-control']).toBe('no-store');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('429 LOOKUP_RATE_LIMITED (F6), with LOOKUP_MISS_RATE_LIMIT_PER_MIN=3', () => {
  let a: LookupApp;
  const headword = fixtureWord('known');
  beforeAll(async () => {
    a = await bootLookupApp({ env: { LOOKUP_MISS_RATE_LIMIT_PER_MIN: '3' } });
    await insertEntry(a, headword);
  });
  afterAll(() => a.close());

  it('the 4th dictionary miss in a minute is refused with Retry-After; hits and other users are not affected', async () => {
    const words = ['one', 'two', 'three', 'four'].map((t) => fixtureWord('rl' + t));
    for (const word of words.slice(0, 3)) expect((await a.lookup(word)).status).toBe(200);
    const flightsBefore = a.mock.stats().fd.requests;

    const limited = await a.lookup(words[3]);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ success: false, error: { code: 'LOOKUP_RATE_LIMITED' } });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(a.mock.stats().fd.requests).toBe(flightsBefore); // refused before any outside request
    expect(a.mock.stats().fd.byWord[words[3]]).toBeUndefined();

    expect((await a.lookup(headword)).status).toBe(200); // a dictionary hit is free
    const other = await a.createUser('other');
    expect((await a.lookup(words[3], { token: other.token })).status).toBe(200); // the limit is per user
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the total deadline (LOOKUP_TOTAL_DEADLINE_MS=3000)', () => {
  let a: LookupApp;
  const slowFd = fixtureWord('slowfd');
  const slowGoogle = fixtureWord('slowg');
  const slowBoth = fixtureWord('slowboth');
  const SLACK_MS = 1500; // the dev database is far away: a few round trips on top of the 3 s

  beforeAll(async () => {
    a = await bootLookupApp({ env: { UPSTREAM_BREAKER_FAILURE_THRESHOLD: '100', LOOKUP_TOTAL_DEADLINE_MS: '3000' } });
    a.mock.setControl({
      rules: [
        { provider: 'fd', words: [slowFd, slowBoth], behavior: { latencyMs: 6000 } },
        { provider: 'google', words: [slowGoogle, slowBoth], behavior: { latencyMs: 6000 } },
      ],
    });
  });
  afterAll(() => a.close());

  it('a source that needs 6 s does not hold the answer back: Free Dictionary slow → 200 partial near the deadline', async () => {
    const t0 = Date.now();
    const res = await a.lookup(slowFd);
    const ms = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(res.body.data.partial).toBe(true);
    expect(res.body.data.translation_vi).toEqual(expect.any(String));
    expect(res.body.data.missing).toEqual(expect.arrayContaining(['pos', 'definition_en', 'ipa', 'audio_url']));
    expect(ms).toBeLessThan(3000 + SLACK_MS);
    expect(ms).toBeGreaterThan(1500); // it did wait for the source (up to the per-source timeout), it did not give up at once
  });

  it('Google slow → 200 partial, translation_vi null, within the deadline', async () => {
    const t0 = Date.now();
    const res = await a.lookup(slowGoogle);
    const ms = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ partial: true, translation_vi: null });
    expect(res.body.data.missing).toContain('translation_vi');
    expect(ms).toBeLessThan(3000 + SLACK_MS);
  });

  it('both slow → 503 within the deadline, not a hung request', async () => {
    const t0 = Date.now();
    const res = await a.lookup(slowBoth);
    const ms = Date.now() - t0;
    expect(res.status).toBe(503);
    expect(ms).toBeLessThan(3000 + SLACK_MS);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('TRANSLATION_FALLBACK_ENABLED=false (F5, the emergency switch)', () => {
  let a: LookupApp;
  const headword = fixtureWord('swhit');
  beforeAll(async () => {
    a = await bootLookupApp({ env: { TRANSLATION_FALLBACK_ENABLED: 'false' } });
    await insertEntry(a, headword);
  });
  afterAll(() => a.close());

  it('a dictionary miss is a 404 ENTRY_NOT_FOUND with 0 outside requests and a not_found row', async () => {
    const word = fixtureWord('swmiss');
    const res = await a.lookup(word);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTRY_NOT_FOUND' } });
    expect(res.headers['cache-control']).toBe('no-store');
    noUpstreamCalls(a);
    expect((await lookupRow(a, word)).lookup_result).toBe('not_found');
  });

  it('the dictionary still answers', async () => {
    const res = await a.lookup(headword);
    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('dictionary');
    noUpstreamCalls(a);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Cache-Control and backward compatibility (spec §0.3, §4.4)', () => {
  let a: LookupApp;
  const headword = fixtureWord('compat');
  beforeAll(async () => {
    a = await bootLookupApp();
    await insertEntry(a, headword);
  });
  afterAll(() => a.close());

  it('every temporary answer is no-store; a dictionary answer is not', async () => {
    const temporary = await a.lookup(fixtureWord('cc'));
    expect(temporary.body.data.source).toBe('translation');
    expect(temporary.headers['cache-control']).toBe('no-store');
    expect((await a.lookup(headword)).headers['cache-control']).not.toBe('no-store');
  });

  it('source=translation keeps every field the app already reads (names, positions as top-level keys, types)', async () => {
    const res = await a.lookup(fixtureWord('compattr'));
    expect(res.status).toBe(200);
    expectContract(res.body.data, CONTRACT.translation);
    expectContract(res.body.data.lookup_context, CONTRACT.lookup_context);
    expect(typeof res.body.data.pos).toBe('string'); // still the first part of speech as a string, not the list
    expect(Array.isArray(res.body.data.examples)).toBe(true);
    // fields were only ADDED (spec §4.2)
    for (const added of ['temporary', 'headword', 'pos_list', 'ipa', 'meanings_vi', 'senses', 'partial', 'missing', 'attribution', 'enrichment']) expect(res.body.data).toHaveProperty(added);
  });

  it('source=dictionary keeps every field of the entry; matched_form is an addition', async () => {
    const res = await a.lookup(headword);
    expect(res.status).toBe(200);
    expectContract(res.body.data, CONTRACT.dictionary);
    expect(res.body.data.source).toBe('dictionary'); // the discriminator wins over the entry's own `source` column
  });

  it('error bodies keep the { success:false, error:{ code, message } } shape', async () => {
    const res = await a.lookup('not valid');
    expectContract(res.body, CONTRACT.error);
    expect(res.body.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('word_translation_cache is neither read nor written (spec §3, §5 F7)', () => {
  let a: LookupApp;
  beforeAll(async () => {
    a = await bootLookupApp();
  });
  afterAll(() => a.close());

  it('no SQL statement mentions it, whichever way the lookup ends, and no row appears for the words', async () => {
    const spy = jest.spyOn(a.pool, 'query');
    const words = ['cachea', 'cacheb', 'cachec', 'cached'].map(fixtureWord);
    a.mock.setControl({ rules: [{ provider: 'google', words: [words[1]], behavior: { mode: 'status', status: 503 } }, { provider: 'fd', words: [words[2]], behavior: { mode: 'not_found' } }, { provider: 'fd', words: [words[3]], behavior: { mode: 'status', status: 503 } }, { provider: 'google', words: [words[3]], behavior: { mode: 'status', status: 503 } }] });
    for (const word of words) await a.lookup(word);
    await a.lookup(words[0]); // the second time for the same word asks the outside again: there is no cache
    expect(a.mock.stats().fd.byWord[words[0]].requests).toBe(2);

    const sqls = spy.mock.calls.map(([sql]) => String((sql as any)?.text ?? sql));
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.filter((s) => s.includes('word_translation_cache'))).toEqual([]);
    const { rows } = await a.pool.query(`SELECT 1 FROM word_translation_cache WHERE word = ANY($1::text[])`, [words]);
    expect(rows).toEqual([]);
    spy.mockRestore();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the tests cannot reach a real service (spec §0.5, §13.3)', () => {
  let a: LookupApp;
  beforeAll(async () => {
    a = await bootLookupApp();
  });
  afterAll(() => a.close());

  it('the app talks to the mock and to nothing else: the three base URLs are on 127.0.0.1', () => {
    for (const url of Object.values(a.mock.env)) expect(new URL(url).hostname).toBe('127.0.0.1');
    expect(a.mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('a request to any other host fails inside the test process, before it leaves the machine', async () => {
    for (const host of ['translation.googleapis.com', 'api.dictionaryapi.dev', 'api.datamuse.com', 'api.anthropic.com']) {
      await expect(fetch(`https://${host}/x?key=SECRET`)).rejects.toThrow(`network guard: a test tried to reach ${host}`);
    }
  });

  it('and the guard never prints a query string (it could hold a key)', async () => {
    const e = await fetch('https://translation.googleapis.com/x?key=SECRET-KEY-123').catch((err) => err);
    expect(String(e.message)).not.toContain('SECRET-KEY-123');
  });
});
