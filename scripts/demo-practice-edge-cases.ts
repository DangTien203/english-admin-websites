/**
 * Demo all edge cases needed for the final report.
 * Run: tsx scripts/demo-practice-edge-cases.ts
 */
import 'dotenv/config';
import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const HW_PREFIX = `pssec${TS}`;

async function reg(suffix: string) {
  const email = `test-pssec-${suffix}-${TS}@example.com`;
  const r = await request(app).post('/api/v1/auth/register').send({
    email, password: 'password123', full_name: `EdgeCase ${suffix}`,
  });
  return { userId: r.body.data.user.id, accessToken: r.body.data.access_token };
}

function out(label: string, res: any) {
  console.log('\n──────── ' + label);
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(res.body, null, 2));
}

async function main() {
  const userA = await reg('a');
  const userB = await reg('b');

  // 12-card deck
  const entryIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const { rows } = await pool.query(
      `INSERT INTO dictionary_entries
         (headword, lemma, pos, meaning_vi, ipa_us, published, source)
       VALUES ($1, $1, $2, $3, $4, TRUE, 'manual') RETURNING id`,
      [`${HW_PREFIX}-${i}`, ['noun'], `nghia ${i}`, `/test${i}/`]
    );
    entryIds.push(rows[0].id);
  }
  const deckRes = await request(app)
    .post('/api/v1/decks').set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ title: `[ec-${TS}] 12-card` });
  const deckId = deckRes.body.data.id;
  await request(app)
    .post(`/api/v1/decks/${deckId}/cards/batch`)
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ entry_ids: entryIds });
  const cardsRes = await request(app)
    .get(`/api/v1/decks/${deckId}/cards`)
    .set('Authorization', `Bearer ${userA.accessToken}`);
  const cardIds: string[] = cardsRes.body.data.items.map((c: any) => c.card_id);

  // Bypass free-plan deck quota with direct INSERT (admin-side equivalent).
  const { rows: emptyD } = await pool.query(
    `INSERT INTO decks (title, deck_type, user_id, status) VALUES ($1, 'user_created', $2, 'published') RETURNING id`,
    [`[ec-${TS}] empty`, userA.userId]
  );
  const emptyDeckId = emptyD[0].id;

  const { rows: smallD } = await pool.query(
    `INSERT INTO decks (title, deck_type, user_id, status) VALUES ($1, 'user_created', $2, 'published') RETURNING id`,
    [`[ec-${TS}] 3-card`, userA.userId]
  );
  const smallDeckId = smallD[0].id;
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO cards (deck_id, entry_id, sort_order) VALUES ($1, $2, $3)`,
      [smallDeckId, entryIds[i], i]
    );
  }

  // Foreign deck (userB)
  const { rows: fD } = await pool.query(
    `INSERT INTO decks (title, deck_type, user_id, status) VALUES ($1, 'user_created', $2, 'published') RETURNING id`,
    [`[ec-${TS}] foreign`, userB.userId]
  );
  const fDeckId = fD[0].id;
  const { rows: fCard } = await pool.query(
    `INSERT INTO cards (deck_id, entry_id, sort_order) VALUES ($1, $2, 0) RETURNING id`,
    [fDeckId, entryIds[0]]
  );
  const foreignCardId = fCard[0].id;

  // ── 4a: card_ids with valid + foreign uuid → check if invalid_card_ids shows ALL or only foreign
  const r4a = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', card_ids: [cardIds[0], foreignCardId] });
  out('4a card_ids=[valid, foreign] → INVALID_CARDS contains ONLY foreign', r4a);

  // ── 4c: card_ids with non-uuid string
  const r4c = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', card_ids: ['not-a-uuid'] });
  out('4c card_ids=["not-a-uuid"] → VALIDATION_ERROR (Zod uuid)', r4c);

  // ── 4d: card_ids with 500 items
  const tooMany = Array.from({ length: 500 }, () => '00000000-0000-0000-0000-000000000000');
  const r4d = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', card_ids: tooMany });
  out('4d card_ids has 500 items → VALIDATION_ERROR (max 200)', r4d);

  // ── 4e: deck_id non-existent
  const r4e = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: '00000000-0000-0000-0000-000000000000', mode: 'flashcard', limit: 5 });
  out('4e deck_id non-existent → DECK_NOT_FOUND', r4e);

  // ── 4f: deck_id of another user
  const r4f = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: fDeckId, mode: 'flashcard', limit: 5 });
  out('4f deck_id of another user → ?', r4f);

  // ── 5a: empty deck (0 cards)
  const r5a = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: emptyDeckId, mode: 'flashcard', limit: 5 });
  out('5a empty deck → 200 with cards: []', r5a);

  // ── 5b: card_ids dedupe verify
  const r5b = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', card_ids: [cardIds[0], cardIds[0], cardIds[1]] });
  out('5b card_ids=[uuid1, uuid1, uuid2] → cards.length === 2', r5b);

  // ── 5d: /answer with card_id NOT in session
  const startRes = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', card_ids: [cardIds[0]] });
  const sid = startRes.body.data.session_id;
  // cardIds[5] is NOT in session (only cardIds[0] was)
  const r5d = await request(app)
    .post('/api/v1/practice/session/answer')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ session_id: sid, card_id: cardIds[5], correct: true, time_ms: 1000 });
  out('5d /answer with card_id NOT in session_id (but in deck) → ?', r5d);

  // ── 5f: concurrent sessions
  const r5f1 = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', limit: 5 });
  const r5f2 = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', limit: 5 });
  out('5f concurrent session 1', r5f1);
  out('5f concurrent session 2 (same user same deck)', r5f2);

  // ── 3b: limit > deck size on small deck (3 cards)
  const r3b = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ deck_id: smallDeckId, mode: 'flashcard', limit: 100 });
  out('3b small_deck (3 cards) + limit=100 → cards.length === 3', r3b);

  // Cleanup
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-pssec-%'`);
  await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1`, [`${HW_PREFIX}-%`]);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
