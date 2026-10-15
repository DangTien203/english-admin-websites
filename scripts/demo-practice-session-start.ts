/**
 * Demo script — runs the 6 acceptance scenarios for POST /api/v1/practice/session/start
 * and prints raw HTTP-style responses (curl-equivalent).
 *
 * Run: tsx scripts/demo-practice-session-start.ts
 *
 * Cleans up after itself (deletes test users + entries).
 */
import 'dotenv/config';
import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const HW_PREFIX = `pssdemo${TS}`;

interface Reg {
  userId: string;
  accessToken: string;
  email: string;
}

async function registerUser(suffix: string): Promise<Reg> {
  const email = `test-pssdemo-${suffix}-${Date.now()}@example.com`;
  const res = await request(app).post('/api/v1/auth/register').send({
    email,
    password: 'password123',
    full_name: `Demo ${suffix}`,
  });
  return { userId: res.body.data.user.id, accessToken: res.body.data.access_token, email };
}

function logCase(label: string, res: any) {
  console.log('\n' + '═'.repeat(80));
  console.log(label);
  console.log('═'.repeat(80));
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(res.body, null, 2));
}

async function main() {
  const user = await registerUser('a');
  const userOther = await registerUser('b');

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

  const deckRes = await request(app)
    .post('/api/v1/decks')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ title: `[demo-${TS}] 12-card deck` });
  const deckId = deckRes.body.data.id;

  await request(app)
    .post(`/api/v1/decks/${deckId}/cards/batch`)
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ entry_ids: entryIds });

  const cardsRes = await request(app)
    .get(`/api/v1/decks/${deckId}/cards`)
    .set('Authorization', `Bearer ${user.accessToken}`);
  const cardIds: string[] = cardsRes.body.data.items.map((c: any) => c.card_id);

  const foreignDeckRes = await request(app)
    .post('/api/v1/decks')
    .set('Authorization', `Bearer ${userOther.accessToken}`)
    .send({ title: `[demo-${TS}] foreign deck` });
  const fDeckId = foreignDeckRes.body.data.id;
  const fCardRes = await request(app)
    .post(`/api/v1/decks/${fDeckId}/cards`)
    .set('Authorization', `Bearer ${userOther.accessToken}`)
    .send({ entry_id: foreignEntryId });
  const foreignCardId: string = fCardRes.body.data.id;

  // ── Run 6 cases ─────────────────────────────────────────────────────────────
  const a1 = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', limit: 5 });
  logCase('(a-1) limit=5  → 5 random cards', a1);

  const a2 = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', limit: 5 });
  logCase('(a-2) limit=5  → 5 random cards (DIFFERENT order from a-1)', a2);

  const b = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', limit: 100 });
  logCase('(b) limit=100 on 12-card deck → 12 cards (no error)', b);

  const c = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', card_ids: [cardIds[0]] });
  logCase('(c) card_ids=[<valid-uuid>] → 1 card', c);

  const d = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', card_ids: [foreignCardId] });
  logCase('(d) card_ids=[<foreign-uuid>] → 400 INVALID_CARDS', d);

  const e = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', card_ids: [] });
  logCase('(e) card_ids=[] → 400 VALIDATION_ERROR', e);

  const f = await request(app)
    .post('/api/v1/practice/session/start')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ deck_id: deckId, mode: 'flashcard', card_ids: [cardIds[2], cardIds[2]] });
  logCase('(f) card_ids=[same uuid x2] → 1 card (dedupe)', f);

  // Cleanup
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-pssdemo-%'`);
  await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1`, [`${HW_PREFIX}-%`]);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
