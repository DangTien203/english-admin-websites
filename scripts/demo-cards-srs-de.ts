/**
 * Demo cases (d) + (e) — performance + filter regression.
 * Run: tsx scripts/demo-cards-srs-de.ts
 */
import 'dotenv/config';
import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const HW = `srsde${TS}`;

async function reg(suffix: string) {
  const email = `test-srsde-${suffix}-${TS}@example.com`;
  const r = await request(app).post('/api/v1/auth/register').send({
    email, password: 'password123', full_name: `SRS-DE ${suffix}`,
  });
  return { userId: r.body.data.user.id, accessToken: r.body.data.access_token };
}

async function main() {
  const userA = await reg('a');

  // 200 cards big deck
  const bigEntryIds: string[] = [];
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query(
      `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, published, source)
       VALUES ($1, $1, $2, $3, TRUE, 'manual') RETURNING id`,
      [`${HW}-${i}`, ['noun'], `big ${i}`]
    );
    bigEntryIds.push(rows[0].id);
  }
  const { rows: bigDeck } = await pool.query(
    `INSERT INTO decks (title, deck_type, user_id, status) VALUES ($1, 'user_created', $2, 'published') RETURNING id`,
    [`[srsde-${TS}] big`, userA.userId]
  );
  const bigDeckId = bigDeck[0].id;
  for (let i = 0; i < 200; i++) {
    await pool.query(
      `INSERT INTO cards (deck_id, entry_id, sort_order) VALUES ($1, $2, $3)`,
      [bigDeckId, bigEntryIds[i], i]
    );
  }
  // Inject 50 leitner rows — explicit casts so pg doesn't conflate smallint vs int
  for (let i = 0; i < 50; i++) {
    const box = (i % 5) + 1;
    await pool.query(
      `INSERT INTO leitner_cards
         (user_id, entry_id, box_number, due_at, last_reviewed_at, correct_streak, total_reviews, source, added_from_mode)
       VALUES ($1, $2, $3::smallint, NOW() + INTERVAL '1 day', NOW(), $4::int, $5::int, 'practice', 'flashcard')
       ON CONFLICT (user_id, entry_id) DO NOTHING`,
      [userA.userId, bigEntryIds[i], box, box, box]
    );
  }

  // (d) — measure response time across 3 runs
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const d = await request(app)
      .get(`/api/v1/decks/${bigDeckId}/cards`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    const elapsed = Date.now() - t0;
    times.push(elapsed);
    console.log(`(d) run #${i + 1} — HTTP ${d.status}, items.length=${d.body.data.items.length}, ${elapsed}ms`);
  }
  const avg = Math.round(times.reduce((s, t) => s + t, 0) / times.length);
  console.log(`\n(d) Performance — 200 cards / 50 with Leitner: avg ${avg}ms (target <500ms — ${avg < 500 ? 'PASS ✓' : 'FAIL ✗'})`);

  // (e) — ?filter=mastered
  console.log('\n──────── (e) GET /decks/<id>/cards?filter=mastered');
  const e = await request(app)
    .get(`/api/v1/decks/${bigDeckId}/cards?filter=mastered`)
    .set('Authorization', `Bearer ${userA.accessToken}`);
  console.log(`HTTP ${e.status}`);
  console.log(`items.length: ${e.body.data.items.length}`);
  console.log(`Note: handler hiện KHÔNG support ?filter — query param bị ignore, trả full list.`);
  console.log(`Để verify: items.length === 200 (full deck), không phải chỉ box=5 cards.`);

  // Cleanup
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-srsde-%'`);
  await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1`, [`${HW}-%`]);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
