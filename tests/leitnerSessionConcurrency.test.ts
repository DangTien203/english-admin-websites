/**
 * Answering a review step is ONE statement (services/leitnerSessionService.ts, ANSWER_STEP_SQL): the session row lock, the claim on
 * the step, the move of the word's card and the update of the step. These tests run it against the real database where the old
 * BEGIN … COMMIT transaction had its guarantees:
 *   - the same step answered by several requests at once is written once and moves the card once;
 *   - an answer racing the completion of its session is either counted by the summary or refused, never half applied;
 *   - what the statement writes into word_outcome has the shape the API serves (ISO dates, the same keys), and the total time of
 *     a two-check word is the sum of its checks;
 *   - sessions started before the "reviewed elsewhere" guard existed (start_total_reviews NULL) still move their cards.
 *
 * Fixtures: dictionary entries "qzq<run>…" and mobile users "test-leitconc-…@example.com", all removed in afterAll. No network:
 * answers are client-graded ({ correct }) or match the fixture entry exactly.
 */
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser } from './helpers/auth';
import { cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(180_000);

const VI_OK = 'vật mẫu';
const EN_OK = 'a thing used in a test';
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let entries: string[] = [];

interface Player {
  userId: string;
  token: string;
}

async function newPlayer(): Promise<Player> {
  const u = await registerUser('leitconc');
  return { userId: u.userId, token: u.accessToken };
}

async function addCards(p: Player, specs: Array<[number, number]>): Promise<string[]> {
  const ids: string[] = [];
  for (const [entry, box] of specs) {
    const { rows } = await pool.query(
      `INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at) VALUES ($1, $2, $3, NOW() - INTERVAL '1 minute') RETURNING id`,
      [p.userId, entries[entry], box]
    );
    ids.push(rows[0].id);
  }
  return ids;
}

const api = (p: Player) => ({
  post: (url: string, body: object = {}) => request(app).post(`/api/v1/leitner${url}`).set('Authorization', `Bearer ${p.token}`).send(body),
});

const card = async (id: string) =>
  (await pool.query('SELECT box_number, due_at, total_reviews, correct_streak FROM leitner_cards WHERE id = $1', [id])).rows[0];
const reviews = async (id: string) =>
  (await pool.query('SELECT correct, old_box, new_box, time_ms FROM leitner_reviews WHERE leitner_card_id = $1', [id])).rows;

beforeAll(async () => {
  for (let i = 0; i < 4; i++) entries.push(await createEntry({ tag: `lc${String.fromCharCode(97 + i)}` }));
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-leitconc-%'`);
  await cleanup();
});

describe('the same step answered by several requests at once', () => {
  it('is written once and moves the card once; the others are told it was answered', async () => {
    const p = await newPlayer();
    const [id] = await addCards(p, [[0, 2]]);
    const s = (await api(p).post('/session/start', { box_number: 2 })).body.data;

    const answers = await Promise.all(
      Array.from({ length: 6 }, () => api(p).post('/session/answer', { session_id: s.session_id, step_index: 0, correct: true }))
    );
    const ok = answers.filter((r) => r.status === 200);
    const refused = answers.filter((r) => r.status !== 200);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect(r.body.error).toMatchObject({ code: 'STEP_ALREADY_ANSWERED' });
    expect(ok[0].body.data.word).toMatchObject({ resolved: true, result: 'advance', new_box_number: 3, applied: true });

    expect(await card(id)).toMatchObject({ box_number: 3, total_reviews: 1, correct_streak: 1 });
    expect(await reviews(id)).toHaveLength(1);
    const step = (await pool.query('SELECT answered_at, correct, word_outcome FROM leitner_review_steps WHERE session_id = $1', [s.session_id])).rows;
    expect(step).toHaveLength(1);
    expect(step[0]).toMatchObject({ correct: true, word_outcome: { result: 'advance', applied: true, new_box_number: 3 } });
  });

  it('also when two sessions of the same user answer the same card at once: the card moves once', async () => {
    const p = await newPlayer();
    const [id] = await addCards(p, [[1, 2]]);
    const a = (await api(p).post('/session/start', { box_number: 2 })).body.data;
    const b = (await api(p).post('/session/start', { box_number: 2 })).body.data;
    expect(a.session_id).not.toBe(b.session_id);

    const [ra, rb] = await Promise.all([
      api(p).post('/session/answer', { session_id: a.session_id, step_index: 0, correct: true }),
      api(p).post('/session/answer', { session_id: b.session_id, step_index: 0, correct: true }),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]); // both steps are recorded …
    const applied = [ra, rb].map((r) => r.body.data.word.applied).sort();
    expect(applied).toEqual([false, true]); // … but only one of them moved the card ("reviewed elsewhere" for the other)
    expect(await card(id)).toMatchObject({ box_number: 3, total_reviews: 1 });
    expect(await reviews(id)).toHaveLength(1);
  });
});

describe('an answer racing the completion of its session', () => {
  it('is either counted by the summary or refused — never half applied', async () => {
    for (let round = 0; round < 3; round++) {
      const p = await newPlayer();
      const [first, second] = await addCards(p, [
        [2, 2],
        [3, 2],
      ]);
      const s = (await api(p).post('/session/start', { box_number: 2 })).body.data;
      const order: string[] = s.steps.map((x: any) => x.leitner_card_id);
      expect((await api(p).post('/session/answer', { session_id: s.session_id, step_index: 0, correct: true })).status).toBe(200);

      const [answer, complete] = await Promise.all([
        api(p).post('/session/answer', { session_id: s.session_id, step_index: 1, correct: true }),
        api(p).post('/session/complete', { session_id: s.session_id }),
      ]);
      expect(complete.status).toBe(200);
      const second$ = order[1];
      expect([first, second]).toContain(second$);

      if (answer.status === 200) {
        // the answer landed first (or the completion waited for it): the summary counts both words, the card moved
        expect(complete.body.data.summary).toMatchObject({ total_words: 2, correct_words: 2, skipped_words: 0 });
        expect((await card(second$)).box_number).toBe(3);
      } else {
        // the completion came first: the answer is refused, the word is skipped and its card was left alone
        expect(answer.status).toBe(400);
        expect(answer.body.error.code).toBe('SESSION_ALREADY_COMPLETED');
        expect(complete.body.data.summary).toMatchObject({ total_words: 2, correct_words: 1, skipped_words: 1 });
        expect((await card(second$)).box_number).toBe(2);
        expect(await reviews(second$)).toHaveLength(0);
      }
    }
  });
});

describe('what the single statement writes', () => {
  it('stores the outcome of a two-check word with ISO dates, the summed time and mastered_now', async () => {
    const p = await newPlayer();
    const [id] = await addCards(p, [[0, 4]]);
    const s = (await api(p).post('/session/start', { box_number: 4 })).body.data;
    expect(s.steps.map((x: any) => x.check)).toEqual(['en', 'vi']);

    const en = await api(p).post('/session/answer', { session_id: s.session_id, step_index: 0, user_answer: EN_OK, time_ms: 1000 });
    expect(en.status).toBe(200);
    expect(en.body.data.word).toMatchObject({ resolved: false, result: null, next_due_at: null, new_box_number: null });
    expect((await card(id)).total_reviews).toBe(0); // the first check moves nothing
    const mid = (await pool.query('SELECT word_outcome, grading, user_answer, time_ms FROM leitner_review_steps WHERE session_id = $1 AND step_index = 0', [s.session_id])).rows[0];
    expect(mid).toMatchObject({ word_outcome: null, user_answer: EN_OK, time_ms: 1000 });
    expect(mid.grading).toMatchObject({ correct: true, grading_source: 'exact' });

    const vi = await api(p).post('/session/answer', { session_id: s.session_id, step_index: 1, user_answer: VI_OK, time_ms: 2500 });
    expect(vi.status).toBe(200);
    const word = vi.body.data.word;
    expect(word).toMatchObject({ resolved: true, correct: true, result: 'advance', applied: true, new_box_number: 5, mastered_now: true });
    expect(word.next_due_at).toMatch(ISO_MS);
    expect(new Date(word.next_due_at).toISOString()).toBe(word.next_due_at);

    const row = await card(id);
    expect(row.box_number).toBe(5);
    expect(Math.abs(Date.parse(word.next_due_at) - row.due_at.getTime())).toBeLessThanOrEqual(1); // the date served is the date stored
    const [review, ...rest] = await reviews(id);
    expect(rest).toHaveLength(0);
    expect(review).toMatchObject({ correct: true, old_box: 4, new_box: 5, time_ms: 3500 }); // 1000 + 2500

    // the stored outcome has the same keys and values the answer showed, and the summary serves it unchanged
    const stored = (await pool.query('SELECT word_outcome FROM leitner_review_steps WHERE session_id = $1 AND step_index = 1', [s.session_id])).rows[0].word_outcome;
    expect(stored).toEqual({
      correct: true,
      result: 'advance',
      applied: true,
      old_box_number: 4,
      new_box_number: 5,
      next_due_at: word.next_due_at,
      mastered_now: true,
    });
    const done = (await api(p).post('/session/complete', { session_id: s.session_id })).body.data;
    expect(done.words[0]).toMatchObject({ status: 'correct', old_box_number: 4, new_box_number: 5, next_due_at: word.next_due_at, mastered_now: true });
  });

  it('keeps a word in its box when only one of its two checks is right (hold) and a wrong word goes back to box 1', async () => {
    const p = await newPlayer();
    const [hold, reset] = await addCards(p, [
      [0, 4],
      [1, 5],
    ]);
    const s = (await api(p).post('/session/start', { limit: 10 })).body.data;
    const typed = (stepCard: string, check: string) => (stepCard === hold ? (check === 'en' ? EN_OK : '') : '');
    const outcomes = new Map<string, any>();
    for (const step of s.steps) {
      const res = await api(p).post('/session/answer', {
        session_id: s.session_id,
        step_index: step.step_index,
        user_answer: typed(step.leitner_card_id, step.check),
      });
      expect(res.status).toBe(200);
      if (res.body.data.word.resolved) outcomes.set(step.leitner_card_id, res.body.data.word);
    }
    expect(outcomes.get(hold)).toMatchObject({ result: 'hold', correct: false, new_box_number: 4, mastered_now: false, applied: true });
    expect(outcomes.get(reset)).toMatchObject({ result: 'reset', new_box_number: 1, applied: true });
    expect(await card(hold)).toMatchObject({ box_number: 4, total_reviews: 1, correct_streak: 0 });
    expect(await card(reset)).toMatchObject({ box_number: 1, total_reviews: 1, correct_streak: 0 });
    expect((await reviews(hold))[0]).toMatchObject({ correct: true, old_box: 4, new_box: 4 });
    expect((await reviews(reset))[0]).toMatchObject({ correct: false, old_box: 5, new_box: 1 });
  });

  it('a session from before the reviewed-elsewhere guard (start_total_reviews NULL) still moves its card', async () => {
    const p = await newPlayer();
    const [id] = await addCards(p, [[2, 3]]);
    const s = (await api(p).post('/session/start', { box_number: 3 })).body.data;
    await pool.query('UPDATE leitner_review_steps SET start_total_reviews = NULL WHERE session_id = $1', [s.session_id]);
    await pool.query('UPDATE leitner_cards SET total_reviews = total_reviews + 5 WHERE id = $1', [id]); // reviewed elsewhere; no guard to notice

    const res = await api(p).post('/session/answer', { session_id: s.session_id, step_index: 0, correct: true });
    expect(res.status).toBe(200);
    expect(res.body.data.word).toMatchObject({ result: 'advance', applied: true, new_box_number: 4 });
    expect(await card(id)).toMatchObject({ box_number: 4, total_reviews: 6 });
  });

  it('records a word whose card was reviewed elsewhere as not applied, and leaves the card alone', async () => {
    const p = await newPlayer();
    const [id] = await addCards(p, [[3, 3]]);
    const s = (await api(p).post('/session/start', { box_number: 3 })).body.data;
    await pool.query('UPDATE leitner_cards SET total_reviews = total_reviews + 1 WHERE id = $1', [id]);

    const res = await api(p).post('/session/answer', { session_id: s.session_id, step_index: 0, correct: true });
    expect(res.status).toBe(200);
    expect(res.body.data.word).toMatchObject({ resolved: true, applied: false, new_box_number: null, next_due_at: null, mastered_now: false });
    expect(await card(id)).toMatchObject({ box_number: 3, total_reviews: 1 });
    expect(await reviews(id)).toHaveLength(0);
    const stored = (await pool.query('SELECT word_outcome FROM leitner_review_steps WHERE session_id = $1', [s.session_id])).rows[0].word_outcome;
    expect(stored).toMatchObject({ applied: false, new_box_number: null, next_due_at: null, mastered_now: false, old_box_number: 3 });
  });
});

describe('starting a session', () => {
  it('answers with the same steps a later GET /session/:id shows', async () => {
    const p = await newPlayer();
    await addCards(p, [
      [0, 4],
      [1, 2],
      [2, 5],
    ]);
    const started = (await api(p).post('/session/start', { limit: 10 })).body.data;
    const read = (await request(app).get(`/api/v1/leitner/session/${started.session_id}`).set('Authorization', `Bearer ${p.token}`)).body.data;
    expect(read).toEqual(started);
    expect(started.steps).toHaveLength(5); // two dual words + one single
    expect(started.steps.every((x: any) => x.entry.headword && x.answered === false && x.correct === null)).toBe(true);
  });
});
