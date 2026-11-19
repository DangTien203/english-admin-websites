/**
 * Practice sessions that can be resumed from the server (new device, reinstall, cleared storage):
 *   - POST /session/start takes optional `options`, stores them and the ORDERED cards, and echoes `options`;
 *   - GET /session/active and GET /session/:id return the resume payload (same cards, in the stored order, and the answers so far);
 *   - POST /session/abandon closes a session without the +20 bonus, applying its correct answers to Leitner once;
 *   - /complete sets status 'completed'; an answer moves last_activity_at.
 * The hourly expiry job is in practiceSessionExpiry.test.ts, the migration in practiceSessionResumeMigration.test.ts.
 *
 * Real PostgreSQL (needs migration 36). Fixtures: users "test-pracresume-…@example.com", their deck, 6 entries "qzq<run>…"; removed in
 * afterAll. No network: every answer is client-graded ({ correct }).
 */
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser } from './helpers/auth';
import { cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(240_000);

const MISSING = '00000000-0000-4000-8000-000000000000';

let token = '';
let userId = '';
let strangerToken = '';
let deckId = '';
const entryIds: string[] = [];
const cardIds: string[] = [];

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const post = (url: string, body: unknown = {}, t: string = token) => request(app).post(`/api/v1/practice${url}`).set(auth(t)).send(body as object);
const get = (url: string, t: string = token) => request(app).get(`/api/v1/practice${url}`).set(auth(t));

const DECK_TITLE = 'Resume Deck';

beforeAll(async () => {
  const u = await registerUser('pracresume');
  token = u.accessToken;
  userId = u.userId;
  strangerToken = (await registerUser('pracresume')).accessToken;
  const deck = await request(app).post('/api/v1/decks').set(auth(token)).send({ title: DECK_TITLE, level: 'beginner' });
  if (deck.status !== 201) throw new Error(`deck: ${JSON.stringify(deck.body)}`);
  deckId = deck.body.data.id;
  for (let i = 0; i < 6; i++) {
    entryIds.push(await createEntry({ tag: `pr${String.fromCharCode(97 + i)}` }));
    const card = await request(app).post(`/api/v1/decks/${deckId}/cards`).set(auth(token)).send({ entry_id: entryIds[i] });
    if (card.status !== 201) throw new Error(`card: ${JSON.stringify(card.body)}`);
    cardIds.push(card.body.data.id);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-pracresume-%'`);
  await cleanup();
  await pool.end();
});

// every test starts from a user with no sessions, no Leitner cards and no activity
beforeEach(async () => {
  await pool.query('DELETE FROM practice_sessions WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM leitner_reviews WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM leitner_cards WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM user_card_progress WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM user_activity_log WHERE user_id = $1', [userId]);
});

interface StartOpts {
  cards?: string[];
  limit?: number;
  mode?: string;
  options?: unknown;
}
/** Starts a session of the user's deck; the cards are the first four of the deck unless said otherwise. */
async function start(o: StartOpts = {}) {
  const body: Record<string, unknown> = { deck_id: deckId, mode: o.mode ?? 'flashcard' };
  if (o.limit !== undefined) body.limit = o.limit;
  else body.card_ids = o.cards ?? cardIds.slice(0, 4);
  if ('options' in o) body.options = o.options;
  const res = await post('/session/start', body);
  expect(res.status).toBe(200);
  return res.body.data as { session_id: string; mode: string; options: object; total_count: number; cards: Array<{ card_id: string; entry_id: string; times_seen: number; times_correct: number }> };
}
const answer = (sessionId: string, cardId: string, correct: boolean, extra: object = {}) =>
  post('/session/answer', { session_id: sessionId, card_id: cardId, correct, ...extra });
const resumable = async () => (await get('/session/active')).body.data.session;
const setActivity = (sessionId: string, ago: string) =>
  pool.query(`UPDATE practice_sessions SET last_activity_at = now() - $2::interval WHERE id = $1`, [sessionId, ago]);
const dbSession = async (sessionId: string) =>
  (await pool.query('SELECT status, completed_at, abandoned_at, xp_earned, options, last_activity_at FROM practice_sessions WHERE id = $1', [sessionId])).rows[0];
const box = async (entry: string) => (await pool.query('SELECT box_number, total_reviews FROM leitner_cards WHERE user_id = $1 AND entry_id = $2', [userId, entry])).rows[0];
const activityRows = async (sessionId: string): Promise<number> =>
  (await pool.query(`SELECT COUNT(*)::int AS n FROM user_activity_log WHERE user_id = $1 AND action = 'practice_session' AND details->>'session_id' = $2`, [userId, sessionId])).rows[0].n;

// ═════════════════════════════════════════════════════════════════════════════
describe('POST /session/start: options and the stored queue', () => {
  it('stores the cards in the order it returned them (random selection: the shuffled order) and echoes options: {} when none were sent', async () => {
    const data = await start({ limit: 5 });
    expect(data.cards).toHaveLength(5);
    expect(data.options).toEqual({});
    const queue = (await pool.query('SELECT position, card_id FROM practice_session_cards WHERE session_id = $1 ORDER BY position', [data.session_id])).rows;
    expect(queue.map((r) => r.position)).toEqual([0, 1, 2, 3, 4]);
    expect(queue.map((r) => r.card_id)).toEqual(data.cards.map((c) => c.card_id));
    const row = await dbSession(data.session_id);
    expect(row).toMatchObject({ status: 'open', completed_at: null, abandoned_at: null, options: {} });
    expect(Date.now() - new Date(row.last_activity_at).getTime()).toBeLessThan(60_000);
  });

  it('the response keeps every field it had (options is added)', async () => {
    const data = await start();
    expect(Object.keys(data).sort()).toEqual(['cards', 'mode', 'options', 'session_id', 'total_count']);
    expect(Object.keys(data.cards[0]).sort()).toEqual(
      ['audio_us_url', 'card_id', 'entry_id', 'headword', 'ipa_us', 'is_new_word', 'leitner_box_number', 'meaning_vi', 'note_html', 'requires_english_meaning', 'times_correct', 'times_seen'].sort()
    );
  });

  it.each([
    ['cloze_craft', { cloze_level: 2 }],
    ['cloze_craft', { cloze_level: 1 }],
    ['cloze_craft', { cloze_level: 3 }],
    ['flashcard', { direction: 'english' }],
    ['flashcard', { direction: 'vietnamese' }],
    ['flashcard', {}],
    ['swift_choice', {}],
    ['pair_link', {}],
  ])('%s with options %j: stored and echoed', async (mode, options) => {
    const data = await start({ mode, options });
    expect(data.options).toEqual(options);
    expect((await dbSession(data.session_id)).options).toEqual(options);
    // and returned again when the session is read back
    const back = await get(`/session/${data.session_id}`);
    expect(back.body.data.options).toEqual(options);
  });

  it.each([
    ['cloze_level on a flashcard session', 'flashcard', { cloze_level: 1 }],
    ['cloze_level on a swift_choice session', 'swift_choice', { cloze_level: 1 }],
    ['direction on a cloze_craft session', 'cloze_craft', { direction: 'english' }],
    ['direction on a pair_link session', 'pair_link', { direction: 'vietnamese' }],
    ['cloze_level 4', 'cloze_craft', { cloze_level: 4 }],
    ['cloze_level 0', 'cloze_craft', { cloze_level: 0 }],
    ['cloze_level as text', 'cloze_craft', { cloze_level: '2' }],
    ['an unknown direction', 'flashcard', { direction: 'both' }],
    ['an unknown key', 'flashcard', { direction: 'english', speed: 2 }],
    ['options as a list', 'flashcard', []],
    ['options as text', 'flashcard', 'english'],
    ['options null', 'flashcard', null],
  ])('400 VALIDATION_ERROR for %s, and no session is created', async (_name, mode, options) => {
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM practice_sessions WHERE user_id = $1', [userId])).rows[0].n;
    const res = await post('/session/start', { deck_id: deckId, mode, card_ids: cardIds.slice(0, 2), options });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body.error.details)).toContain('options');
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM practice_sessions WHERE user_id = $1', [userId])).rows[0].n;
    expect(after).toBe(before);
  });

  it('options is optional: a start without it behaves as before', async () => {
    const res = await post('/session/start', { deck_id: deckId, mode: 'cloze_craft', limit: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data.options).toEqual({});
    expect(res.body.data.cards).toHaveLength(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('resuming: start → answer → active → answer → complete', () => {
  it('the payload carries everything the app needs to continue, and follows the session to its end', async () => {
    const started = await start({ mode: 'cloze_craft', options: { cloze_level: 3 } });
    const order = started.cards.map((c) => c.card_id);
    const sessionId = started.session_id;

    // nothing answered yet: nothing to resume
    expect((await get('/session/active')).body.data).toEqual({ session: null });

    const first = await answer(sessionId, order[0], true, { time_ms: 1200, user_answer: 'mẫu' });
    expect(first.status).toBe(200);

    const active = await get('/session/active');
    expect(active.status).toBe(200);
    expect(active.body.success).toBe(true);
    const s = active.body.data.session;
    expect(Object.keys(s).sort()).toEqual(
      [
        'session_id', 'deck_id', 'deck_title', 'mode', 'options', 'status', 'total_count', 'answered_count', 'correct_count', 'wrong_count',
        'started_at', 'last_activity_at', 'completed_at', 'cards', 'answers', 'next_card_id',
      ].sort()
    );
    expect(s).toMatchObject({
      session_id: sessionId,
      deck_id: deckId,
      deck_title: DECK_TITLE,
      mode: 'cloze_craft',
      options: { cloze_level: 3 },
      status: 'open',
      total_count: 4,
      answered_count: 1,
      correct_count: 1,
      wrong_count: 0,
      completed_at: null,
      next_card_id: order[1],
    });
    expect(Number.isNaN(Date.parse(s.started_at))).toBe(false);
    expect(Number.isNaN(Date.parse(s.last_activity_at))).toBe(false);
    expect(s.answers).toEqual([{ card_id: order[0], correct: true, time_ms: 1200, user_answer: 'mẫu' }]);
    // the cards: the same objects as /session/start, in the same order (the answered one now shows its progress)
    expect(s.cards.map((c: any) => c.card_id)).toEqual(order);
    expect(s.cards[0]).toEqual({ ...started.cards[0], times_seen: 1, times_correct: 1 });
    expect(s.cards.slice(1)).toEqual(started.cards.slice(1));

    // the same session by id gives the same payload
    expect((await get(`/session/${sessionId}`)).body.data).toEqual(s);

    // continue: a wrong answer, then the rest
    expect((await answer(sessionId, order[1], false)).status).toBe(200);
    const mid = await resumable();
    expect(mid).toMatchObject({ answered_count: 2, correct_count: 1, wrong_count: 1, next_card_id: order[2] });
    expect(mid.answers.map((a: any) => [a.card_id, a.correct])).toEqual([[order[0], true], [order[1], false]]);

    await answer(sessionId, order[2], true);
    await answer(sessionId, order[3], true);
    // all answered, not completed yet: nothing left to resume, but the session can still be read (and completed)
    expect(await resumable()).toBeNull();
    const all = await get(`/session/${sessionId}`);
    expect(all.status).toBe(200);
    expect(all.body.data).toMatchObject({ status: 'open', answered_count: 4, next_card_id: null });

    const done = await post('/session/complete', { session_id: sessionId });
    expect(done.status).toBe(200);
    expect(done.body.data.xp_earned).toBe(3 * 10 + 20);
    expect(await dbSession(sessionId)).toMatchObject({ status: 'completed', abandoned_at: null, xp_earned: 50 });
    expect((await dbSession(sessionId)).completed_at).not.toBeNull();

    // completed sessions are still readable by id, with their final state, and are no longer offered
    const fin = await get(`/session/${sessionId}`);
    expect(fin.status).toBe(200);
    expect(fin.body.data).toMatchObject({ status: 'completed', answered_count: 4, correct_count: 3, wrong_count: 1, next_card_id: null });
    expect(fin.body.data.completed_at).not.toBeNull();
    expect(fin.body.data.cards).toHaveLength(4);
    expect(fin.body.data.answers).toHaveLength(4);
    expect(await resumable()).toBeNull();
  });

  it('a repeated answer does not appear twice in the payload and does not move last_activity_at; an accepted one does', async () => {
    const started = await start();
    const sessionId = started.session_id;
    await answer(sessionId, started.cards[0].card_id, true);
    await setActivity(sessionId, '3 days');
    const before = (await dbSession(sessionId)).last_activity_at;

    const repeat = await answer(sessionId, started.cards[0].card_id, true);
    expect(repeat.body.data.already_answered).toBe(true);
    expect((await dbSession(sessionId)).last_activity_at.getTime()).toBe(before.getTime());
    expect((await resumable()).answers).toHaveLength(1);

    await answer(sessionId, started.cards[1].card_id, true);
    const after = (await dbSession(sessionId)).last_activity_at;
    expect(Date.now() - after.getTime()).toBeLessThan(60_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('GET /session/active: which session is offered', () => {
  it('the most recently active of several resumable sessions', async () => {
    const a = await start({ cards: cardIds.slice(0, 3) });
    await answer(a.session_id, a.cards[0].card_id, true);
    const b = await start({ cards: cardIds.slice(0, 3) });
    await answer(b.session_id, b.cards[0].card_id, true);
    expect((await resumable()).session_id).toBe(b.session_id);

    await answer(a.session_id, a.cards[1].card_id, true); // a is touched last
    expect((await resumable()).session_id).toBe(a.session_id);
  });

  it('a session nobody answered is not offered (an opened-and-left one is not "unfinished")', async () => {
    await start();
    expect(await resumable()).toBeNull();
  });

  it('a fully answered session is not offered, even before it is completed', async () => {
    const s = await start({ cards: cardIds.slice(0, 2) });
    await answer(s.session_id, s.cards[0].card_id, true);
    expect(await resumable()).not.toBeNull();
    await answer(s.session_id, s.cards[1].card_id, false);
    expect(await resumable()).toBeNull();
  });

  it('only sessions touched within the last 7 days', async () => {
    const s = await start();
    await answer(s.session_id, s.cards[0].card_id, true);
    await setActivity(s.session_id, '6 days 23 hours');
    expect((await resumable())?.session_id).toBe(s.session_id);
    await setActivity(s.session_id, '7 days 1 hour');
    expect(await resumable()).toBeNull();
    // ... still readable by id
    expect((await get(`/session/${s.session_id}`)).status).toBe(200);
  });

  it('not a completed, not an abandoned session', async () => {
    const done = await start();
    await answer(done.session_id, done.cards[0].card_id, true);
    await post('/session/complete', { session_id: done.session_id });
    const left = await start();
    await answer(left.session_id, left.cards[0].card_id, true);
    await post('/session/abandon', { session_id: left.session_id });
    expect(await resumable()).toBeNull();
  });

  it('a session started before the queue was stored (no cards to continue with) is not offered', async () => {
    const s = await start();
    await answer(s.session_id, s.cards[0].card_id, true);
    await pool.query('DELETE FROM practice_session_cards WHERE session_id = $1', [s.session_id]);
    expect(await resumable()).toBeNull();
    // by id it still reads: counters and answers, no cards, nothing to continue
    const back = await get(`/session/${s.session_id}`);
    expect(back.status).toBe(200);
    expect(back.body.data).toMatchObject({ answered_count: 1, cards: [], next_card_id: null });
    expect(back.body.data.answers).toHaveLength(1);
  });

  it('never the session of somebody else', async () => {
    const s = await start();
    await answer(s.session_id, s.cards[0].card_id, true);
    expect((await get('/session/active', strangerToken)).body.data).toEqual({ session: null });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('GET /session/:id: ownership and bad ids', () => {
  it('somebody else\'s session, a session that does not exist and an id that is not a UUID are all 404 SESSION_NOT_FOUND', async () => {
    const s = await start();
    await answer(s.session_id, s.cards[0].card_id, true);
    for (const [path, t] of [
      [`/session/${s.session_id}`, strangerToken],
      [`/session/${MISSING}`, token],
      ['/session/not-a-uuid', token],
      ['/session/12345', token],
      ["/session/%27%3B%20DROP%20TABLE%20practice_sessions%3B--", token],
    ] as const) {
      const res = await get(path, t);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ success: false, error: { code: 'SESSION_NOT_FOUND' } });
    }
    // the owner still has it
    expect((await get(`/session/${s.session_id}`)).status).toBe(200);
  });

  it('needs a login', async () => {
    expect((await request(app).get('/api/v1/practice/session/active')).status).toBe(401);
    expect((await request(app).get(`/api/v1/practice/session/${MISSING}`)).status).toBe(401);
    expect((await request(app).post('/api/v1/practice/session/abandon').send({ session_id: MISSING })).status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('POST /session/abandon', () => {
  it('closes the session WITHOUT the bonus, applies the correct answers to Leitner once, logs no activity', async () => {
    // entry 1 already sits in box 2; entry 0 is a new word; card 2 is answered wrong
    await pool.query(`INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at) VALUES ($1, $2, 2, NOW())`, [userId, entryIds[1]]);
    const s = await start({ cards: cardIds.slice(0, 3) });
    await answer(s.session_id, cardIds[0], true);
    await answer(s.session_id, cardIds[1], true);
    await answer(s.session_id, cardIds[2], false);

    const res = await post('/session/abandon', { session_id: s.session_id });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      summary: { correct_count: 2, wrong_count: 1, accuracy: 0.67, time_total_ms: expect.any(Number) },
      xp_earned: 0,
      leitner_added: { added: 1, skipped: 1 },
      leitner_advanced: 1,
      leitner_mastered_now: 0,
      streak_updated: false,
      correct_card_ids: expect.arrayContaining([cardIds[0], cardIds[1]]),
    });
    expect(res.body.data.correct_card_ids).toHaveLength(2);

    expect(await box(entryIds[0])).toMatchObject({ box_number: 1 });
    expect(await box(entryIds[1])).toMatchObject({ box_number: 3, total_reviews: 1 });
    expect(await box(entryIds[2])).toBeUndefined();
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM leitner_reviews WHERE user_id = $1', [userId])).rows[0].n).toBe(1);

    const row = await dbSession(s.session_id);
    expect(row).toMatchObject({ status: 'abandoned', completed_at: null, xp_earned: 0 });
    expect(row.abandoned_at).not.toBeNull();
    expect(await activityRows(s.session_id)).toBe(0);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM user_activity_log WHERE user_id = $1`, [userId])).rows[0].n).toBe(0);

    // readable afterwards, no longer offered, and closed for good
    expect((await get(`/session/${s.session_id}`)).body.data).toMatchObject({ status: 'abandoned', answered_count: 3, next_card_id: null });
    expect(await resumable()).toBeNull();
    for (const again of [
      await post('/session/abandon', { session_id: s.session_id }),
      await post('/session/complete', { session_id: s.session_id }),
      await answer(s.session_id, cardIds[0], true),
    ]) {
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('SESSION_ALREADY_COMPLETED');
    }
    expect(await box(entryIds[1])).toMatchObject({ box_number: 3, total_reviews: 1 });
  });

  it('a session with no answers is closed as a no-op: 200, nothing applied, then closed for good', async () => {
    const s = await start();
    const res = await post('/session/abandon', { session_id: s.session_id });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      summary: { correct_count: 0, wrong_count: 0, accuracy: 0, time_total_ms: expect.any(Number) },
      xp_earned: 0,
      leitner_added: { added: 0, skipped: 0 },
      leitner_advanced: 0,
      leitner_mastered_now: 0,
      streak_updated: false,
      correct_card_ids: [],
    });
    expect(await dbSession(s.session_id)).toMatchObject({ status: 'abandoned', xp_earned: 0 });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM leitner_cards WHERE user_id = $1', [userId])).rows[0].n).toBe(0);
    expect((await post('/session/abandon', { session_id: s.session_id })).body.error.code).toBe('SESSION_ALREADY_COMPLETED');
  });

  it('a completed session cannot be abandoned', async () => {
    const s = await start({ cards: cardIds.slice(0, 2) });
    await answer(s.session_id, cardIds[0], true);
    expect((await post('/session/complete', { session_id: s.session_id })).status).toBe(200);
    const res = await post('/session/abandon', { session_id: s.session_id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SESSION_ALREADY_COMPLETED');
    expect(await dbSession(s.session_id)).toMatchObject({ status: 'completed', abandoned_at: null });
  });

  it('somebody else\'s session and an unknown one are 404 and nothing changes; a bad body is 400', async () => {
    const s = await start({ cards: cardIds.slice(0, 2) });
    await answer(s.session_id, cardIds[0], true);
    const stranger = await post('/session/abandon', { session_id: s.session_id }, strangerToken);
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe('SESSION_NOT_FOUND');
    expect((await post('/session/abandon', { session_id: MISSING })).body.error.code).toBe('SESSION_NOT_FOUND');
    expect(await dbSession(s.session_id)).toMatchObject({ status: 'open', abandoned_at: null });
    expect(await box(entryIds[0])).toBeUndefined();

    for (const body of [{}, { session_id: 'nope' }, { session_id: 7 }]) {
      const bad = await post('/session/abandon', body);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('/complete still earns the bonus and the activity, and marks the session completed (not abandoned)', async () => {
    const s = await start({ cards: cardIds.slice(0, 2) });
    await answer(s.session_id, cardIds[0], false);
    const res = await post('/session/complete', { session_id: s.session_id });
    expect(res.body.data).toMatchObject({ xp_earned: 20, streak_updated: true });
    expect(await dbSession(s.session_id)).toMatchObject({ status: 'completed', abandoned_at: null, xp_earned: 20 });
    expect(await activityRows(s.session_id)).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('abandon and complete at the same time', () => {
  it('exactly one wins; the cards move ONE box, once; every other request is told the session is closed', async () => {
    // entries 0 and 1 sit in box 2, entry 2 is a new word; all three answered right
    for (const i of [0, 1]) {
      await pool.query(`INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at) VALUES ($1, $2, 2, NOW())`, [userId, entryIds[i]]);
    }
    const s = await start({ cards: cardIds.slice(0, 3) });
    for (const c of cardIds.slice(0, 3)) await answer(s.session_id, c, true);

    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => post('/session/abandon', { session_id: s.session_id })),
      ...Array.from({ length: 4 }, () => post('/session/complete', { session_id: s.session_id })),
    ]);
    const won = results.filter((r) => r.status === 200);
    expect(won).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('SESSION_ALREADY_COMPLETED');
    }
    expect(won[0].body.data).toMatchObject({ leitner_added: { added: 1, skipped: 2 }, leitner_advanced: 2 });

    // the database: box 2 → 3 exactly once, the new word in box 1, one review line per moved card
    expect(await box(entryIds[0])).toMatchObject({ box_number: 3, total_reviews: 1 });
    expect(await box(entryIds[1])).toMatchObject({ box_number: 3, total_reviews: 1 });
    expect(await box(entryIds[2])).toMatchObject({ box_number: 1 });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM leitner_reviews WHERE user_id = $1', [userId])).rows[0].n).toBe(2);

    // and the session says what the winner was: the bonus goes with 'completed', never with 'abandoned'
    const row = await dbSession(s.session_id);
    if (won[0].body.data.xp_earned > 0) {
      expect(row).toMatchObject({ status: 'completed', abandoned_at: null, xp_earned: 3 * 10 + 20 });
    } else {
      expect(row).toMatchObject({ status: 'abandoned', completed_at: null, xp_earned: 0 });
    }
  });

  it('several abandons at once apply the cards once', async () => {
    await pool.query(`INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at) VALUES ($1, $2, 2, NOW())`, [userId, entryIds[0]]);
    const s = await start({ cards: cardIds.slice(0, 2) });
    await answer(s.session_id, cardIds[0], true);
    await answer(s.session_id, cardIds[1], true);
    const results = await Promise.all(Array.from({ length: 6 }, () => post('/session/abandon', { session_id: s.session_id })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400 && r.body.error.code === 'SESSION_ALREADY_COMPLETED')).toHaveLength(5);
    expect(await box(entryIds[0])).toMatchObject({ box_number: 3, total_reviews: 1 });
    expect(await box(entryIds[1])).toMatchObject({ box_number: 1 });
    expect(await activityRows(s.session_id)).toBe(0);
  });
});
