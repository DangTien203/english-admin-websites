/**
 * The hourly expiry of practice sessions (services/practiceSessionService.ts abandonExpiredPracticeSessions, scheduled on the worker by
 * services/queue/practiceExpirySchedule.ts): an open session whose last activity is older than 7 days is abandoned through the SAME close
 * as POST /session/abandon, so the correct answers still reach Leitner (once), without the bonus and without a streak.
 *
 * Every run here is scoped to the test user (`userIds`): the job must never touch the real sessions of the shared database.
 * Real PostgreSQL (needs migration 36). Fixtures: a user "test-pracexpire-…@example.com", their deck, 6 entries "qzq<run>…"; removed in afterAll.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { abandonExpiredPracticeSessions, RESUMABLE_DAYS } from '../services/practiceSessionService';
import { registerUser } from './helpers/auth';
import { cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(240_000);

let token = '';
let userId = '';
let deckId = '';
const entryIds: string[] = [];
const cardIds: string[] = [];

const auth = () => ({ Authorization: `Bearer ${token}` });
const post = (url: string, body: object = {}) => request(app).post(`/api/v1/practice${url}`).set(auth()).send(body);

beforeAll(async () => {
  const u = await registerUser('pracexpire');
  token = u.accessToken;
  userId = u.userId;
  const deck = await request(app).post('/api/v1/decks').set(auth()).send({ title: 'Expiry Deck', level: 'beginner' });
  if (deck.status !== 201) throw new Error(`deck: ${JSON.stringify(deck.body)}`);
  deckId = deck.body.data.id;
  for (let i = 0; i < 6; i++) {
    entryIds.push(await createEntry({ tag: `px${String.fromCharCode(97 + i)}` }));
    const card = await request(app).post(`/api/v1/decks/${deckId}/cards`).set(auth()).send({ entry_id: entryIds[i] });
    if (card.status !== 201) throw new Error(`card: ${JSON.stringify(card.body)}`);
    cardIds.push(card.body.data.id);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-pracexpire-%'`);
  await cleanup();
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM practice_sessions WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM leitner_reviews WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM leitner_cards WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM user_card_progress WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM user_activity_log WHERE user_id = $1', [userId]);
});

/** A session over `cards` (indexes into the fixtures) with the given right / wrong answers, last touched `ago` ago. */
async function session(o: { cards: number[]; right?: number[]; wrong?: number[]; ago: string }): Promise<string> {
  const start = await post('/session/start', { deck_id: deckId, mode: 'flashcard', card_ids: o.cards.map((i) => cardIds[i]) });
  expect(start.status).toBe(200);
  const id = start.body.data.session_id as string;
  for (const [list, correct] of [[o.right ?? [], true], [o.wrong ?? [], false]] as const) {
    for (const i of list) expect((await post('/session/answer', { session_id: id, card_id: cardIds[i], correct })).status).toBe(200);
  }
  await pool.query(`UPDATE practice_sessions SET last_activity_at = now() - $2::interval WHERE id = $1`, [id, o.ago]);
  return id;
}
const row = async (id: string) =>
  (await pool.query('SELECT status, completed_at, abandoned_at, xp_earned, time_total_ms FROM practice_sessions WHERE id = $1', [id])).rows[0];
const box = async (entry: string) => (await pool.query('SELECT box_number, total_reviews FROM leitner_cards WHERE user_id = $1 AND entry_id = $2', [userId, entry])).rows[0];
const run = (opts: object = {}) => abandonExpiredPracticeSessions({ userIds: [userId], ...opts });

describe('abandonExpiredPracticeSessions', () => {
  it('the window is 7 days', () => {
    expect(RESUMABLE_DAYS).toBe(7);
  });

  it('abandons only the sessions untouched for more than 7 days; their correct answers reach Leitner, once', async () => {
    const old = await session({ cards: [0, 1, 2], right: [0], wrong: [1], ago: '8 days' }); // card 2 never answered
    const fresh = await session({ cards: [3, 4], right: [3], ago: '1 day' });
    const edge = await session({ cards: [4, 5], right: [5], ago: '6 days 23 hours' });

    expect(await run()).toEqual({ abandoned: 1, skipped: 0, failed: 0, batches: 1 });

    expect(await row(old)).toMatchObject({ status: 'abandoned', completed_at: null, xp_earned: 0 });
    expect((await row(old)).abandoned_at).not.toBeNull();
    expect(await row(fresh)).toMatchObject({ status: 'open', abandoned_at: null });
    expect(await row(edge)).toMatchObject({ status: 'open', abandoned_at: null });

    expect(await box(entryIds[0])).toMatchObject({ box_number: 1 }); // right answer of the expired session
    for (const i of [1, 2, 3, 5]) expect(await box(entryIds[i])).toBeUndefined(); // wrong, unanswered, and the sessions still open
    // no bonus, no activity, no streak
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM user_activity_log WHERE user_id = $1`, [userId])).rows[0].n).toBe(0);

    // a second run finds nothing, and the word does not move again
    expect(await run()).toEqual({ abandoned: 0, skipped: 0, failed: 0, batches: 0 });
    expect(await box(entryIds[0])).toMatchObject({ box_number: 1 });

    // the expired session is closed for good, and reads as abandoned
    expect((await post('/session/complete', { session_id: old })).status).toBe(400);
    const back = await request(app).get(`/api/v1/practice/session/${old}`).set(auth());
    expect(back.body.data).toMatchObject({ status: 'abandoned', answered_count: 2 });
  });

  it('a word that already sits in a box moves up exactly one box', async () => {
    await pool.query(`INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at) VALUES ($1, $2, 2, NOW())`, [userId, entryIds[0]]);
    await session({ cards: [0, 1], right: [0, 1], ago: '9 days' });
    expect((await run()).abandoned).toBe(1);
    expect(await box(entryIds[0])).toMatchObject({ box_number: 3, total_reviews: 1 });
    expect(await box(entryIds[1])).toMatchObject({ box_number: 1 });
    await run();
    expect(await box(entryIds[0])).toMatchObject({ box_number: 3, total_reviews: 1 });
  });

  it('a session without answers is simply closed', async () => {
    const empty = await session({ cards: [0, 1], ago: '10 days' });
    expect(await run()).toMatchObject({ abandoned: 1 });
    expect(await row(empty)).toMatchObject({ status: 'abandoned', xp_earned: 0 });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM leitner_cards WHERE user_id = $1', [userId])).rows[0].n).toBe(0);
  });

  it('completed and already abandoned sessions are left alone, however old', async () => {
    const done = await session({ cards: [0, 1], right: [0], ago: '1 day' });
    expect((await post('/session/complete', { session_id: done })).status).toBe(200);
    const left = await session({ cards: [2, 3], right: [2], ago: '1 day' });
    expect((await post('/session/abandon', { session_id: left })).status).toBe(200);
    await pool.query(`UPDATE practice_sessions SET last_activity_at = now() - interval '30 days' WHERE id = ANY($1::uuid[])`, [[done, left]]);
    const leitnerBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM leitner_reviews WHERE user_id = $1', [userId])).rows[0].n;

    expect(await run()).toEqual({ abandoned: 0, skipped: 0, failed: 0, batches: 0 });
    expect(await row(done)).toMatchObject({ status: 'completed', abandoned_at: null });
    expect(await row(left)).toMatchObject({ status: 'abandoned', completed_at: null });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM leitner_reviews WHERE user_id = $1', [userId])).rows[0].n).toBe(leitnerBefore);
  });

  it('works through a backlog in batches, oldest first, and a run is bounded by maxBatches', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await session({ cards: [i], right: [i], ago: `${12 - i} days` })); // 12, 11, 10, 9, 8 days: ids[4] is the freshest

    expect(await run({ batchSize: 2, maxBatches: 2 })).toEqual({ abandoned: 4, skipped: 0, failed: 0, batches: 2 });
    for (const id of ids.slice(0, 4)) expect(await row(id)).toMatchObject({ status: 'abandoned' });
    expect(await row(ids[4])).toMatchObject({ status: 'open' }); // the newest of the expired ones waits for the next run

    expect(await run({ batchSize: 2, maxBatches: 2 })).toEqual({ abandoned: 1, skipped: 0, failed: 0, batches: 1 });
    expect(await row(ids[4])).toMatchObject({ status: 'abandoned' });
    for (let i = 0; i < 5; i++) expect(await box(entryIds[i])).toMatchObject({ box_number: 1, total_reviews: 0 });
  });

  it('two runs at once close every session once: the cards move once, nothing fails', async () => {
    await pool.query(`INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at) VALUES ($1, $2, 2, NOW())`, [userId, entryIds[0]]);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await session({ cards: [i], right: [i], ago: '9 days' }));

    const [a, b] = await Promise.all([run(), run()]);
    expect(a.failed + b.failed).toBe(0);
    expect(a.abandoned + b.abandoned).toBe(4); // each session was closed by exactly one of them
    for (const id of ids) expect(await row(id)).toMatchObject({ status: 'abandoned' });
    expect(await box(entryIds[0])).toMatchObject({ box_number: 3, total_reviews: 1 });
    for (const i of [1, 2, 3]) expect(await box(entryIds[i])).toMatchObject({ box_number: 1 });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM leitner_reviews WHERE user_id = $1', [userId])).rows[0].n).toBe(1);
  });

  it('a session the user completes at the same moment is not abandoned: one close wins', async () => {
    const id = await session({ cards: [0, 1], right: [0, 1], ago: '9 days' });
    const [job, complete] = await Promise.all([run(), post('/session/complete', { session_id: id })]);
    const finalRow = await row(id);
    if (complete.status === 200) {
      expect(finalRow).toMatchObject({ status: 'completed' });
      expect(job.abandoned).toBe(0);
    } else {
      expect(complete.body.error.code).toBe('SESSION_ALREADY_COMPLETED');
      expect(finalRow).toMatchObject({ status: 'abandoned' });
      expect(job.abandoned).toBe(1);
    }
    expect(await box(entryIds[0])).toMatchObject({ box_number: 1, total_reviews: 0 });
    expect(await box(entryIds[1])).toMatchObject({ box_number: 1, total_reviews: 0 });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM leitner_cards WHERE user_id = $1', [userId])).rows[0].n).toBe(2);
  });

  it('is scoped by userIds, and olderThanDays moves the line', async () => {
    const id = await session({ cards: [0], right: [0], ago: '2 days' });
    expect(await abandonExpiredPracticeSessions({ userIds: [randomUUID()], olderThanDays: 0 })).toMatchObject({ abandoned: 0 });
    expect(await abandonExpiredPracticeSessions({ userIds: [] })).toMatchObject({ abandoned: 0 });
    expect(await row(id)).toMatchObject({ status: 'open' });

    expect(await run()).toMatchObject({ abandoned: 0 }); // 2 days is inside the default window ...
    expect(await run({ olderThanDays: 1 })).toMatchObject({ abandoned: 1 }); // ... and outside a 1-day one
    expect(await row(id)).toMatchObject({ status: 'abandoned' });
  });

  it('a session that was started very long ago (more than 24.8 days: time_total_ms is an int4) still closes', async () => {
    const id = await session({ cards: [0], right: [0], ago: '9 days' });
    await pool.query(`UPDATE practice_sessions SET started_at = now() - interval '60 days' WHERE id = $1`, [id]);
    expect(await run()).toEqual({ abandoned: 1, skipped: 0, failed: 0, batches: 1 });
    expect(await row(id)).toMatchObject({ status: 'abandoned', time_total_ms: 2_147_483_647 });
    expect(await box(entryIds[0])).toMatchObject({ box_number: 1 });
  });
});
