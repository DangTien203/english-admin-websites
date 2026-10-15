import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser, RegisteredUser } from './helpers/auth';

const TS = Date.now();
const HW_PREFIX = `pss${TS}`;

let user: RegisteredUser;
let deck12Id: string;            // user deck with 12 cards
let foreignDeckId: string;       // another user's deck — used to mint a "foreign" card_id
let foreignCardId: string;       // a card that does NOT belong to deck12Id

const TWELVE_CARD_IDS: string[] = [];

beforeAll(async () => {
  user = await registerUser('practice-start');
  const userOther = await registerUser('practice-start-other');

  // Insert 12 dictionary entries + 1 foreign entry
  const entryIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const { rows } = await pool.query(
      `INSERT INTO dictionary_entries
         (headword, lemma, pos, meaning_vi, published, source)
       VALUES ($1, $1, $2, $3, TRUE, 'manual')
       RETURNING id`,
      [`${HW_PREFIX}-${i}`, ['noun'], `nghia ${i}`]
    );
    entryIds.push(rows[0].id);
  }
  const { rows: foreignEntry } = await pool.query(
    `INSERT INTO dictionary_entries
       (headword, lemma, pos, meaning_vi, published, source)
     VALUES ($1, $1, $2, 'foreign', TRUE, 'manual')
     RETURNING id`,
    [`${HW_PREFIX}-foreign`, ['noun']]
  );
  const foreignEntryId = foreignEntry[0].id;

  // Create user's deck with 12 cards
  const deckRes = await request(app)
    .post('/api/v1/decks')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ title: `[pss-${TS}] 12-card deck` });
  if (deckRes.status !== 201) throw new Error(`deck: ${JSON.stringify(deckRes.body)}`);
  deck12Id = deckRes.body.data.id;

  // Add 12 cards via batch
  const batchRes = await request(app)
    .post(`/api/v1/decks/${deck12Id}/cards/batch`)
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ entry_ids: entryIds });
  if (batchRes.status !== 201) throw new Error(`batch: ${JSON.stringify(batchRes.body)}`);

  // Get card_ids for the 12 cards
  const cardsRes = await request(app)
    .get(`/api/v1/decks/${deck12Id}/cards`)
    .set('Authorization', `Bearer ${user.accessToken}`);
  for (const c of cardsRes.body.data.items) {
    TWELVE_CARD_IDS.push(c.card_id);
  }

  // Create a separate deck under another user, with one card → foreignCardId
  const foreignDeckRes = await request(app)
    .post('/api/v1/decks')
    .set('Authorization', `Bearer ${userOther.accessToken}`)
    .send({ title: `[pss-${TS}] foreign deck` });
  if (foreignDeckRes.status !== 201) throw new Error(`foreignDeck: ${JSON.stringify(foreignDeckRes.body)}`);
  foreignDeckId = foreignDeckRes.body.data.id;

  const fCardRes = await request(app)
    .post(`/api/v1/decks/${foreignDeckId}/cards`)
    .set('Authorization', `Bearer ${userOther.accessToken}`)
    .send({ entry_id: foreignEntryId });
  if (fCardRes.status !== 201) throw new Error(`foreignCard: ${JSON.stringify(fCardRes.body)}`);
  foreignCardId = fCardRes.body.data.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-practice-start-%'`);
  await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1`, [`${HW_PREFIX}-%`]);
  await pool.end();
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/practice/session/start — random + card_ids', () => {
  // (a) limit:5 → 5 random cards
  it('case (a): limit=5 returns 5 cards in random order across two calls', async () => {
    const r1 = await request(app)
      .post('/api/v1/practice/session/start')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ deck_id: deck12Id, mode: 'flashcard', limit: 5 });

    expect(r1.status).toBe(200);
    expect(r1.body.data.cards).toHaveLength(5);
    const ids1 = r1.body.data.cards.map((c: any) => c.card_id);

    // Run a second call — the order or selection should differ at least once across
    // multiple attempts. RANDOM() *can* coincidentally produce the same order, so
    // try up to 5 times.
    let differs = false;
    for (let i = 0; i < 5 && !differs; i++) {
      const r2 = await request(app)
        .post('/api/v1/practice/session/start')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ deck_id: deck12Id, mode: 'flashcard', limit: 5 });
      const ids2 = r2.body.data.cards.map((c: any) => c.card_id);
      if (ids1.join(',') !== ids2.join(',')) differs = true;
    }
    expect(differs).toBe(true);
  });

  // (b) limit > deck size → return all cards, no error
  it('case (b): limit=100 on 12-card deck returns 12 cards (no error)', async () => {
    const res = await request(app)
      .post('/api/v1/practice/session/start')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ deck_id: deck12Id, mode: 'flashcard', limit: 100 });

    expect(res.status).toBe(200);
    expect(res.body.data.cards).toHaveLength(12);
    expect(res.body.data.total_count).toBe(12);
  });

  // (c) card_ids: [single valid uuid in deck] → 1 card, exact match
  it('case (c): card_ids with one valid uuid returns exactly 1 card', async () => {
    const target = TWELVE_CARD_IDS[3];
    const res = await request(app)
      .post('/api/v1/practice/session/start')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ deck_id: deck12Id, mode: 'flashcard', card_ids: [target] });

    expect(res.status).toBe(200);
    expect(res.body.data.cards).toHaveLength(1);
    expect(res.body.data.cards[0].card_id).toBe(target);
  });

  // (d) card_ids contains foreign uuid → 400 INVALID_CARDS
  it('case (d): card_ids with foreign uuid → 400 INVALID_CARDS with details', async () => {
    const res = await request(app)
      .post('/api/v1/practice/session/start')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        deck_id: deck12Id,
        mode: 'flashcard',
        card_ids: [TWELVE_CARD_IDS[0], foreignCardId],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CARDS');
    expect(res.body.error.details.invalid_card_ids).toEqual([foreignCardId]);
  });

  // (e) card_ids: [] → 400 VALIDATION_ERROR
  it('case (e): card_ids empty array → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/v1/practice/session/start')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ deck_id: deck12Id, mode: 'flashcard', card_ids: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // (f) card_ids with duplicates → dedupe silently → 1 card
  it('case (f): card_ids with duplicates returns 1 card (dedupe silent)', async () => {
    const target = TWELVE_CARD_IDS[5];
    const res = await request(app)
      .post('/api/v1/practice/session/start')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        deck_id: deck12Id,
        mode: 'flashcard',
        card_ids: [target, target, target],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.cards).toHaveLength(1);
    expect(res.body.data.cards[0].card_id).toBe(target);
  });

  // Bonus: card_ids wins over limit when both present
  it('bonus: when both card_ids and limit are present, card_ids wins', async () => {
    const targets = [TWELVE_CARD_IDS[0], TWELVE_CARD_IDS[1]];
    const res = await request(app)
      .post('/api/v1/practice/session/start')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        deck_id: deck12Id,
        mode: 'flashcard',
        limit: 100,
        card_ids: targets,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.cards).toHaveLength(2);
    const returned = res.body.data.cards.map((c: any) => c.card_id).sort();
    expect(returned).toEqual([...targets].sort());
  });

  // Bonus: random selection works for swift_choice + cloze_craft too
  it('bonus: random selection applies to swift_choice and cloze_craft', async () => {
    for (const mode of ['swift_choice', 'cloze_craft'] as const) {
      const res = await request(app)
        .post('/api/v1/practice/session/start')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ deck_id: deck12Id, mode, limit: 5 });
      expect(res.status).toBe(200);
      expect(res.body.data.mode).toBe(mode);
      expect(res.body.data.cards.length).toBeLessThanOrEqual(5);
    }
  });
});
