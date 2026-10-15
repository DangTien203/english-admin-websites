import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const EMAIL_PREFIX = `phase4d-${TS}-`;

let tokenA = '';
let tokenB = '';
let userAId = '';
let testEntryId = '';
let testDeckId = '';
let testDeckBId = '';

beforeAll(async () => {
  // Register user A
  const regA = await request(app).post('/api/v1/auth/register').send({
    email: `${EMAIL_PREFIX}a@example.com`,
    password: 'password123',
    full_name: 'Deck Tester A',
  });
  if (regA.status !== 201) throw new Error(`Setup A: ${JSON.stringify(regA.body)}`);
  tokenA = regA.body.data.access_token;

  // Register user B
  const regB = await request(app).post('/api/v1/auth/register').send({
    email: `${EMAIL_PREFIX}b@example.com`,
    password: 'password123',
    full_name: 'Deck Tester B',
  });
  if (regB.status !== 201) throw new Error(`Setup B: ${JSON.stringify(regB.body)}`);
  tokenB = regB.body.data.access_token;

  // Fetch user A's ID
  const { rows: uRows } = await pool.query(
    `SELECT id, email FROM users WHERE email LIKE $1`,
    [`${EMAIL_PREFIX}%`]
  );
  for (const r of uRows) {
    if (r.email.endsWith('a@example.com')) userAId = r.id;
  }

  // Insert a test dictionary entry
  const { rows: eRows } = await pool.query(
    `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, published, source)
     VALUES ($1, $1, $2, 'Nghĩa test', TRUE, 'manual') RETURNING id`,
    [`phase4d-entry-${TS}`, ['noun']]
  );
  testEntryId = eRows[0].id;

  // Pre-create user B's deck for cross-user tests
  const deckB = await request(app)
    .post('/api/v1/decks')
    .set('Authorization', `Bearer ${tokenB}`)
    .send({ title: 'Deck B Private' });
  if (deckB.status !== 201) throw new Error(`Setup deckB: ${JSON.stringify(deckB.body)}`);
  testDeckBId = deckB.body.data.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  await pool.query(
    `DELETE FROM dictionary_entries WHERE headword = $1`,
    [`phase4d-entry-${TS}`]
  );
  await pool.end();
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/decks — create user deck', () => {
  it('creates a user_created deck with user_id matching JWT', async () => {
    const res = await request(app)
      .post('/api/v1/decks')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'My Test Deck', level: 'beginner' });

    expect(res.status).toBe(201);
    expect(res.body.data.deck_type).toBe('user_created');
    expect(res.body.data.title).toBe('My Test Deck');
    expect(res.body.data.user_id).toBe(userAId);
    testDeckId = res.body.data.id;
  });

  it('rejects title shorter than 3 chars', async () => {
    const res = await request(app)
      .post('/api/v1/decks')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'AB' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/decks — list decks', () => {
  it('returns deck list with summary stats shape', async () => {
    const res = await request(app)
      .get('/api/v1/decks')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toHaveProperty('total_decks');
    expect(res.body.data.summary).toHaveProperty('total_due_cards');
    expect(Array.isArray(res.body.data.items)).toBe(true);
    const deck = res.body.data.items.find((d: any) => d.id === testDeckId);
    expect(deck).toBeDefined();
    expect(deck).toHaveProperty('total_cards');
    expect(deck).toHaveProperty('due_cards');
    expect(deck).toHaveProperty('mastered_cards');
  });

  it("does NOT include another user's user_created deck", async () => {
    const res = await request(app)
      .get('/api/v1/decks')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((d: any) => d.id);
    expect(ids).not.toContain(testDeckBId);
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/decks/:id — get deck details', () => {
  it('returns full deck data with card_preview array', async () => {
    const res = await request(app)
      .get(`/api/v1/decks/${testDeckId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(testDeckId);
    expect(res.body.data).toHaveProperty('total_cards');
    expect(res.body.data).toHaveProperty('card_preview');
  });

  it('404 for non-existent deck', async () => {
    const res = await request(app)
      .get('/api/v1/decks/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DECK_NOT_FOUND');
  });

  it("404 when accessing another user's user_created deck", async () => {
    const res = await request(app)
      .get(`/api/v1/decks/${testDeckBId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DECK_NOT_FOUND');
  });
});

// ════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/decks/:id — update deck', () => {
  it('owner can update title', async () => {
    const res = await request(app)
      .patch(`/api/v1/decks/${testDeckId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Updated Title' });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Updated Title');
  });

  it('non-owner gets 403 DECK_ACCESS_DENIED', async () => {
    const res = await request(app)
      .patch(`/api/v1/decks/${testDeckId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: 'Stolen Title' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DECK_ACCESS_DENIED');
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/decks — Phase 6 regression (leitner_cards schema)', () => {
  it('returns 200 with due_cards and mastered_cards fields (leitner-backed)', async () => {
    const res = await request(app)
      .get('/api/v1/decks?page=1&limit=50')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toBeInstanceOf(Array);

    expect(res.body.data.summary).toHaveProperty('total_due_cards');
    expect(typeof res.body.data.summary.total_due_cards).toBe('number');

    if (res.body.data.items.length > 0) {
      const deck = res.body.data.items[0];
      expect(deck).toHaveProperty('total_cards');
      expect(deck).toHaveProperty('due_cards');
      expect(deck).toHaveProperty('mastered_cards');
      expect(deck).toHaveProperty('started_cards');
      expect(typeof deck.total_cards).toBe('number');
      expect(typeof deck.due_cards).toBe('number');
      expect(typeof deck.mastered_cards).toBe('number');
    }
  });

  it('GET /api/v1/decks/:id — due_cards and mastered_cards fields present', async () => {
    // Create a fresh deck for this test (testDeckId may be deleted by previous describe block)
    const deckRes = await request(app)
      .post('/api/v1/decks')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Phase6 Regression Deck', level: 'beginner' });
    expect(deckRes.status).toBe(201);
    const freshDeckId = deckRes.body.data.id;

    const res = await request(app)
      .get(`/api/v1/decks/${freshDeckId}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('due_cards');
    expect(res.body.data).toHaveProperty('mastered_cards');
    expect(typeof res.body.data.due_cards).toBe('number');
    expect(typeof res.body.data.mastered_cards).toBe('number');
  });
});

// ════════════════════════════════════════════════════════════════
describe('DELETE /api/v1/decks/:id — delete deck', () => {
  it("non-owner gets 403 DECK_ACCESS_DENIED on another user's deck", async () => {
    const res = await request(app)
      .delete(`/api/v1/decks/${testDeckBId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DECK_ACCESS_DENIED');
  });

  it('owner can delete; subsequent GET returns 404', async () => {
    const del = await request(app)
      .delete(`/api/v1/decks/${testDeckId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(del.status).toBe(200);

    const get = await request(app)
      .get(`/api/v1/decks/${testDeckId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(get.status).toBe(404);
  });
});
