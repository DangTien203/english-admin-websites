/**
 * Demo all 7 acceptance cases for /api/v1/leitner/{swift-choice,cloze,pair-link} endpoints.
 * Run: tsx scripts/demo-leitner-questions.ts
 *
 * Cleans up after itself.
 */
import 'dotenv/config';
import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const HW = `lq${TS}`;

interface Reg { userId: string; accessToken: string; }

async function reg(suffix: string): Promise<Reg> {
  const email = `test-lq-${suffix}-${TS}@example.com`;
  const r = await request(app).post('/api/v1/auth/register').send({
    email, password: 'password123', full_name: `LQ ${suffix}`,
  });
  return { userId: r.body.data.user.id, accessToken: r.body.data.access_token };
}

function out(label: string, res: any, fullBody: boolean = true) {
  console.log('\n══════════════ ' + label);
  console.log(`HTTP ${res.status}`);
  if (fullBody) {
    console.log(JSON.stringify(res.body, null, 2));
  } else {
    console.log(`success=${res.body?.success}, data keys: ${Object.keys(res.body?.data || {}).join(', ')}`);
  }
}

async function main() {
  const userA = await reg('a');
  const userB = await reg('b');

  // ── Setup: 5 entries with VI definitions, IPA, pos, cefr_level B1 ────────────
  const entryIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const { rows } = await pool.query(
      `INSERT INTO dictionary_entries
         (headword, lemma, pos, meaning_vi, ipa_us, cefr_level, example_en, published, source)
       VALUES ($1, $1, $2, $3, $4, 'B1', $5, TRUE, 'manual') RETURNING id`,
      [
        `${HW}-${i}`,
        ['noun'],
        `nghia ${i}`,
        `/test${i}/`,
        `She loves to ${HW}-${i} books.`,  // example_en cho cloze
      ]
    );
    entryIds.push(rows[0].id);
  }

  // Add 10 distractor entries (same level B1, same pos noun) for SwiftChoice
  for (let i = 0; i < 10; i++) {
    await pool.query(
      `INSERT INTO dictionary_entries
         (headword, lemma, pos, meaning_vi, cefr_level, published, source)
       VALUES ($1, $1, $2, $3, 'B1', TRUE, 'manual')`,
      [`${HW}-d${i}`, ['noun'], `distractor ${i}`]
    );
  }

  // Inject leitner_cards for User A: 5 cards in box 1, due NOW
  const userAleitnerIds: string[] = [];
  for (const eid of entryIds) {
    const { rows } = await pool.query(
      `INSERT INTO leitner_cards
         (user_id, entry_id, box_number, due_at, source, added_from_mode)
       VALUES ($1, $2, 1, NOW(), 'practice', 'flashcard')
       ON CONFLICT (user_id, entry_id) DO UPDATE SET due_at = NOW()
       RETURNING id`,
      [userA.userId, eid]
    );
    userAleitnerIds.push(rows[0].id);
  }

  // User B has 1 leitner card on entry-0 — used for "card_id of another user" test
  const { rows: userBLcRows } = await pool.query(
    `INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at, source)
     VALUES ($1, $2, 1, NOW(), 'practice')
     ON CONFLICT (user_id, entry_id) DO UPDATE SET due_at = NOW()
     RETURNING id`,
    [userB.userId, entryIds[0]]
  );
  const userBLeitnerId = userBLcRows[0].id;

  // ── (a) /leitner/swift-choice/question with valid leitner_card_id ───────────
  const a = await request(app)
    .post('/api/v1/leitner/swift-choice/question')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ leitner_card_id: userAleitnerIds[0] });
  out('(a) SwiftChoice valid', a);

  // ── (b) /leitner/cloze/question for level=1, 2, 3 ───────────────────────────
  for (const level of [1, 2, 3] as const) {
    const b = await request(app)
      .post('/api/v1/leitner/cloze/question')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ leitner_card_id: userAleitnerIds[1], level });
    out(`(b) Cloze level=${level}`, b);
  }

  // ── (c) /leitner/pair-link/session with 5 leitner_card_ids ──────────────────
  const c = await request(app)
    .post('/api/v1/leitner/pair-link/session')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ leitner_card_ids: userAleitnerIds.slice(0, 5) });
  out('(c) PairLink 5 ids', c);

  // ── (d) Edge: leitner_card_id of another user → 404 LEITNER_CARD_NOT_FOUND ──
  const d = await request(app)
    .post('/api/v1/leitner/swift-choice/question')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ leitner_card_id: userBLeitnerId });
  out('(d) SwiftChoice with foreign leitner_card_id → 404', d);

  // ── (e) Edge: leitner_card_ids: [] → 400 VALIDATION_ERROR ───────────────────
  const e = await request(app)
    .post('/api/v1/leitner/pair-link/session')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ leitner_card_ids: [] });
  out('(e) PairLink empty array → 400 VALIDATION_ERROR', e);

  // ── (f) Edge: leitner_card_ids: [1 item] → 400 INSUFFICIENT_PAIRS ───────────
  const f = await request(app)
    .post('/api/v1/leitner/pair-link/session')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ leitner_card_ids: [userAleitnerIds[0]] });
  out('(f) PairLink 1 item → 400 INSUFFICIENT_PAIRS', f);

  // ── (g) Regression: /practice/swift-choice/question still works with cards.id ──
  // Setup: deck + card for user A
  const deckRes = await request(app)
    .post('/api/v1/decks')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ title: `[lq-${TS}] practice deck` });
  const deckId = deckRes.body.data.id;
  const cardRes = await request(app)
    .post(`/api/v1/decks/${deckId}/cards`)
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ entry_id: entryIds[0] });
  const cardId = cardRes.body.data.id;
  const g = await request(app)
    .post('/api/v1/practice/swift-choice/question')
    .set('Authorization', `Bearer ${userA.accessToken}`)
    .send({ card_id: cardId });
  out('(g) Regression: /practice/swift-choice/question with card_id', g);

  // Cleanup
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-lq-%'`);
  await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1`, [`${HW}-%`]);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
