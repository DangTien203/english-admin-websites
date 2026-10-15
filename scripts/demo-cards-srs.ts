/**
 * Demo 5 acceptance cases for GET /decks/:deckId/cards SRS join.
 * Run: tsx scripts/demo-cards-srs.ts
 */
import 'dotenv/config';
import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const HW = `srs${TS}`;

async function reg(suffix: string) {
  const email = `test-srs-${suffix}-${TS}@example.com`;
  const r = await request(app).post('/api/v1/auth/register').send({
    email, password: 'password123', full_name: `SRS ${suffix}`,
  });
  return { userId: r.body.data.user.id, accessToken: r.body.data.access_token };
}

function out(label: string, res: any, extra?: string) {
  console.log('\n──────── ' + label + (extra ? ` ${extra}` : ''));
  console.log(`HTTP ${res.status}`);
  if (res.body && res.body.data && Array.isArray(res.body.data.items)) {
    console.log(`items.length: ${res.body.data.items.length}`);
    if (res.body.data.items[0]) {
      console.log('items[0]:');
      console.log(JSON.stringify(res.body.data.items[0], null, 2));
    }
    if (res.body.data.items.length > 1) {
      console.log('items[1]:');
      console.log(JSON.stringify(res.body.data.items[1], null, 2));
    }
  } else {
    console.log(JSON.stringify(res.body, null, 2));
  }
}

async function main() {
  const userA = await reg('a');
  const userB = await reg('b');

  // Create 4 dictionary entries
  const entryIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const { rows } = await pool.query(
      `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, ipa_us, published, source)
       VALUES ($1, $1, $2, $3, $4, TRUE, 'manual') RETURNING id`,
      [`${HW}-${i}`, ['noun'], `nghia ${i}`, `/test${i}/`]
    );
    entryIds.push(rows[0].id);
  }

  // User A's deck (4 cards)
  const deckRes = await request(app)
    .post('/api/v1/decks').set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ title: `[srs-${TS}] deck` });
  const deckId = deckRes.body.data.id;
  await request(app)
    .post(`/api/v1/decks/${deckId}/cards/batch`)
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ entry_ids: entryIds });

  // ── (a) GET cards on deck where user has NOT studied → all SRS = null/0
  const a = await request(app)
    .get(`/api/v1/decks/${deckId}/cards`)
    .set('Authorization', `Bearer ${userA.accessToken}`);
  out('(a) GET /decks/<id>/cards — User A chưa học gì', a);

  // ── (b) Put 2 cards into Leitner via /practice/session/complete flow
  // Start a practice session with cards 0 and 1, answer correctly, complete → both go to Box 1
  const startRes = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({
      deck_id: deckId,
      mode: 'flashcard',
      card_ids: [a.body.data.items[0].card_id, a.body.data.items[1].card_id],
    });
  const sessionId = startRes.body.data.session_id;

  for (const card of startRes.body.data.cards) {
    await request(app)
      .post('/api/v1/practice/session/answer')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ session_id: sessionId, card_id: card.card_id, correct: true, time_ms: 1500 });
  }
  const completeRes = await request(app)
    .post('/api/v1/practice/session/complete')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ session_id: sessionId });
  console.log('\n[setup] /complete leitner_added:',
    JSON.stringify(completeRes.body.data.leitner_added));

  // Re-fetch cards — items 0 + 1 should have SRS data, items 2 + 3 should be null
  const b = await request(app)
    .get(`/api/v1/decks/${deckId}/cards`)
    .set('Authorization', `Bearer ${userA.accessToken}`);
  out('(b) GET /decks/<id>/cards — sau khi học 2 cards', b,
    `(items[0,1] nên có SRS; items[2,3] vẫn null)`);
  console.log('items[2] (chưa học):');
  console.log(JSON.stringify(b.body.data.items[2], null, 2));

  // ── (c) Per-user isolation: User B GET same deck → SRS all null
  // Note: deck is user_created by A, so B can't access — use a system deck instead.
  // For this demo, insert directly to bypass.
  const { rows: sysDeck } = await pool.query(
    `INSERT INTO decks (title, deck_type, status, level) VALUES ($1, 'premade', 'published', 'beginner') RETURNING id`,
    [`[srs-${TS}] system deck`]
  );
  const sysDeckId = sysDeck[0].id;
  for (let i = 0; i < 2; i++) {
    await pool.query(
      `INSERT INTO cards (deck_id, entry_id, sort_order) VALUES ($1, $2, $3)`,
      [sysDeckId, entryIds[i], i]
    );
  }
  // User A learns card 0 of system deck — manually inject into leitner_cards
  await pool.query(
    `INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at, last_reviewed_at, correct_streak, total_reviews, source, added_from_mode)
     VALUES ($1, $2, 2, NOW() + INTERVAL '2 days', NOW(), 1, 1, 'practice', 'flashcard')
     ON CONFLICT (user_id, entry_id) DO NOTHING`,
    [userA.userId, entryIds[0]]
  );
  const cA = await request(app)
    .get(`/api/v1/decks/${sysDeckId}/cards`)
    .set('Authorization', `Bearer ${userA.accessToken}`);
  out('(c-A) User A GET system deck — đã có Leitner row cho card 0', cA);
  const cB = await request(app)
    .get(`/api/v1/decks/${sysDeckId}/cards`)
    .set('Authorization', `Bearer ${userB.accessToken}`);
  out('(c-B) User B GET cùng system deck — KHÔNG thấy progress của A', cB);

  // ── (d) Performance: 200-card deck
  const bigEntryIds: string[] = [];
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query(
      `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, published, source)
       VALUES ($1, $1, $2, $3, TRUE, 'manual') RETURNING id`,
      [`${HW}-big${i}`, ['noun'], `big ${i}`]
    );
    bigEntryIds.push(rows[0].id);
  }
  const { rows: bigDeck } = await pool.query(
    `INSERT INTO decks (title, deck_type, user_id, status) VALUES ($1, 'user_created', $2, 'published') RETURNING id`,
    [`[srs-${TS}] big deck`, userA.userId]
  );
  const bigDeckId = bigDeck[0].id;
  for (let i = 0; i < 200; i++) {
    await pool.query(
      `INSERT INTO cards (deck_id, entry_id, sort_order) VALUES ($1, $2, $3)`,
      [bigDeckId, bigEntryIds[i], i]
    );
  }
  // Inject 50 leitner rows for variety
  for (let i = 0; i < 50; i++) {
    await pool.query(
      `INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at, last_reviewed_at, correct_streak, total_reviews, source, added_from_mode)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 day', NOW(), $3, $3, 'practice', 'flashcard')
       ON CONFLICT (user_id, entry_id) DO NOTHING`,
      [userA.userId, bigEntryIds[i], (i % 5) + 1]
    );
  }

  const t0 = Date.now();
  const d = await request(app)
    .get(`/api/v1/decks/${bigDeckId}/cards`)
    .set('Authorization', `Bearer ${userA.accessToken}`);
  const elapsed = Date.now() - t0;
  console.log(`\n──────── (d) Performance — 200-card deck`);
  console.log(`HTTP ${d.status}`);
  console.log(`items.length: ${d.body.data.items.length}`);
  console.log(`Elapsed: ${elapsed}ms (target: <500ms)`);
  console.log(`PASS: ${elapsed < 500 ? '✓' : '✗ (slow — consider index audit)'}`);

  // ── (e) Existing behavior: ?filter=mastered query param
  const e = await request(app)
    .get(`/api/v1/decks/${deckId}/cards?filter=mastered`)
    .set('Authorization', `Bearer ${userA.accessToken}`);
  out('(e) GET /decks/<id>/cards?filter=mastered', e);

  // Cleanup
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-srs-%'`);
  await pool.query(`DELETE FROM decks WHERE id = $1`, [sysDeckId]);
  await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1`, [`${HW}-%`]);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
