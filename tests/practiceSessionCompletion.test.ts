/**
 * Practice sessions: completing one is ONE statement (routes/api/practice.ts) that claims the session and applies its correct answers
 * to Leitner, so
 *   - several completions at once (a double tap, a client retrying a slow request) move each card ONE box, not one per request;
 *   - the loser is told the session was already completed;
 *   - a failure cannot leave a completed session whose cards did not move.
 * Also the answer endpoint, which reads the session and the card to grade in the same round trip: every way to miss either.
 *
 * Real PostgreSQL. Fixtures: a user "test-pracdone-…@example.com", their deck, 4 entries "qzq<run>…"; removed in afterAll. No network:
 * answers are client-graded ({ correct }) or match the entry exactly.
 */
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser } from './helpers/auth';
import { cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(180_000);

const VI_OK = 'vật mẫu';
const MISSING = '00000000-0000-4000-8000-000000000000';

let token = '';
let userId = '';
let deckId = '';
const entryIds: string[] = [];
const cardIds: string[] = [];

const api = {
  post: (url: string, body: object = {}) => request(app).post(`/api/v1/practice${url}`).set('Authorization', `Bearer ${token}`).send(body),
};
const box = async (entry: string) =>
  (await pool.query('SELECT box_number, total_reviews FROM leitner_cards WHERE user_id = $1 AND entry_id = $2', [userId, entry])).rows[0];

beforeAll(async () => {
  const u = await registerUser('pracdone');
  token = u.accessToken;
  userId = u.userId;
  const deck = await request(app).post('/api/v1/decks').set('Authorization', `Bearer ${token}`).send({ title: 'Completion Race Deck', level: 'beginner' });
  if (deck.status !== 201) throw new Error(`deck: ${JSON.stringify(deck.body)}`);
  deckId = deck.body.data.id;
  for (let i = 0; i < 4; i++) {
    entryIds.push(await createEntry({ tag: `pd${String.fromCharCode(97 + i)}` }));
    const card = await request(app).post(`/api/v1/decks/${deckId}/cards`).set('Authorization', `Bearer ${token}`).send({ entry_id: entryIds[i] });
    if (card.status !== 201) throw new Error(`card: ${JSON.stringify(card.body)}`);
    cardIds.push(card.body.data.id);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-pracdone-%'`);
  await cleanup();
});

/** A session over the four cards in which cards 0..2 were answered right and card 3 wrong. */
async function sessionWithAnswers(): Promise<string> {
  const start = await api.post('/session/start', { deck_id: deckId, mode: 'flashcard', card_ids: cardIds });
  expect(start.status).toBe(200);
  const sessionId = start.body.data.session_id as string;
  for (let i = 0; i < 4; i++) {
    const res = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[i], correct: i < 3 });
    expect(res.status).toBe(200);
  }
  return sessionId;
}

describe('completing a session', () => {
  it('several completions at once move every card one box, once; the others are told it was completed', async () => {
    // cards 0 and 1 already sit in box 2, cards 2 and 3 are new words
    for (const i of [0, 1]) {
      await pool.query(`INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at) VALUES ($1, $2, 2, NOW())`, [userId, entryIds[i]]);
    }
    const sessionId = await sessionWithAnswers();

    const results = await Promise.all(Array.from({ length: 6 }, () => api.post('/session/complete', { session_id: sessionId })));
    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status !== 200);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect(r.body.error.code).toBe('SESSION_ALREADY_COMPLETED');

    expect(ok[0].body.data).toMatchObject({
      leitner_added: { added: 1, skipped: 2 }, // card 2 is new; cards 0 and 1 existed
      leitner_advanced: 2,
      leitner_mastered_now: 0,
      xp_earned: 3 * 10 + 20,
    });
    expect(ok[0].body.data.correct_card_ids.sort()).toEqual([cardIds[0], cardIds[1], cardIds[2]].sort());

    // the database: box 2 → 3 exactly once, the new word in box 1, the wrong one never added
    expect(await box(entryIds[0])).toMatchObject({ box_number: 3, total_reviews: 1 });
    expect(await box(entryIds[1])).toMatchObject({ box_number: 3, total_reviews: 1 });
    expect(await box(entryIds[2])).toMatchObject({ box_number: 1 });
    expect(await box(entryIds[3])).toBeUndefined();
    const reviews = await pool.query('SELECT COUNT(*)::int AS n FROM leitner_reviews WHERE user_id = $1', [userId]);
    expect(reviews.rows[0].n).toBe(2);

    const session = (await pool.query('SELECT completed_at, xp_earned, time_total_ms FROM practice_sessions WHERE id = $1', [sessionId])).rows[0];
    expect(session.completed_at).not.toBeNull();
    expect(session).toMatchObject({ xp_earned: 50 });
    expect(session.time_total_ms).toBeGreaterThanOrEqual(0);

    // and afterwards it stays completed
    expect((await api.post('/session/complete', { session_id: sessionId })).body.error.code).toBe('SESSION_ALREADY_COMPLETED');
    expect(await box(entryIds[0])).toMatchObject({ box_number: 3, total_reviews: 1 });
  });

  it('refuses a session of somebody else and one that does not exist, and changes nothing', async () => {
    const stranger = await registerUser('pracdone');
    const sessionId = await sessionWithAnswers();
    const asStranger = await request(app).post('/api/v1/practice/session/complete').set('Authorization', `Bearer ${stranger.accessToken}`).send({ session_id: sessionId });
    expect(asStranger.status).toBe(404);
    expect(asStranger.body.error.code).toBe('SESSION_NOT_FOUND');
    expect((await api.post('/session/complete', { session_id: MISSING })).body.error.code).toBe('SESSION_NOT_FOUND');
    expect((await pool.query('SELECT completed_at FROM practice_sessions WHERE id = $1', [sessionId])).rows[0].completed_at).toBeNull();
  });

  it('a session without a single right answer completes and adds nothing', async () => {
    const start = await api.post('/session/start', { deck_id: deckId, mode: 'flashcard', card_ids: [cardIds[3]] });
    const sessionId = start.body.data.session_id as string;
    await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[3], correct: false });
    const done = await api.post('/session/complete', { session_id: sessionId });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ leitner_added: { added: 0, skipped: 0 }, leitner_advanced: 0, correct_card_ids: [] });
  });
});

describe('answering: the session and the card are read together', () => {
  let sessionId = '';
  beforeAll(async () => {
    const start = await api.post('/session/start', { deck_id: deckId, mode: 'flashcard', card_ids: [cardIds[0]] });
    sessionId = start.body.data.session_id;
  });

  it('typed answer: 404 CARD_NOT_FOUND for a card that does not exist', async () => {
    const res = await api.post('/session/answer', { session_id: sessionId, card_id: MISSING, user_answer: VI_OK });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CARD_NOT_FOUND');
  });

  it('client-graded answer: 404 CARD_NOT_FOUND for a card that does not exist', async () => {
    const res = await api.post('/session/answer', { session_id: sessionId, card_id: MISSING, correct: true });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CARD_NOT_FOUND');
  });

  it('the session is checked before the card: unknown session → SESSION_NOT_FOUND, even for a card that does not exist', async () => {
    const res = await api.post('/session/answer', { session_id: MISSING, card_id: MISSING, user_answer: VI_OK });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('typed answer, exact match: graded without a model, recorded, and the counters come back', async () => {
    const res = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], user_answer: VI_OK, time_ms: 1200 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ progress: '1/1', correct_so_far: 1, wrong_so_far: 0 });
    expect(res.body.data.grading).toMatchObject({ correct: true, grading_source: 'exact' });
    expect(res.body.data.requires_english_meaning).toBe(false);
    const row = (await pool.query('SELECT correct, time_ms, user_answer FROM practice_answers WHERE session_id = $1', [sessionId])).rows[0];
    expect(row).toMatchObject({ correct: true, time_ms: 1200, user_answer: VI_OK });
  });

  it('a completed session takes no more answers', async () => {
    await api.post('/session/complete', { session_id: sessionId });
    const typed = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], user_answer: VI_OK });
    expect(typed.status).toBe(400);
    expect(typed.body.error.code).toBe('SESSION_ALREADY_COMPLETED');
    const legacy = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: true });
    expect(legacy.body.error.code).toBe('SESSION_ALREADY_COMPLETED');
  });
});
