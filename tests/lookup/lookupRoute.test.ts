import express from 'express';
import request from 'supertest';

// The route is exercised for real; only its two collaborators are replaced:
//  - the database pool (records SQL, answers the paragraph check)
//  - the lookup service (returns a scripted result), so no network or Postgres is involved.
const mockQuery = jest.fn();
const mockLookup = jest.fn();

jest.mock('../../config/db', () => ({ query: (...args: any[]) => mockQuery(...args) }));
jest.mock('../../services/lookup', () => ({ getWordLookupService: () => ({ lookup: (...args: any[]) => mockLookup(...args) }) }));

// eslint-disable-next-line import/first
import ebooksRouter from '../../routes/api/ebooks';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  });
  a.use('/api/v1/ebooks', ebooksRouter);
  return a;
}

const post = (body: any) => request(app()).post('/api/v1/ebooks/ebook-1/lookup').send(body);

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  mockLookup.mockReset();
});

const TEMPORARY = {
  kind: 'temporary',
  body: { source: 'translation', temporary: true, word: 'Zorp', translation_vi: null, partial: true, missing: ['translation_vi'], senses: [], meanings_vi: [], enrichment: { status: 'disabled' } },
};

describe('POST /ebooks/:id/lookup — response mapping', () => {
  it('temporary result: 200, Cache-Control: no-store, new fields present, lookup_context added', async () => {
    mockLookup.mockResolvedValue(TEMPORARY);
    const res = await post({ word: 'Zorp' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ source: 'translation', temporary: true, partial: true, translation_vi: null, lookup_context: { source: 'ebook', ebook_id: 'ebook-1', paragraph_id: null } });
  });

  it('dictionary result: unchanged shape, source=dictionary, NO no-store header, matched_form only when present', async () => {
    mockLookup.mockResolvedValue({ kind: 'dictionary', entry: { id: 'e1', headword: 'run', source: 'wiktionary' } });
    const plain = await post({ word: 'run' });
    expect(plain.status).toBe(200);
    expect(plain.headers['cache-control']).not.toBe('no-store');
    expect(plain.body.data).toMatchObject({ id: 'e1', headword: 'run', source: 'dictionary' });
    expect(plain.body.data).not.toHaveProperty('matched_form');

    mockLookup.mockResolvedValue({ kind: 'dictionary', entry: { id: 'e1', headword: 'run' }, matchedForm: 'ran' });
    const viaForm = await post({ word: 'ran' });
    expect(viaForm.body.data).toMatchObject({ source: 'dictionary', matched_form: 'ran' });
  });

  it('404 ENTRY_NOT_FOUND keeps its code and message, and is not cacheable', async () => {
    mockLookup.mockResolvedValue({ kind: 'not_found' });
    const res = await post({ word: 'Qwxz' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ENTRY_NOT_FOUND');
    expect(res.body.error.message).toContain('Qwxz');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('503 TRANSLATION_UNAVAILABLE keeps its code', async () => {
    mockLookup.mockResolvedValue({ kind: 'unavailable' });
    const res = await post({ word: 'serendipity' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TRANSLATION_UNAVAILABLE');
  });

  it('429 LOOKUP_RATE_LIMITED carries Retry-After', async () => {
    mockLookup.mockResolvedValue({ kind: 'rate_limited', retryAfterSeconds: 17 });
    const res = await post({ word: 'Zorp' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('LOOKUP_RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('17');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /ebooks/:id/lookup — unchanged steps F1–F3', () => {
  it('F1: invalid words get 400 INVALID_WORD and never reach the service', async () => {
    for (const word of ['', '   ', 'two words', 'abc123', 'x'.repeat(51), 'a\u0000b', 'café', '‮evil', '<script>']) {
      const res = await post({ word });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WORD');
    }
    expect((await post({})).status).toBe(400);
    expect((await post({ word: 42 })).status).toBe(400);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('F1: surrounding punctuation is stripped and the key is lowercased', async () => {
    mockLookup.mockResolvedValue({ kind: 'not_found' });
    await post({ word: '  "Don\'t!" ' });
    expect(mockLookup.mock.calls[0][0].word).toEqual({ normalized: "don't", display: "Don't" });
  });

  it('F2: a paragraph that belongs to the ebook is passed on; a foreign one becomes null', async () => {
    mockLookup.mockResolvedValue({ kind: 'not_found' });
    mockQuery.mockImplementation(async (sql: string) => (sql.includes('FROM paragraphs p') ? { rows: [{ id: 'p-1' }] } : { rows: [] }));
    await post({ word: 'zorp', paragraph_id: 'p-1' });
    expect(mockLookup.mock.calls[0][0].paragraphId).toBe('p-1');

    mockQuery.mockImplementation(async () => ({ rows: [] }));
    await post({ word: 'zorp', paragraph_id: 'foreign' });
    expect(mockLookup.mock.calls[1][0].paragraphId).toBeNull();
  });

  it('F3: words_looked_up is bumped exactly once per valid lookup, for every outcome', async () => {
    for (const result of [TEMPORARY, { kind: 'not_found' }, { kind: 'rate_limited', retryAfterSeconds: 1 }, { kind: 'dictionary', entry: { id: 'e' } }]) {
      mockQuery.mockClear();
      mockLookup.mockResolvedValue(result);
      await post({ word: 'zorp' });
      const bumps = mockQuery.mock.calls.filter(([sql]) => String(sql).includes('words_looked_up'));
      expect(bumps).toHaveLength(1);
      expect(bumps[0][1]).toEqual(['user-1', 'ebook-1']);
    }
  });

  it('the route itself never touches word_translation_cache', async () => {
    mockLookup.mockResolvedValue(TEMPORARY);
    await post({ word: 'Zorp', paragraph_id: 'p-1' });
    expect(mockQuery.mock.calls.filter(([sql]) => String(sql).includes('word_translation_cache'))).toEqual([]);
  });
});
