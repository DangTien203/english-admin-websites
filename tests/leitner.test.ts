import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const EMAIL_PREFIX = `phase6l-${TS}-`;

let access_token = '';
let userId = '';
let testDeckId = '';
let testEntryIds: string[] = []; // 5 entries
let testCardIds: string[] = [];  // 5 cards (parallel index)

beforeAll(async () => {
  // Register user
  const reg = await request(app).post('/api/v1/auth/register').send({
    email: `${EMAIL_PREFIX}1@example.com`,
    password: 'password123',
    full_name: 'Leitner Tester',
  });
  if (reg.status !== 201) throw new Error(`Register failed: ${JSON.stringify(reg.body)}`);
  access_token = reg.body.data.access_token;

  const { rows: userRows } = await pool.query(
    `SELECT id FROM users WHERE email = $1`,
    [`${EMAIL_PREFIX}1@example.com`]
  );
  userId = userRows[0].id;

  // Create deck
  const deckRes = await request(app)
    .post('/api/v1/decks')
    .set('Authorization', `Bearer ${access_token}`)
    .send({ title: 'Leitner Test Deck', level: 'beginner' });
  if (deckRes.status !== 201) throw new Error(`Deck failed: ${JSON.stringify(deckRes.body)}`);
  testDeckId = deckRes.body.data.id;

  // Insert 5 entries + add to deck
  for (let i = 1; i <= 5; i++) {
    const headword = `phase6l-entry-${TS}-${i}`;
    const meanings = [
      'và (nối từ, cụm từ, mệnh đề)',
      'Leitner test meaning 2',
      'Leitner test meaning 3',
      'Leitner test meaning 4',
      'Leitner test meaning 5',
    ];
    const { rows: entryRows } = await pool.query(
      `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, published, source)
       VALUES ($1, $1, $2, $3, TRUE, 'manual') RETURNING id`,
      [headword, ['noun'], meanings[i - 1]]
    );
    const entryId: string = entryRows[0].id;
    testEntryIds.push(entryId);

    const cardRes = await request(app)
      .post(`/api/v1/decks/${testDeckId}/cards`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ entry_id: entryId });
    if (cardRes.status !== 201) throw new Error(`Card failed: ${JSON.stringify(cardRes.body)}`);
    testCardIds.push(cardRes.body.data.id as string);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  await pool.query(
    `DELETE FROM dictionary_entries WHERE headword LIKE $1`,
    [`phase6l-entry-${TS}%`]
  );
  await pool.end();
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/leitner/overview — new user', () => {
  it('returns 5 boxes all empty for a user with no leitner cards', async () => {
    const res = await request(app)
      .get('/api/v1/leitner/overview')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { boxes, today_due_total, stats } = res.body.data;
    expect(boxes).toHaveLength(5);
    expect(today_due_total).toBe(0);
    for (const box of boxes) {
      expect(box.total_cards).toBe(0);
      expect(box.due_today).toBe(0);
      expect(typeof box.interval_days).toBe('number');
    }
    expect(typeof stats.retention_30d).toBe('number');
    expect(typeof stats.mastered_all_time).toBe('number');
  });
});

// ════════════════════════════════════════════════════════════════
describe('Practice session → Leitner auto-add', () => {
  it('3 correct answers out of 5 create 3 leitner_cards in box 1', async () => {
    // Start session
    const startRes = await request(app)
      .post('/api/v1/practice/session/start')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ deck_id: testDeckId, mode: 'flashcard' });
    expect(startRes.status).toBe(200);

    const { session_id, cards } = startRes.body.data;
    expect(Array.isArray(cards)).toBe(true);
    expect(cards.length).toBeGreaterThanOrEqual(5);

    // Answer: cards 0,1,2 → correct; cards 3,4 → wrong
    for (let i = 0; i < 5; i++) {
      const ansRes = await request(app)
        .post('/api/v1/practice/session/answer')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ session_id, card_id: cards[i].card_id, correct: i < 3 });
      expect(ansRes.status).toBe(200);
    }

    // Complete session
    const completeRes = await request(app)
      .post('/api/v1/practice/session/complete')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ session_id });
    expect(completeRes.status).toBe(200);

    // Verify exactly 3 leitner_cards were created
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM leitner_cards WHERE user_id = $1`,
      [userId]
    );
    expect(rows[0].cnt).toBe(3);

    // All must be in box 1
    const { rows: boxRows } = await pool.query(
      `SELECT DISTINCT box_number FROM leitner_cards WHERE user_id = $1`,
      [userId]
    );
    expect(boxRows).toHaveLength(1);
    expect(boxRows[0].box_number).toBe(1);
  });

  it('answering the same 3 cards correctly again does NOT duplicate leitner_cards', async () => {
    const startRes = await request(app)
      .post('/api/v1/practice/session/start')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ deck_id: testDeckId, mode: 'flashcard' });
    expect(startRes.status).toBe(200);

    const { session_id, cards } = startRes.body.data;

    // Answer all 5 cards correctly this time
    for (const card of cards.slice(0, 5)) {
      await request(app)
        .post('/api/v1/practice/session/answer')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ session_id, card_id: card.card_id, correct: true });
    }
    await request(app)
      .post('/api/v1/practice/session/complete')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ session_id });

    // Count must be exactly 5 now (3 old + 2 newly added), not 8
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM leitner_cards WHERE user_id = $1`,
      [userId]
    );
    expect(rows[0].cnt).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/leitner/due', () => {
  it('returns cards whose due_at <= now, ordered by due_at ASC', async () => {
    // Make all 5 leitner_cards due
    await pool.query(
      `UPDATE leitner_cards SET due_at = NOW() - INTERVAL '1 second' WHERE user_id = $1`,
      [userId]
    );

    const res = await request(app)
      .get('/api/v1/leitner/due')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { items, meta } = res.body.data;
    expect(meta.total_due).toBe(5);
    expect(items).toHaveLength(5);

    // Shape check
    const first = items[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('box_number');
    expect(first).toHaveProperty('due_at');
    expect(first).toHaveProperty('entry');
    expect(first.entry).toHaveProperty('headword');
    expect(first.entry).toHaveProperty('ipa_us');
    expect(first.entry).toHaveProperty('pos');
    expect(first.entry).toHaveProperty('meaning_preview');
    expect(first.entry).toHaveProperty('accepted_answers');
    // Nullable fields must be present (not missing/undefined)
    expect('last_reviewed_at' in first).toBe(true);
    expect('added_from_mode' in first).toBe(true);
    expect('ipa_uk' in first.entry).toBe(true);

    // Order: due_at ASC
    for (let i = 1; i < items.length; i++) {
      expect(new Date(items[i - 1].due_at).getTime())
        .toBeLessThanOrEqual(new Date(items[i].due_at).getTime());
    }
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/leitner/box/:box_number', () => {
  it('box/1 returns every card that is in box 1, with the full entry shape', async () => {
    // Since the Leitner rewrite a correct practice answer moves a card that is already in a box to the NEXT box, so the second
    // practice session above leaves the 3 old cards in box 2 and only the 2 new words in box 1 (it used to leave all 5 in box 1).
    const { rows: inBox1 } = await pool.query(`SELECT COUNT(*)::int AS n FROM leitner_cards WHERE user_id = $1 AND box_number = 1`, [userId]);
    const { rows: inBox2 } = await pool.query(`SELECT COUNT(*)::int AS n FROM leitner_cards WHERE user_id = $1 AND box_number = 2`, [userId]);
    expect(inBox1[0].n + inBox2[0].n).toBe(5); // nothing was lost or duplicated
    expect(inBox1[0].n).toBeGreaterThan(0);

    const res = await request(app)
      .get('/api/v1/leitner/box/1')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.box_number).toBe(1);
    expect(res.body.data.total).toBe(inBox1[0].n);
    expect(res.body.data.items).toHaveLength(inBox1[0].n);
    expect(typeof res.body.data.page).toBe('number');
    expect(typeof res.body.data.limit).toBe('number');

    // Each card: 11 top-level fields + nested entry with 9 fields
    const card = res.body.data.items[0];
    expect(card).toHaveProperty('id');
    expect(card).toHaveProperty('entry_id');
    expect(card).toHaveProperty('box_number');
    expect(card).toHaveProperty('due_at');
    expect('last_reviewed_at' in card).toBe(true);   // null OK, must not be missing
    expect('added_from_mode' in card).toBe(true);
    expect(card).toHaveProperty('correct_streak');
    expect(card).toHaveProperty('total_reviews');
    expect(card).toHaveProperty('source');
    expect(card).toHaveProperty('created_at');
    expect(card).toHaveProperty('entry');

    const entry = card.entry;
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('headword');
    expect('lemma' in entry).toBe(true);
    expect('ipa_us' in entry).toBe(true);
    expect('ipa_uk' in entry).toBe(true);
    expect('audio_us_url' in entry).toBe(true);
    expect('audio_uk_url' in entry).toBe(true);
    expect(Array.isArray(entry.pos)).toBe(true);
    expect('meaning_preview' in entry).toBe(true);
    expect('accepted_answers' in entry).toBe(true);
    expect('cefr_level' in entry).toBe(true);
  });

  it('box/6 → 400 INVALID_BOX_NUMBER', async () => {
    const res = await request(app)
      .get('/api/v1/leitner/box/6')
      .set('Authorization', `Bearer ${access_token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BOX_NUMBER');
  });
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/leitner/review', () => {
  let targetCardId = ''; // leitner_card id for entry 0

  beforeAll(async () => {
    // Fetch the leitner_card id for our first entry
    const { rows } = await pool.query(
      `SELECT id FROM leitner_cards WHERE user_id = $1 AND entry_id = $2`,
      [userId, testEntryIds[0]]
    );
    targetCardId = rows[0].id;
  });

  it('correct=true moves card from box 1 → box 2, next_due ~2 days', async () => {
    // Ensure card is in box 1
    await pool.query(
      `UPDATE leitner_cards SET box_number = 1 WHERE id = $1`,
      [targetCardId]
    );

    const before = Date.now();
    const res = await request(app)
      .post('/api/v1/leitner/review')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ leitner_card_id: targetCardId, correct: true });

    expect(res.status).toBe(200);
    expect(res.body.data.new_box_number).toBe(2);
    expect(res.body.data.mastered_now).toBe(false);

    const nextDue = new Date(res.body.data.next_due_at).getTime();
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    expect(nextDue).toBeGreaterThan(before + twoDaysMs - 5000);
    expect(nextDue).toBeLessThan(before + twoDaysMs + 5000);
  });

  // Box 4 and 5 are checked on BOTH meanings in a review session (POST /leitner/session/start); the single-answer endpoint
  // refuses them. (These two tests used to expect 4 -> 5 and 5 -> 1 from this endpoint.)
  it.each([4, 5])('a card in box %i is refused here with 409 REVIEW_SESSION_REQUIRED and stays where it is', async (box) => {
    await pool.query(`UPDATE leitner_cards SET box_number = $2 WHERE id = $1`, [targetCardId, box]);

    for (const body of [{ correct: true }, { correct: false }]) {
      const res = await request(app)
        .post('/api/v1/leitner/review')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ leitner_card_id: targetCardId, ...body });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REVIEW_SESSION_REQUIRED');
    }

    const { rows } = await pool.query(`SELECT box_number FROM leitner_cards WHERE id = $1`, [targetCardId]);
    expect(rows[0].box_number).toBe(box);
  });

  it('correct=false from box 3 → box 1', async () => {
    await pool.query(`UPDATE leitner_cards SET box_number = 3 WHERE id = $1`, [targetCardId]);

    const res = await request(app)
      .post('/api/v1/leitner/review')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ leitner_card_id: targetCardId, correct: false });

    expect(res.status).toBe(200);
    expect(res.body.data.new_box_number).toBe(1);
    expect(res.body.data.mastered_now).toBe(false);

    const { rows } = await pool.query(
      `SELECT box_number FROM leitner_cards WHERE id = $1`,
      [targetCardId]
    );
    expect(rows[0].box_number).toBe(1);
  });

  it('user_answer accepts core answer before parenthetical notes and overrides stale client correct=false', async () => {
    await pool.query(
      `UPDATE leitner_cards SET box_number = 2 WHERE id = $1`,
      [targetCardId]
    );

    const res = await request(app)
      .post('/api/v1/leitner/review')
      .set('Authorization', `Bearer ${access_token}`)
      .send({
        leitner_card_id: targetCardId,
        user_answer: 'và',
        correct: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.new_box_number).toBe(3);
    expect(res.body.data.grading).toMatchObject({
      correct: true,
      verdict: 'correct',
      grading_source: 'exact',
      matched_answer: 'và',
      accepted_answers: ['và'],
    });
  });

  it('unknown leitner_card_id → 404 CARD_NOT_FOUND', async () => {
    const res = await request(app)
      .post('/api/v1/leitner/review')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ leitner_card_id: '00000000-0000-0000-0000-000000000000', correct: true });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CARD_NOT_FOUND');
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/leitner/stats', () => {
  it('range=30d returns correct shapes', async () => {
    const res = await request(app)
      .get('/api/v1/leitner/stats?range=30d')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { distribution, retention_rate, top_hardest, top_easiest } = res.body.data;

    expect(distribution).toHaveProperty('box_1');
    expect(distribution).toHaveProperty('box_5');
    expect(typeof retention_rate).toBe('number');
    expect(Array.isArray(top_hardest)).toBe(true);
    expect(Array.isArray(top_easiest)).toBe(true);
    if (top_hardest.length > 0) {
      expect(top_hardest[0]).toHaveProperty('lapses');
      expect(top_hardest[0]).toHaveProperty('headword');
    }
    if (top_easiest.length > 0) {
      expect(top_easiest[0]).toHaveProperty('consecutive_correct');
    }
  });

  it('invalid range → 400 INVALID_RANGE', async () => {
    const res = await request(app)
      .get('/api/v1/leitner/stats?range=999d')
      .set('Authorization', `Bearer ${access_token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RANGE');
  });
});
