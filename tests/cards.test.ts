import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const EMAIL_PREFIX = `phase4c-${TS}-`;

let accessToken = '';
let testDeckId = '';
let testEntryId = '';
let testEntryId2 = '';
let testCardId = '';

beforeAll(async () => {
  // Register user
  const reg = await request(app).post('/api/v1/auth/register').send({
    email: `${EMAIL_PREFIX}1@example.com`,
    password: 'password123',
    full_name: 'Card Tester',
  });
  if (reg.status !== 201) throw new Error(`Setup: ${JSON.stringify(reg.body)}`);
  accessToken = reg.body.data.access_token;

  // Insert test dictionary entries
  const { rows: e1 } = await pool.query(
    `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, published, source)
     VALUES ($1, $1, $2, 'Nghĩa test 1', TRUE, 'manual') RETURNING id`,
    [`phase4c-entry1-${TS}`, ['noun']]
  );
  testEntryId = e1[0].id;

  const { rows: e2 } = await pool.query(
    `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, published, source)
     VALUES ($1, $1, $2, 'Nghĩa test 2', TRUE, 'manual') RETURNING id`,
    [`phase4c-entry2-${TS}`, ['verb']]
  );
  testEntryId2 = e2[0].id;

  // Create test deck via API
  const deckRes = await request(app)
    .post('/api/v1/decks')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ title: 'Card Test Deck', level: 'beginner' });
  if (deckRes.status !== 201) throw new Error(`Deck setup: ${JSON.stringify(deckRes.body)}`);
  testDeckId = deckRes.body.data.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  await pool.query(
    `DELETE FROM dictionary_entries WHERE headword LIKE $1`,
    [`phase4c-entry%-${TS}`]
  );
  // decks cascade-deleted with users? No — decks.user_id → ON DELETE CASCADE → deck deleted
  await pool.end();
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/decks/:deckId/cards — add single card', () => {
  it('adds a card and initializes SRS state', async () => {
    const res = await request(app)
      .post(`/api/v1/decks/${testDeckId}/cards`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ entry_id: testEntryId });

    expect(res.status).toBe(201);
    expect(res.body.data.entry_id).toBe(testEntryId);
    expect(res.body.data.srs).not.toBeNull();
    expect(res.body.data.srs.times_seen).toBe(0);
    expect(res.body.data.srs.leitner_box_number).toBeNull();
    testCardId = res.body.data.id;
  });

  it('409 CARD_ALREADY_EXISTS on duplicate', async () => {
    const res = await request(app)
      .post(`/api/v1/decks/${testDeckId}/cards`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ entry_id: testEntryId });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CARD_ALREADY_EXISTS');
  });
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/decks/:deckId/cards/batch — bulk add', () => {
  it('adds new + skips duplicate, returns correct counts', async () => {
    // testEntryId already in deck, testEntryId2 is new
    const res = await request(app)
      .post(`/api/v1/decks/${testDeckId}/cards/batch`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ entry_ids: [testEntryId, testEntryId2] });

    expect(res.status).toBe(201);
    expect(res.body.data.added).toBe(1);
    expect(res.body.data.skipped).toBe(1);
    expect(res.body.data.entry_ids_added).toContain(testEntryId2);
    expect(res.body.data.entry_ids_added).not.toContain(testEntryId);
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/decks/:deckId/cards — list cards', () => {
  it('returns cards with entry headword and SRS state', async () => {
    const res = await request(app)
      .get(`/api/v1/decks/${testDeckId}/cards`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(2);
    const card = res.body.data.items.find((c: any) => c.entry_id === testEntryId);
    expect(card).toBeDefined();
    expect(card).toHaveProperty('headword');
    expect(card.is_new).toBe(false); // has SRS record
  });
});

// ════════════════════════════════════════════════════════════════
describe('DELETE /api/v1/decks/:deckId/cards/:cardId — remove card', () => {
  it('removes card successfully', async () => {
    const del = await request(app)
      .delete(`/api/v1/decks/${testDeckId}/cards/${testCardId}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(del.status).toBe(200);

    // Card should be gone from list
    const list = await request(app)
      .get(`/api/v1/decks/${testDeckId}/cards`)
      .set('Authorization', `Bearer ${accessToken}`);
    const cardIds = list.body.data.items.map((c: any) => c.card_id);
    expect(cardIds).not.toContain(testCardId);
  });

  it('404 CARD_NOT_FOUND for already-deleted card', async () => {
    const res = await request(app)
      .delete(`/api/v1/decks/${testDeckId}/cards/${testCardId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CARD_NOT_FOUND');
  });
});
