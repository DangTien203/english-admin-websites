/**
 * POST /api/v1/practice/session/answer is idempotent per (session_id, card_id): the mobile app resumes sessions hours later and
 * re-sends an answer after a timeout or a crash. A repeat
 *   - is answered with the STORED result (what the first answer was graded as) plus `already_answered: true`;
 *   - does not grade again (no model call), does not touch the session counters or user_card_progress;
 *   - two copies sent at once count once (INSERT … ON CONFLICT DO NOTHING is the claim of the single write statement).
 * And POST /session/complete: the +20 bonus (and the activity log / streak) only for a session in which something was answered.
 *
 * Real PostgreSQL (needs migration 35). Fixtures: a user "test-pracidem-…@example.com", their deck, 4 entries "qzq<run>…"; removed in
 * afterAll. The model is mocked: no network.
 */
jest.mock('../services/openaiService', () => ({
  isOpenAIConfigured: jest.fn(() => false),
  gradeVietnameseAnswer: jest.fn(),
  gradeEnglishMeaning: jest.fn(),
  moderateInput: jest.fn(),
  gradeSentences: jest.fn(),
}));

import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { gradeVietnameseAnswer, isOpenAIConfigured } from '../services/openaiService';
import { registerUser } from './helpers/auth';
import { cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(180_000);

const mockGradeVi = gradeVietnameseAnswer as jest.MockedFunction<typeof gradeVietnameseAnswer>;
const mockConfigured = isOpenAIConfigured as jest.MockedFunction<typeof isOpenAIConfigured>;

const VI_OK = 'vật mẫu';
const MISSING = '00000000-0000-4000-8000-000000000000';

let token = '';
let userId = '';
let deckId = '';
const entryIds: string[] = [];
const cardIds: string[] = [];

const api = {
  post: (url: string, body: object = {}, as: string = token) => request(app).post(`/api/v1/practice${url}`).set('Authorization', `Bearer ${as}`).send(body),
};

beforeAll(async () => {
  const u = await registerUser('pracidem');
  token = u.accessToken;
  userId = u.userId;
  const deck = await request(app).post('/api/v1/decks').set('Authorization', `Bearer ${token}`).send({ title: 'Idempotent Answer Deck', level: 'beginner' });
  if (deck.status !== 201) throw new Error(`deck: ${JSON.stringify(deck.body)}`);
  deckId = deck.body.data.id;
  for (let i = 0; i < 4; i++) {
    entryIds.push(await createEntry({ tag: `pi${String.fromCharCode(97 + i)}` }));
    const card = await request(app).post(`/api/v1/decks/${deckId}/cards`).set('Authorization', `Bearer ${token}`).send({ entry_id: entryIds[i] });
    if (card.status !== 201) throw new Error(`card: ${JSON.stringify(card.body)}`);
    cardIds.push(card.body.data.id);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-pracidem-%'`);
  await cleanup();
});

beforeEach(() => {
  mockGradeVi.mockReset();
  mockConfigured.mockReset();
  mockConfigured.mockReturnValue(false);
});

async function startSession(cards: string[]): Promise<string> {
  const start = await api.post('/session/start', { deck_id: deckId, mode: 'flashcard', card_ids: cards });
  expect(start.status).toBe(200);
  return start.body.data.session_id as string;
}

const counters = async (sessionId: string) =>
  (await pool.query('SELECT answered_count, correct_count, wrong_count FROM practice_sessions WHERE id = $1', [sessionId])).rows[0];
const answerRows = async (sessionId: string, cardId: string): Promise<number> =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM practice_answers WHERE session_id = $1 AND card_id = $2', [sessionId, cardId])).rows[0].n;
const progress = async (cardId: string) =>
  (await pool.query('SELECT times_seen, times_correct FROM user_card_progress WHERE user_id = $1 AND card_id = $2', [userId, cardId])).rows[0];

describe('the same answer twice', () => {
  it('client-graded: the second call returns the stored result with already_answered, and changes nothing', async () => {
    const sessionId = await startSession([cardIds[0], cardIds[1]]);

    const first = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: true });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ progress: '1/2', correct_so_far: 1, wrong_so_far: 0 });
    expect(first.body.data.already_answered).toBeUndefined();

    const second = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: true });
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ ...first.body.data, already_answered: true });

    // a contradicting retry does not rewrite history either: the first answer stands
    const contradicting = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: false });
    expect(contradicting.status).toBe(200);
    expect(contradicting.body.data).toEqual({ ...first.body.data, already_answered: true });
    expect(contradicting.body.data.grading.correct).toBe(true);

    expect(await answerRows(sessionId, cardIds[0])).toBe(1);
    expect(await counters(sessionId)).toEqual({ answered_count: 1, correct_count: 1, wrong_count: 0 });
    expect(await progress(cardIds[0])).toMatchObject({ times_seen: 1, times_correct: 1 });

    // another card of the session still counts
    const other = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[1], correct: false });
    expect(other.body.data).toMatchObject({ progress: '2/2', correct_so_far: 1, wrong_so_far: 1 });
    expect(other.body.data.already_answered).toBeUndefined();
    expect(await counters(sessionId)).toEqual({ answered_count: 2, correct_count: 1, wrong_count: 1 });
  });

  it('typed answer: the stored grading comes back (it is not graded again, no model call)', async () => {
    mockConfigured.mockReturnValue(true);
    mockGradeVi.mockResolvedValue({
      output: { verdict: 'correct', confidence: 0.94, matched_answer: VI_OK, reason_vi: 'Cùng nghĩa.' },
      model_used: 'gpt-test',
      latency_ms: 5,
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: 0,
    });
    const sessionId = await startSession([cardIds[2]]);
    const body = { session_id: sessionId, card_id: cardIds[2], user_answer: 'đồ vật mẫu', time_ms: 900 };

    const first = await api.post('/session/answer', body);
    expect(first.status).toBe(200);
    expect(first.body.data.grading).toMatchObject({ correct: true, grading_source: 'openai', confidence: 0.94, matched_answer: VI_OK });
    expect(mockGradeVi).toHaveBeenCalledTimes(1);

    // Graded again it would come from the semantic cache, or (a different text) be a different verdict: the stored one is returned.
    const again = await api.post('/session/answer', body);
    const different = await api.post('/session/answer', { ...body, user_answer: 'hoàn toàn sai' });
    for (const repeat of [again, different]) {
      expect(repeat.status).toBe(200);
      expect(repeat.body.data).toEqual({ ...first.body.data, already_answered: true });
    }
    expect(typeof again.body.data.grading.confidence).toBe('number'); // NUMERIC comes back from pg as text
    expect(mockGradeVi).toHaveBeenCalledTimes(1);

    expect(await answerRows(sessionId, cardIds[2])).toBe(1);
    expect(await counters(sessionId)).toEqual({ answered_count: 1, correct_count: 1, wrong_count: 0 });
  });

  it('box 4 card: the English check is stored too (requires_english_meaning, english_grading with its accepted answers)', async () => {
    await pool.query(`INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at) VALUES ($1, $2, 4, NOW())`, [userId, entryIds[3]]);
    const sessionId = await startSession([cardIds[3]]);
    // right Vietnamese meaning, but the "English" answer is Vietnamese: a deterministic miss, no model involved
    const body = { session_id: sessionId, card_id: cardIds[3], user_answer: VI_OK, user_answer_en: VI_OK };

    const first = await api.post('/session/answer', body);
    expect(first.status).toBe(200);
    expect(first.body.data.requires_english_meaning).toBe(true);
    expect(first.body.data.grading).toMatchObject({ correct: false, grading_source: 'exact' });
    expect(first.body.data.english_grading).toMatchObject({ correct: false, grading_source: 'deterministic_miss' });
    expect(first.body.data.english_grading.accepted_answers.length).toBeGreaterThan(0);

    const second = await api.post('/session/answer', { ...body, user_answer_en: 'a thing' }); // would be right now: the stored result stands
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ ...first.body.data, already_answered: true });
    expect(await counters(sessionId)).toEqual({ answered_count: 1, correct_count: 0, wrong_count: 1 });
    expect(await progress(cardIds[3])).toMatchObject({ times_seen: 1, times_correct: 0 });
  });

  it('old rows (written before the grading columns existed) come back as client-graded answers', async () => {
    const sessionId = await startSession([cardIds[0]]);
    await pool.query(
      `INSERT INTO practice_answers (session_id, card_id, correct) VALUES ($1, $2, true)`,
      [sessionId, cardIds[0]]
    );
    await pool.query(`UPDATE practice_sessions SET answered_count = 1, correct_count = 1 WHERE id = $1`, [sessionId]);
    const res = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      progress: '1/1',
      correct_so_far: 1,
      wrong_so_far: 0,
      grading: { correct: true, verdict: 'correct', confidence: 1, grading_source: 'client_legacy', matched_answer: null, accepted_answers: [], reason_vi: null },
      requires_english_meaning: false,
      english_grading: null,
      already_answered: true,
    });
  });

  it('the same card in two sessions is answered once in EACH (the key is session + card)', async () => {
    const before = (await progress(cardIds[1])) ?? { times_seen: 0, times_correct: 0 };
    const a = await startSession([cardIds[1]]);
    const b = await startSession([cardIds[1]]);
    for (const sessionId of [a, b]) {
      const res = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[1], correct: true });
      expect(res.status).toBe(200);
      expect(res.body.data.already_answered).toBeUndefined();
      expect(await counters(sessionId)).toEqual({ answered_count: 1, correct_count: 1, wrong_count: 0 });
    }
    expect(await progress(cardIds[1])).toMatchObject({ times_seen: before.times_seen + 2, times_correct: before.times_correct + 2 });
  });
});

describe('the same answer many times at once', () => {
  it('counts once: one insert wins, every request gets 200 with the same stored result, the others say already_answered', async () => {
    const sessionId = await startSession([cardIds[0], cardIds[1]]);
    const before = (await progress(cardIds[0])) ?? { times_seen: 0, times_correct: 0 };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: true, time_ms: 500 }))
    );
    for (const r of results) expect(r.status).toBe(200);
    const winners = results.filter((r) => r.body.data.already_answered === undefined);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.body.data.already_answered === true)).toHaveLength(9);
    // every response, winner or not, reports the one answer: 1 of 2, 1 right
    for (const r of results) expect(r.body.data).toMatchObject({ progress: '1/2', correct_so_far: 1, wrong_so_far: 0, grading: { correct: true } });

    expect(await answerRows(sessionId, cardIds[0])).toBe(1);
    expect(await counters(sessionId)).toEqual({ answered_count: 1, correct_count: 1, wrong_count: 0 });
    expect(await progress(cardIds[0])).toMatchObject({ times_seen: before.times_seen + 1, times_correct: before.times_correct + 1 });
  });
});

describe('errors keep their codes', () => {
  it('SESSION_NOT_FOUND: an unknown session, and the session of somebody else (their stored answer is not shown)', async () => {
    const sessionId = await startSession([cardIds[0]]);
    await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: true });
    const stranger = await registerUser('pracidem');
    const asStranger = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: true }, stranger.accessToken);
    expect(asStranger.status).toBe(404);
    expect(asStranger.body.error.code).toBe('SESSION_NOT_FOUND');
    const unknown = await api.post('/session/answer', { session_id: MISSING, card_id: cardIds[0], correct: true });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('SESSION_ALREADY_COMPLETED: a completed session takes no answer, not even a repeat of one it has', async () => {
    const sessionId = await startSession([cardIds[0]]);
    await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: true });
    expect((await api.post('/session/complete', { session_id: sessionId })).status).toBe(200);
    const repeat = await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: true });
    expect(repeat.status).toBe(400);
    expect(repeat.body.error.code).toBe('SESSION_ALREADY_COMPLETED');
  });

  it('CARD_NOT_FOUND: a card that does not exist (typed and client-graded)', async () => {
    const sessionId = await startSession([cardIds[0]]);
    for (const body of [{ user_answer: VI_OK }, { correct: true }]) {
      const res = await api.post('/session/answer', { session_id: sessionId, card_id: MISSING, ...body });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CARD_NOT_FOUND');
    }
    expect(await counters(sessionId)).toEqual({ answered_count: 0, correct_count: 0, wrong_count: 0 });
  });
});

describe('completing a session: the +20 bonus needs an answer', () => {
  const activityRows = async (sessionId: string): Promise<number> =>
    (await pool.query(`SELECT COUNT(*)::int AS n FROM user_activity_log WHERE user_id = $1 AND action = 'practice_session' AND details->>'session_id' = $2`, [userId, sessionId])).rows[0].n;

  it('no answers: xp_earned 0, the response shape is unchanged, nothing is logged for the streak', async () => {
    const sessionId = await startSession([cardIds[0], cardIds[1]]);
    const done = await api.post('/session/complete', { session_id: sessionId });
    expect(done.status).toBe(200);
    expect(done.body.data).toEqual({
      summary: { correct_count: 0, wrong_count: 0, accuracy: 0, time_total_ms: expect.any(Number) },
      xp_earned: 0,
      leitner_added: { added: 0, skipped: 0 },
      leitner_advanced: 0,
      leitner_mastered_now: 0,
      streak_updated: false,
      correct_card_ids: [],
    });
    const row = (await pool.query('SELECT completed_at, xp_earned FROM practice_sessions WHERE id = $1', [sessionId])).rows[0];
    expect(row.completed_at).not.toBeNull();
    expect(row.xp_earned).toBe(0);
    expect(await activityRows(sessionId)).toBe(0);
    // and it is completed for good
    expect((await api.post('/session/complete', { session_id: sessionId })).body.error.code).toBe('SESSION_ALREADY_COMPLETED');
  });

  it('one wrong answer is enough for the bonus: xp_earned 20, the activity is logged', async () => {
    const sessionId = await startSession([cardIds[0], cardIds[1]]);
    await api.post('/session/answer', { session_id: sessionId, card_id: cardIds[0], correct: false });
    const done = await api.post('/session/complete', { session_id: sessionId });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ xp_earned: 20, streak_updated: true, summary: { correct_count: 0, wrong_count: 1 } });
    expect((await pool.query('SELECT xp_earned FROM practice_sessions WHERE id = $1', [sessionId])).rows[0].xp_earned).toBe(20);
    expect(await activityRows(sessionId)).toBe(1);
  });

  it('answers, some repeated: 10 per distinct right answer + 20', async () => {
    const sessionId = await startSession([cardIds[0], cardIds[1]]);
    for (const [card, correct] of [[cardIds[0], true], [cardIds[0], true], [cardIds[1], true], [cardIds[1], false]] as const) {
      await api.post('/session/answer', { session_id: sessionId, card_id: card, correct });
    }
    const done = await api.post('/session/complete', { session_id: sessionId });
    expect(done.body.data).toMatchObject({ xp_earned: 2 * 10 + 20, summary: { correct_count: 2, wrong_count: 0, accuracy: 1 } });
  });
});
