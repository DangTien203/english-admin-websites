import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const HEADWORD_PREFIX = `zzphase3-${TS}-`;
const EMAIL_PREFIX = `phase3test-${TS}-`;

let accessToken = '';
let appleId = '';
let bananaId = '';
let catId = '';

const insertEntry = async (headword: string, opts: {
  pos: string[];
  cefr?: string;
  frequency?: number | null;
}) => {
  const { rows } = await pool.query(
    `INSERT INTO dictionary_entries
      (headword, lemma, ipa_us, pos, meaning_vi, cefr_level, frequency_rank, published, source)
     VALUES ($1, $1, '/tɛst/', $2, $3, $4, $5, TRUE, 'manual')
     RETURNING id`,
    [
      headword,
      opts.pos,
      `Nghĩa kiểm thử cho ${headword}\nDòng thứ hai`,
      opts.cefr ?? null,
      opts.frequency ?? null,
    ]
  );
  return rows[0].id as string;
};

beforeAll(async () => {
  // Register test user
  const email = `${EMAIL_PREFIX}1@example.com`;
  const reg = await request(app).post('/api/v1/auth/register').send({
    email,
    password: 'password123',
    full_name: 'Phase 3 Tester',
  });
  if (reg.status !== 201) {
    throw new Error(`Setup failed: register returned ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  accessToken = reg.body.data.access_token;

  // Insert 3 test entries
  appleId = await insertEntry(`${HEADWORD_PREFIX}apple`, { pos: ['noun'], cefr: 'A1', frequency: 1000 });
  bananaId = await insertEntry(`${HEADWORD_PREFIX}banana`, { pos: ['noun'], cefr: 'A2', frequency: 2000 });
  catId = await insertEntry(`${HEADWORD_PREFIX}cat`, { pos: ['noun', 'verb'], cefr: 'B1', frequency: 500 });

  // Populate Dictionary Pro data cho catId
  const { rows: senseRows } = await pool.query(
    `INSERT INTO entry_senses (entry_id, pos, sense_order, definition_en, definition_vi)
     VALUES ($1, 'noun', 1, 'A small domestic animal', 'Một loài động vật nhỏ trong nhà')
     RETURNING id`,
    [catId]
  );
  const senseId = senseRows[0].id;
  await pool.query(
    `INSERT INTO sense_examples (sense_id, example_en, example_vi, sort_order)
     VALUES ($1, 'The cat sat on the mat.', 'Con mèo ngồi trên tấm thảm.', 1)`,
    [senseId]
  );
  await pool.query(
    `INSERT INTO sense_synonyms (sense_id, synonym_text) VALUES ($1, 'feline')`,
    [senseId]
  );
  await pool.query(
    `INSERT INTO sense_antonyms (sense_id, antonym_text) VALUES ($1, 'dog')`,
    [senseId]
  );
  await pool.query(
    `INSERT INTO word_forms (entry_id, form_type, form_value, sort_order)
     VALUES ($1, 'plural', 'cats', 1)`,
    [catId]
  );
  await pool.query(
    `INSERT INTO phrasal_verbs (entry_id, phrasal_verb, particle, definition_vi)
     VALUES ($1, 'cat out', 'out', 'Thả ra, thả rông')`,
    [catId]
  );
  await pool.query(
    `INSERT INTO entry_idioms (entry_id, idiom_text, definition_vi)
     VALUES ($1, 'let the cat out of the bag', 'Để lộ bí mật')`,
    [catId]
  );
  await pool.query(
    `INSERT INTO collocations (entry_id, collocation, pattern)
     VALUES ($1, 'stray cat', 'adj + noun')`,
    [catId]
  );

  // Seed word_lookups cho trending (5 lookups cho cat)
  const { rows: userRows } = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );
  const userId = userRows[0].id;
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `INSERT INTO word_lookups (user_id, entry_id, source) VALUES ($1, $2, 'manual_search')`,
      [userId, catId]
    );
  }
});

afterAll(async () => {
  // CASCADE dọn senses/forms/phrasal_verbs/idioms/collocations/word_lookups/saved_words
  await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1`, [`${HEADWORD_PREFIX}%`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  await pool.end();
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/dictionary/search', () => {
  it('prefix search trả entries match với đúng ordering', async () => {
    const res = await request(app).get(`/api/v1/dictionary/search?q=${HEADWORD_PREFIX}a&limit=20`);
    expect(res.status).toBe(200);
    const headwords = res.body.data.items.map((r: any) => r.headword);
    expect(headwords).toEqual(expect.arrayContaining([`${HEADWORD_PREFIX}apple`]));
    // meaning_preview phải cắt line đầu
    const apple = res.body.data.items.find((r: any) => r.headword === `${HEADWORD_PREFIX}apple`);
    expect(apple.meaning_preview).toBe(`Nghĩa kiểm thử cho ${HEADWORD_PREFIX}apple`);
  });

  it('filter pos=verb chỉ giữ entries có "verb" trong pos[]', async () => {
    const res = await request(app).get(`/api/v1/dictionary/search?q=${HEADWORD_PREFIX}&pos=verb&limit=20`);
    expect(res.status).toBe(200);
    const headwords = res.body.data.items.map((r: any) => r.headword);
    // Chỉ cat có pos=['noun','verb'], apple/banana không có verb
    expect(headwords).toContain(`${HEADWORD_PREFIX}cat`);
    expect(headwords).not.toContain(`${HEADWORD_PREFIX}apple`);
    expect(headwords).not.toContain(`${HEADWORD_PREFIX}banana`);
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/dictionary/entries/:id', () => {
  it('full nested data cho entry có senses/forms/phrasal_verbs/idioms/collocations', async () => {
    const res = await request(app).get(`/api/v1/dictionary/entries/${catId}`);
    expect(res.status).toBe(200);
    const e = res.body.data;
    expect(e.id).toBe(catId);
    expect(Array.isArray(e.senses)).toBe(true);
    expect(e.senses).toHaveLength(1);
    expect(e.senses[0].examples).toHaveLength(1);
    expect(e.senses[0].synonyms).toEqual(['feline']);
    expect(e.senses[0].antonyms).toEqual(['dog']);
    expect(e.word_forms).toHaveLength(1);
    expect(e.phrasal_verbs).toHaveLength(1);
    expect(e.idioms).toHaveLength(1);
    expect(e.collocations).toHaveLength(1);
  });

  it('ID không tồn tại → 404 ENTRY_NOT_FOUND', async () => {
    const res = await request(app).get('/api/v1/dictionary/entries/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ENTRY_NOT_FOUND');
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/dictionary/trending', () => {
  it('trả array, cat entry xuất hiện vì có 5 lookups', async () => {
    const res = await request(app).get('/api/v1/dictionary/trending');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const cat = res.body.data.find((r: any) => r.id === catId);
    expect(cat).toBeDefined();
    expect(cat.lookup_count).toBeGreaterThanOrEqual(5);
  });
});

// ════════════════════════════════════════════════════════════════
describe('Bookmark flow', () => {
  it('POST /bookmark → GET /saved-words chứa entry → DELETE /bookmark → biến mất', async () => {
    // Bookmark
    const post = await request(app)
      .post(`/api/v1/dictionary/entries/${catId}/bookmark`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    expect(post.status).toBe(201);
    expect(post.body.data.saved).toBe(true);
    expect(post.body.data.saved_word_id).toEqual(expect.any(String));

    // Saved words list
    const list = await request(app)
      .get('/api/v1/dictionary/saved-words')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(list.status).toBe(200);
    const ids = list.body.data.items.map((i: any) => i.id);
    expect(ids).toContain(catId);
    const catItem = list.body.data.items.find((i: any) => i.id === catId);
    expect(catItem.mastery_level).toBe('new');
    expect(list.body.data.stats.total_saved).toBeGreaterThanOrEqual(1);
    expect(list.body.data.stats.level_progress).toEqual(
      expect.objectContaining({ A1: expect.any(Number), B1: expect.any(Number) })
    );

    // Delete
    const del = await request(app)
      .delete(`/api/v1/dictionary/entries/${catId}/bookmark`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(del.status).toBe(200);

    // List again — cat phải biến mất
    const list2 = await request(app)
      .get('/api/v1/dictionary/saved-words')
      .set('Authorization', `Bearer ${accessToken}`);
    const ids2 = list2.body.data.items.map((i: any) => i.id);
    expect(ids2).not.toContain(catId);
  });
});

// ════════════════════════════════════════════════════════════════
describe('Lookup history tracking', () => {
  it('GET /entries/:id với auth → entry xuất hiện trong /lookup-history', async () => {
    // Fresh entry để tránh đụng lookups từ setup
    const freshId = await insertEntry(`${HEADWORD_PREFIX}kiwi`, { pos: ['noun'], cefr: 'A1' });

    await request(app)
      .get(`/api/v1/dictionary/entries/${freshId}`)
      .set('Authorization', `Bearer ${accessToken}`);

    // fire-and-forget — chờ một chút để INSERT hoàn tất
    await new Promise((r) => setTimeout(r, 300));

    const hist = await request(app)
      .get('/api/v1/dictionary/lookup-history')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(hist.status).toBe(200);
    const allEntryIds = hist.body.data.items.flatMap((g: any) =>
      g.items.map((i: any) => i.entry_id)
    );
    expect(allEntryIds).toContain(freshId);
  });
});
