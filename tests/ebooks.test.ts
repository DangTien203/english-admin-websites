import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const EMAIL = `ebooks-test-${TS}@example.com`;
// Digit-free unique suffix for seeded words — normalizeWord rejects digits.
const WORD_SUFFIX = TS.toString(36).replace(/\d/g, 'a');

let access_token = '';
let userId = '';
let testEbookId = '';
let testEbook2Id = ''; // premium ebook for lock test
let testChapterId = '';
let testParagraphId = '';
let testEntryId = '';

// ─────────────────────────────────────────────────────────────────────────────
//  Setup
// ─────────────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  // Register user
  const reg = await request(app).post('/api/v1/auth/register').send({
    email: EMAIL,
    password: 'password123',
    full_name: 'Ebook Tester',
  });
  if (reg.status !== 201) throw new Error(`Register failed: ${JSON.stringify(reg.body)}`);
  access_token = reg.body.data.access_token;

  const { rows: uRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
  userId = uRows[0].id;

  // Insert free ebook
  const { rows: [eb1] } = await pool.query(
    `INSERT INTO ebooks (title, author, level, required_plan, status, epub_file_url, genre)
     VALUES ($1, $2, 'intermediate', 'free', 'published', '/test.epub', $3)
     RETURNING id`,
    [`Test Ebook ${TS}`, 'Test Author', ['education']]
  );
  testEbookId = eb1.id;

  // Insert premium ebook
  const { rows: [eb2] } = await pool.query(
    `INSERT INTO ebooks (title, author, level, required_plan, status, epub_file_url)
     VALUES ($1, $2, 'advanced', 'premium', 'published', '/test2.epub')
     RETURNING id`,
    [`Premium Ebook ${TS}`, 'Premium Author']
  );
  testEbook2Id = eb2.id;

  // Insert chapter + paragraphs for ebook 1
  const { rows: [ch] } = await pool.query(
    `INSERT INTO chapters (ebook_id, chapter_index, title, word_count)
     VALUES ($1, 0, 'Chapter 1', 100)
     RETURNING id`,
    [testEbookId]
  );
  testChapterId = ch.id;

  const { rows: [para] } = await pool.query(
    `INSERT INTO paragraphs (chapter_id, paragraph_index, text, word_count)
     VALUES ($1, 0, 'This is a test paragraph with some words in it.', 10)
     RETURNING id`,
    [testChapterId]
  );
  testParagraphId = para.id;

  // Insert a dictionary entry for lookup test
  const { rows: [ent] } = await pool.query(
    `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, published, source)
     VALUES ($1, $1, $2, 'từ kiểm tra', TRUE, 'manual')
     RETURNING id`,
    [`testword${WORD_SUFFIX}`, ['noun']]
  );
  testEntryId = ent.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
  await pool.query(`DELETE FROM ebooks WHERE id = ANY($1::uuid[])`, [[testEbookId, testEbook2Id]]);
  await pool.query(`DELETE FROM dictionary_entries WHERE id = $1`, [testEntryId]);
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/ebooks — list
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/v1/ebooks', () => {
  it('returns 200 + list + pagination without params', async () => {
    const res = await request(app)
      .get('/api/v1/ebooks')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { items, total, page, limit } = res.body.data;
    expect(Array.isArray(items)).toBe(true);
    expect(typeof total).toBe('number');
    expect(page).toBe(1);
    expect(limit).toBeGreaterThan(0);

    const found = items.find((e: any) => e.id === testEbookId);
    expect(found).toBeDefined();
    expect(found.required_plan).toBe('free');
    expect(found.is_favorite).toBe(false);
  });

  it('new user has current_paragraph_index null and is_favorite false', async () => {
    const res = await request(app)
      .get('/api/v1/ebooks')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const found = res.body.data.items.find((e: any) => e.id === testEbookId);
    expect(found).toBeDefined();
    expect(found.current_paragraph_index).toBeNull();
    expect(found.is_favorite).toBe(false);
    expect(found.progress).toBe(0);
  });

  it('filter=favorites returns only favorited books', async () => {
    // Favorite the ebook first
    await request(app)
      .post(`/api/v1/ebooks/${testEbookId}/favorite`)
      .set('Authorization', `Bearer ${access_token}`);

    const res = await request(app)
      .get('/api/v1/ebooks?filter=favorites')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { items } = res.body.data;
    expect(items.every((e: any) => e.is_favorite === true)).toBe(true);
    expect(items.find((e: any) => e.id === testEbookId)).toBeDefined();

    // Unfavorite for test isolation
    await request(app)
      .delete(`/api/v1/ebooks/${testEbookId}/favorite`)
      .set('Authorization', `Bearer ${access_token}`);
  });

  it('filter=favorites with no favorites returns empty list', async () => {
    const res = await request(app)
      .get('/api/v1/ebooks?filter=favorites')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
  });

  it('genre filter narrows results', async () => {
    const res = await request(app)
      .get('/api/v1/ebooks?genre=education')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { items } = res.body.data;
    // Test ebook 1 has genre=['education'], should appear
    expect(items.find((e: any) => e.id === testEbookId)).toBeDefined();
    // Premium ebook has no genre, should not appear
    expect(items.find((e: any) => e.id === testEbook2Id)).toBeUndefined();
  });

  it('level filter narrows results', async () => {
    const res = await request(app)
      .get('/api/v1/ebooks?level=advanced')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { items } = res.body.data;
    expect(items.every((e: any) => e.level === 'advanced')).toBe(true);
    expect(items.find((e: any) => e.id === testEbook2Id)).toBeDefined();
    expect(items.find((e: any) => e.id === testEbookId)).toBeUndefined();
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/v1/ebooks');
    expect(res.status).toBe(401);
  });

  // ── search ───────────────────────────────────────────────────────────────
  it('search by partial title narrows to matching ebooks', async () => {
    // Seeded titles include `Test Ebook ${TS}` and `Premium Ebook ${TS}`.
    const res = await request(app)
      .get(`/api/v1/ebooks?search=Premium`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { items } = res.body.data;
    expect(items.find((e: any) => e.id === testEbook2Id)).toBeDefined();
    expect(items.find((e: any) => e.id === testEbookId)).toBeUndefined();
  });

  it('search by author works', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks?search=Premium%20Author`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items.find((e: any) => e.id === testEbook2Id)).toBeDefined();
  });

  it('search is case-insensitive', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks?search=premium`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items.find((e: any) => e.id === testEbook2Id)).toBeDefined();
  });

  it('search combines with level filter', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks?search=Ebook&level=advanced`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { items } = res.body.data;
    // Only the advanced/premium ebook should match (title contains "Ebook" + level=advanced).
    expect(items.find((e: any) => e.id === testEbook2Id)).toBeDefined();
    expect(items.find((e: any) => e.id === testEbookId)).toBeUndefined();
  });

  it('empty/whitespace search behaves like no filter', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks?search=%20%20`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    // Both seeded ebooks should be present.
    const ids = res.body.data.items.map((e: any) => e.id);
    expect(ids).toEqual(expect.arrayContaining([testEbookId, testEbook2Id]));
  });

  it('search escapes SQL LIKE wildcards (% _) so they match literally', async () => {
    // None of our seeded titles contain literal '%' or '_'.
    const res = await request(app)
      .get(`/api/v1/ebooks?search=%25`) // %25 → '%'
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    // Should match nothing (no title actually contains a percent sign).
    expect(res.body.data.items.find((e: any) => e.id === testEbookId)).toBeUndefined();
    expect(res.body.data.items.find((e: any) => e.id === testEbook2Id)).toBeUndefined();
  });

  it('search with no matches returns empty list', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks?search=zzzzznosuchbookever${TS}`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/ebooks/:id
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/v1/ebooks/:id', () => {
  it('returns ebook detail with chapters', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks/${testEbookId}`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.id).toBe(testEbookId);
    expect(Array.isArray(data.chapters)).toBe(true);
    expect(data.chapters.length).toBeGreaterThan(0);
    expect(data.is_favorite).toBe(false);
    expect(data.locked).toBeUndefined(); // free ebook → not locked
  });

  it('marks premium ebook as locked for free user', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks/${testEbook2Id}`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.locked).toBe(true);
    expect(res.body.data.locked_reason).toBe('UPGRADE_REQUIRED');
  });

  it('returns 404 for non-existent ebook', async () => {
    const res = await request(app)
      .get('/api/v1/ebooks/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${access_token}`);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/ebooks/:id/chapters/:chapter_id
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/v1/ebooks/:id/chapters/:chapter_id', () => {
  it('returns chapter with paragraphs and progress', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks/${testEbookId}/chapters/${testChapterId}`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { chapter, paragraphs, progress } = res.body.data;
    expect(chapter.id).toBe(testChapterId);
    expect(Array.isArray(paragraphs)).toBe(true);
    expect(paragraphs[0].word_count).toBeGreaterThan(0);
    expect(typeof progress.current_paragraph_index).toBe('number');
  });

  it('include_translations=true includes translation_vi field', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks/${testEbookId}/chapters/${testChapterId}?include_translations=true`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.paragraphs[0]).toHaveProperty('translation_vi');
  });

  it('free user can access chapter 0 of premium ebook (preview)', async () => {
    // Insert chapter 0 for the premium ebook
    const { rows: [premCh] } = await pool.query(
      `INSERT INTO chapters (ebook_id, chapter_index, title, word_count)
       VALUES ($1, 0, 'Preview Chapter', 50)
       RETURNING id`,
      [testEbook2Id]
    );

    const res = await request(app)
      .get(`/api/v1/ebooks/${testEbook2Id}/chapters/${premCh.id}`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);

    // Cleanup
    await pool.query(`DELETE FROM chapters WHERE id = $1`, [premCh.id]);
  });

  it('free user cannot access chapter 1+ of premium ebook', async () => {
    // Insert chapter 1 for the premium ebook
    const { rows: [premCh] } = await pool.query(
      `INSERT INTO chapters (ebook_id, chapter_index, title, word_count)
       VALUES ($1, 1, 'Locked Chapter', 100)
       RETURNING id`,
      [testEbook2Id]
    );

    const res = await request(app)
      .get(`/api/v1/ebooks/${testEbook2Id}/chapters/${premCh.id}`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FEATURE_NOT_AVAILABLE');

    // Cleanup
    await pool.query(`DELETE FROM chapters WHERE id = $1`, [premCh.id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/ebooks/:id/chapters/:chapter_id/progress
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/v1/ebooks/:id/chapters/:chapter_id/progress', () => {
  it('returns 204 and persists progress', async () => {
    const res = await request(app)
      .post(`/api/v1/ebooks/${testEbookId}/chapters/${testChapterId}/progress`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ current_paragraph_index: 0, time_spent_sec: 30 });

    expect(res.status).toBe(204);

    const { rows } = await pool.query(
      `SELECT current_paragraph_index, total_time_sec FROM user_reading_progress
       WHERE user_id = $1 AND ebook_id = $2`,
      [userId, testEbookId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].total_time_sec).toBeGreaterThanOrEqual(30);
  });

  it('validates current_paragraph_index', async () => {
    const res = await request(app)
      .post(`/api/v1/ebooks/${testEbookId}/chapters/${testChapterId}/progress`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ current_paragraph_index: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/ebooks/:id/lookup
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/v1/ebooks/:id/lookup', () => {
  it('returns EntryDetail flat at data level (no nested "entry" wrapper)', async () => {
    const word = `testword${WORD_SUFFIX}`;
    const res = await request(app)
      .post(`/api/v1/ebooks/${testEbookId}/lookup`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ word });

    expect(res.status).toBe(200);

    // Flat shape — matches GET /dictionary/entries/:id
    expect(res.body.data.headword).toBe(word);
    expect(res.body.data.id).toBe(testEntryId);
    expect(res.body.data).not.toHaveProperty('entry');

    // Lookup context lives in its own sub-object — never inside the entry.
    expect(res.body.data.lookup_context).toEqual({
      source: 'ebook',
      ebook_id: testEbookId,
      paragraph_id: null,
    });

    // Allow async insert to settle
    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await pool.query(
      `SELECT id FROM word_lookups WHERE user_id = $1 AND entry_id = $2 AND source = 'ebook'`,
      [userId, testEntryId]
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('shape parity with /dictionary/entries/:id (no wrapping; subset of fields)', async () => {
    const word = `testword${WORD_SUFFIX}`;

    const [lookupRes, dictRes] = await Promise.all([
      request(app)
        .post(`/api/v1/ebooks/${testEbookId}/lookup`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ word }),
      request(app)
        .get(`/api/v1/dictionary/entries/${testEntryId}`)
        .set('Authorization', `Bearer ${access_token}`),
    ]);

    expect(lookupRes.status).toBe(200);
    expect(dictRes.status).toBe(200);

    // Same primary entity: id, headword, and lemma must match.
    expect(lookupRes.body.data.id).toBe(dictRes.body.data.id);
    expect(lookupRes.body.data.headword).toBe(dictRes.body.data.headword);

    // Every key the lookup endpoint returns (besides lookup_context and the
    // `source` discriminator added in Phase 9.6) MUST also exist on the dictionary
    // endpoint — guarantees no wrapping/renamed fields.
    // (Dict may legitimately have additional fields like legacy_synonyms because
    // the underlying FULL_ENTRY_SQL queries differ; that's out of scope here.)
    const dictKeys = new Set(Object.keys(dictRes.body.data));
    const lookupKeys = Object.keys(lookupRes.body.data).filter(
      (k) => k !== 'lookup_context' && k !== 'source'
    );
    for (const k of lookupKeys) {
      expect(dictKeys.has(k)).toBe(true);
    }

    // Core EntryDetail fields the mobile model relies on must be present at top level.
    const REQUIRED = ['id', 'headword', 'pos', 'senses'];
    for (const k of REQUIRED) {
      expect(lookupRes.body.data).toHaveProperty(k);
    }
  });

  it('returns 404 for unknown word (with TRANSLATION_FALLBACK_ENABLED off)', async () => {
    // Make sure the translation fallback path isn't exercised by this test —
    // we only want to verify the dict-miss path returns 404.
    const orig = process.env.TRANSLATION_FALLBACK_ENABLED;
    process.env.TRANSLATION_FALLBACK_ENABLED = 'false';
    try {
      const res = await request(app)
        .post(`/api/v1/ebooks/${testEbookId}/lookup`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ word: 'xyzzynosuchword' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ENTRY_NOT_FOUND');
    } finally {
      if (orig === undefined) delete process.env.TRANSLATION_FALLBACK_ENABLED;
      else process.env.TRANSLATION_FALLBACK_ENABLED = orig;
    }
  });

  it('requires word field', async () => {
    const res = await request(app)
      .post(`/api/v1/ebooks/${testEbookId}/lookup`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_WORD');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST/DELETE /api/v1/ebooks/:id/favorite
// ─────────────────────────────────────────────────────────────────────────────
describe('Favorite toggle', () => {
  it('POST favorite → 201, ebook shows is_favorite=true', async () => {
    const addRes = await request(app)
      .post(`/api/v1/ebooks/${testEbookId}/favorite`)
      .set('Authorization', `Bearer ${access_token}`);
    expect(addRes.status).toBe(201);

    const listRes = await request(app)
      .get(`/api/v1/ebooks/${testEbookId}`)
      .set('Authorization', `Bearer ${access_token}`);
    expect(listRes.body.data.is_favorite).toBe(true);
  });

  it('POST favorite twice is idempotent (no 409)', async () => {
    const res = await request(app)
      .post(`/api/v1/ebooks/${testEbookId}/favorite`)
      .set('Authorization', `Bearer ${access_token}`);
    expect(res.status).toBe(201);
  });

  it('DELETE favorite → 204, ebook shows is_favorite=false', async () => {
    const delRes = await request(app)
      .delete(`/api/v1/ebooks/${testEbookId}/favorite`)
      .set('Authorization', `Bearer ${access_token}`);
    expect(delRes.status).toBe(204);

    const listRes = await request(app)
      .get(`/api/v1/ebooks/${testEbookId}`)
      .set('Authorization', `Bearer ${access_token}`);
    expect(listRes.body.data.is_favorite).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/ebooks/reading-stats
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/v1/ebooks/reading-stats', () => {
  it('returns stats shape', async () => {
    const res = await request(app)
      .get('/api/v1/ebooks/reading-stats')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(typeof d.total_time_minutes).toBe('number');
    expect(typeof d.books_finished).toBe('number');
    expect(typeof d.books_in_progress).toBe('number');
    expect(typeof d.words_looked_up).toBe('number');
    expect(Array.isArray(d.top_books)).toBe(true);
    expect(Array.isArray(d.top_looked_up_words)).toBe(true);
  });
});
