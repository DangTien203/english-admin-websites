/**
 * Home dashboard: `due_review.practice_due_cards` / `total_cards` count only practice sessions a user can pick up again — still open,
 * answered in part (answered_count > 0 and < total_count) and last touched within the last 7 days (the sessions GET /practice/session/active
 * offers). A session that was opened and left without an answer, one that is all answered but never completed, one left for more than a
 * week, a completed one and an abandoned one are NOT due (they used to be: every row with completed_at IS NULL inflated `total_cards`).
 *
 * Real PostgreSQL. Fixtures: users "test-pracdue-…@example.com" (and their decks/sessions), 2 entries "qzq<run>…"; removed in afterAll.
 */
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { SUMMARY_SQL } from '../routes/api/home';
import { registerUser } from './helpers/auth';
import { cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(180_000);

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-pracdue-%'`);
  await cleanup();
  await pool.end();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createDeck(token: string): Promise<string> {
  const deck = await request(app).post('/api/v1/decks').set(auth(token)).send({ title: 'Due Count Deck', level: 'beginner' });
  if (deck.status !== 201) throw new Error(`deck: ${JSON.stringify(deck.body)}`);
  return deck.body.data.id as string;
}

/** A session row; `activeAgo` (last activity) defaults to `startedAgo`, `status` to 'completed' / 'open' by `completed`. */
async function insertSession(
  userId: string,
  deckId: string,
  o: { total?: number; answered: number; startedAgo?: string; activeAgo?: string; completed?: boolean; abandoned?: boolean }
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO practice_sessions (user_id, deck_id, mode, total_count, answered_count, correct_count, wrong_count, started_at,
                                    last_activity_at, completed_at, status, abandoned_at)
     VALUES ($1, $2, 'flashcard', $3, $4, $4, 0, now() - $5::interval, now() - $6::interval,
             CASE WHEN $7::boolean THEN now() ELSE NULL END,
             CASE WHEN $7::boolean THEN 'completed' WHEN $8::boolean THEN 'abandoned' ELSE 'open' END,
             CASE WHEN $8::boolean THEN now() ELSE NULL END)
     RETURNING id`,
    [userId, deckId, o.total ?? 5, o.answered, o.startedAgo ?? '0 seconds', o.activeAgo ?? o.startedAgo ?? '0 seconds', o.completed ?? false, o.abandoned ?? false]
  );
  return rows[0].id as string;
}

const practiceDue = async (userId: string): Promise<number> => (await pool.query(SUMMARY_SQL, [userId])).rows[0].practice_due;

describe('GET /api/v1/home/dashboard: practice_due_cards', () => {
  it('counts only open, partly answered sessions last touched within 7 days', async () => {
    const user = await registerUser('pracdue');
    const stranger = await registerUser('pracdue');
    const deckId = await createDeck(user.accessToken);

    // due
    await insertSession(user.userId, deckId, { answered: 2 });
    await insertSession(user.userId, deckId, { answered: 4, startedAgo: '6 days 23 hours' });
    await insertSession(user.userId, deckId, { answered: 2, startedAgo: '12 days', activeAgo: '1 hour' }); //  started long ago, answered today
    // not due
    await insertSession(user.userId, deckId, { answered: 0 }); //                         opened and abandoned
    await insertSession(user.userId, deckId, { answered: 0, startedAgo: '3 days' }); //   abandoned, older
    await insertSession(user.userId, deckId, { answered: 5, total: 5 }); //               all answered, never completed
    await insertSession(user.userId, deckId, { answered: 2, startedAgo: '8 days' }); //   left for more than a week
    await insertSession(user.userId, deckId, { answered: 2, startedAgo: '9 days', activeAgo: '8 days' }); // idle for 8 days
    await insertSession(user.userId, deckId, { answered: 2, completed: true }); //        finished
    await insertSession(user.userId, deckId, { answered: 2, abandoned: true }); //        abandoned ("start a new one" / expired)
    await insertSession(stranger.userId, deckId, { answered: 2 }); //                     somebody else's

    const res = await request(app).get('/api/v1/home/dashboard').set(auth(user.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.due_review).toEqual({ total_cards: 3, practice_due_cards: 3, estimated_minutes: 1 });
  });

  it('a user with only abandoned sessions has nothing due', async () => {
    const user = await registerUser('pracdue');
    const deckId = await createDeck(user.accessToken);
    await insertSession(user.userId, deckId, { answered: 0 });
    await insertSession(user.userId, deckId, { answered: 0 });
    const res = await request(app).get('/api/v1/home/dashboard').set(auth(user.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.due_review).toEqual({ total_cards: 0, practice_due_cards: 0, estimated_minutes: 0 });
  });

  it('follows sessions through the API: started (not due) → partly answered (due) → all answered (not due) → completed / abandoned (not due)', async () => {
    const user = await registerUser('pracdue');
    const deckId = await createDeck(user.accessToken);
    const cardIds: string[] = [];
    for (const tag of ['pda', 'pdb']) {
      const entryId = await createEntry({ tag });
      const card = await request(app).post(`/api/v1/decks/${deckId}/cards`).set(auth(user.accessToken)).send({ entry_id: entryId });
      if (card.status !== 201) throw new Error(`card: ${JSON.stringify(card.body)}`);
      cardIds.push(card.body.data.id);
    }
    const post = (url: string, body: object) => request(app).post(`/api/v1/practice${url}`).set(auth(user.accessToken)).send(body);

    const start = await post('/session/start', { deck_id: deckId, mode: 'flashcard', card_ids: cardIds });
    const sessionId = start.body.data.session_id as string;
    expect(await practiceDue(user.userId)).toBe(0);

    await post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: true });
    expect(await practiceDue(user.userId)).toBe(1);

    // the same answer again changes nothing
    await post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: true });
    expect(await practiceDue(user.userId)).toBe(1);

    await post('/session/answer', { session_id: sessionId, card_id: cardIds[1], correct: false });
    expect(await practiceDue(user.userId)).toBe(0);

    expect((await post('/session/complete', { session_id: sessionId })).status).toBe(200);
    expect(await practiceDue(user.userId)).toBe(0);

    // a second session, left half way, then given up with "start a new one"
    const second = (await post('/session/start', { deck_id: deckId, mode: 'flashcard', card_ids: cardIds })).body.data.session_id as string;
    await post('/session/answer', { session_id: second, card_id: cardIds[0], correct: true });
    expect(await practiceDue(user.userId)).toBe(1);
    expect((await post('/session/abandon', { session_id: second })).status).toBe(200);
    expect(await practiceDue(user.userId)).toBe(0);
  });
});
