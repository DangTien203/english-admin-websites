/**
 * Leitner review sessions (POST /api/v1/leitner/session/*) on the real database.
 *
 * Covers: only DUE words are ever reviewed (also per box), box 4/5 words are checked on both meanings (two steps, spaced apart,
 * counted once), the box rule (both right → next box, one right → box kept, none → box 1), step order, the "reviewed elsewhere"
 * guard and the word-based summary.
 *
 * Fixtures: 8 dictionary entries "qzq<run>…" (tests/helpers/lookupAdminFixtures.ts) and one mobile user per test
 * "test-leitsess-…@example.com"; everything is removed in afterAll (the user's cards and sessions go with the user). No network:
 * wrong answers are sent EMPTY, which is graded without calling OpenAI, and right answers match the entry exactly.
 */
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { getIntervals } from '../utils/leitnerManager';
import { registerUser } from './helpers/auth';
import { cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(180_000);

// What the fixture entry accepts: meaning_vi "cái dùng để thử; vật mẫu", sense definition_en "a thing used in a test".
const VI_OK = 'vật mẫu';
const EN_OK = 'a thing used in a test';
const DAY = 86_400_000;

let entries: string[] = [];

interface Player {
  userId: string;
  token: string;
}

async function newPlayer(): Promise<Player> {
  const u = await registerUser('leitsess');
  return { userId: u.userId, token: u.accessToken };
}

/** One leitner card per spec: [entry index, box, minutes until due (negative = already due)]. Returns card ids in spec order. */
async function addCards(p: Player, specs: Array<[number, number, number]>): Promise<string[]> {
  const ids: string[] = [];
  for (const [entry, box, dueInMin] of specs) {
    const { rows } = await pool.query(
      `INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at)
       VALUES ($1, $2, $3, NOW() + ($4::int * INTERVAL '1 minute')) RETURNING id`,
      [p.userId, entries[entry], box, dueInMin]
    );
    ids.push(rows[0].id);
  }
  return ids;
}

const api = (p: Player) => ({
  get: (url: string) => request(app).get(`/api/v1/leitner${url}`).set('Authorization', `Bearer ${p.token}`),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1/leitner${url}`).set('Authorization', `Bearer ${p.token}`).send(body),
});

const cardRow = async (id: string) =>
  (await pool.query('SELECT box_number, due_at, total_reviews, correct_streak FROM leitner_cards WHERE id = $1', [id])).rows[0];

const wordIds = (steps: any[]): string[] => [...new Set<string>(steps.map((s) => s.leitner_card_id))];

beforeAll(async () => {
  for (let i = 0; i < 8; i++) entries.push(await createEntry({ tag: `lt${String.fromCharCode(97 + i)}` }));
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-leitsess-%'`);
  await cleanup();
});

describe('only due words are reviewed', () => {
  it('a box session takes the due words of that box and nothing else', async () => {
    const p = await newPlayer();
    const [c0, c1, c2, c3, c4, c5, c6] = await addCards(p, [
      [0, 3, -60], // due, 1 h overdue
      [1, 3, -120],
      [2, 3, -180], // the most overdue
      [3, 3, 24 * 60], // not due yet
      [4, 3, 2 * 24 * 60],
      [5, 4, -30], // due, other box
      [6, 5, 3 * 24 * 60], // not due, other box
    ]);

    const all = await api(p).post('/session/start', { box_number: 3, limit: 10 });
    expect(all.status).toBe(200);
    expect(all.body.data).toMatchObject({ box_number: 3, total_words: 3, total_steps: 3 });
    expect(wordIds(all.body.data.steps).sort()).toEqual([c0, c1, c2].sort());
    expect(all.body.data.steps.every((s: any) => s.check === 'vi' && s.typed_answer_required === false)).toBe(true);

    // limit fewer than are due: the most overdue ones
    const two = await api(p).post('/session/start', { box_number: 3, limit: 2 });
    expect(two.body.data.total_words).toBe(2);
    expect(wordIds(two.body.data.steps).sort()).toEqual([c1, c2].sort());

    // "review due now" (no box) takes every box, still only due words
    const now = await api(p).post('/session/start', {});
    expect(now.body.data.box_number).toBeNull();
    expect(wordIds(now.body.data.steps).sort()).toEqual([c0, c1, c2, c5].sort());
    expect(wordIds(now.body.data.steps)).not.toEqual(expect.arrayContaining([c3, c4, c6]));
  });

  it('refuses a box that has no due word, even though it has words', async () => {
    const p = await newPlayer();
    await addCards(p, [
      [0, 5, 3 * 24 * 60],
      [1, 5, 5 * 24 * 60],
    ]);
    const res = await api(p).post('/session/start', { box_number: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'NO_DUE_CARDS', details: { box_number: 5 } });

    expect((await api(p).post('/session/start', {})).body.error.code).toBe('NO_DUE_CARDS');
  });

  it('rejects a box number outside 1–5', async () => {
    const p = await newPlayer();
    for (const box_number of [0, 6, 2.5]) {
      expect((await api(p).post('/session/start', { box_number })).status).toBe(400);
    }
  });

  it('shows how many words of a box are due: GET /box/:n → due_count', async () => {
    const p = await newPlayer();
    await addCards(p, [
      [0, 2, -10],
      [1, 2, -20],
      [2, 2, 60],
    ]);
    const res = await api(p).get('/box/2');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 3, due_count: 2 });
    expect((await api(p).get('/box/4')).body.data).toMatchObject({ total: 0, due_count: 0 });
  });

  it('words just promoted out of a box are not offered again in the next box', async () => {
    const p = await newPlayer();
    const promoted = await addCards(p, [0, 1, 2, 3, 4].map((i) => [i, 3, -10 * (i + 1)] as [number, number, number]));
    const [d0, d1] = await addCards(p, [
      [5, 4, -5],
      [6, 4, -6],
    ]);

    // review the five box-3 words, all right → they move to box 4, due in a week
    const s3 = (await api(p).post('/session/start', { box_number: 3 })).body.data;
    expect(s3.total_words).toBe(5);
    for (const step of s3.steps) {
      const r = await api(p).post('/session/answer', { session_id: s3.session_id, step_index: step.step_index, correct: true });
      expect(r.status).toBe(200);
    }
    for (const id of promoted) expect((await cardRow(id)).box_number).toBe(4);

    // box 4 now holds seven words but only the two that were already there are due
    expect((await api(p).get('/box/4')).body.data).toMatchObject({ total: 7, due_count: 2 });
    const s4 = await api(p).post('/session/start', { box_number: 4 });
    expect(s4.body.data).toMatchObject({ total_words: 2, total_steps: 4 }); // fewer than 5 due: just those, two checks each
    expect(wordIds(s4.body.data.steps).sort()).toEqual([d0, d1].sort());
  });
});

describe('box 4/5 words: both meanings, counted once', () => {
  it('asks English then Vietnamese, 2+ steps apart, and applies both-right / one-right / none-right', async () => {
    const p = await newPlayer();
    const [advance1, holdEn, holdVi, reset, advance2] = await addCards(p, [0, 1, 2, 3, 4].map((i) => [i, 4, -10 * (i + 1)] as [number, number, number]));
    const intervals = await getIntervals();

    const start = (await api(p).post('/session/start', { box_number: 4, limit: 5 })).body.data;
    expect(start).toMatchObject({ total_words: 5, total_steps: 10 });
    expect(start.min_steps_between_checks).toBeGreaterThanOrEqual(2);
    for (const id of wordIds(start.steps)) {
      const own = start.steps.filter((s: any) => s.leitner_card_id === id);
      expect(own.map((s: any) => s.check)).toEqual(['en', 'vi']); // English first, then Vietnamese
      expect(own[1].step_index - own[0].step_index - 1).toBeGreaterThanOrEqual(2);
      expect(own.every((s: any) => s.typed_answer_required && s.checks_total === 2)).toBe(true);
    }

    // the order is enforced, a typed answer is mandatory, a step can be answered once
    expect((await api(p).post('/session/answer', { session_id: start.session_id, step_index: 1, user_answer: EN_OK })).body.error).toMatchObject({
      code: 'STEP_OUT_OF_ORDER',
      details: { expected_step_index: 0 },
    });
    expect((await api(p).post('/session/answer', { session_id: start.session_id, step_index: 0, correct: true })).body.error.code).toBe('TYPED_ANSWER_REQUIRED');
    const stranger = await newPlayer();
    expect((await api(stranger).post('/session/answer', { session_id: start.session_id, step_index: 0, user_answer: EN_OK })).body.error.code).toBe('SESSION_NOT_FOUND');
    expect((await api(p).post('/review', { leitner_card_id: advance1, correct: true })).body.error.code).toBe('REVIEW_SESSION_REQUIRED');

    // [English answer, Vietnamese answer] per card; '' is a deliberate "don't know"
    const answers = new Map<string, [string, string]>([
      [advance1, [EN_OK, VI_OK]],
      [holdEn, [EN_OK, '']],
      [holdVi, ['', VI_OK]],
      [reset, ['', '']],
      [advance2, [EN_OK, VI_OK]],
    ]);
    const resolved = new Map<string, any>();
    let last: any;
    for (const step of start.steps) {
      const [en, vi] = answers.get(step.leitner_card_id)!;
      const res = await api(p).post('/session/answer', {
        session_id: start.session_id,
        step_index: step.step_index,
        user_answer: step.check === 'en' ? en : vi,
        time_ms: 1500,
      });
      expect(res.status).toBe(200);
      last = res.body.data;
      if (last.word.resolved) resolved.set(step.leitner_card_id, last.word);
      else expect(last.word).toMatchObject({ resolved: false, result: null, new_box_number: null }); // first check of a word: nothing moves yet
    }
    expect(last.progress).toMatchObject({ answered_steps: 10, total_steps: 10, resolved_words: 5, total_words: 5, next_step_index: null });
    expect((await api(p).post('/session/answer', { session_id: start.session_id, step_index: 0, user_answer: EN_OK })).body.error.code).toBe('STEP_ALREADY_ANSWERED');

    expect(resolved.get(advance1)).toMatchObject({ result: 'advance', correct: true, new_box_number: 5, mastered_now: true, applied: true });
    expect(resolved.get(holdEn)).toMatchObject({ result: 'hold', correct: false, new_box_number: 4, mastered_now: false, checks_correct: 1 });
    expect(resolved.get(holdVi)).toMatchObject({ result: 'hold', new_box_number: 4 });
    expect(resolved.get(reset)).toMatchObject({ result: 'reset', new_box_number: 1, checks_correct: 0 });

    // database: boxes, schedule, one review row per word (not per step)
    const days = async (id: string) => ((await cardRow(id)).due_at.getTime() - Date.now()) / DAY;
    expect((await cardRow(advance1)).box_number).toBe(5);
    expect(Math.abs((await days(advance1)) - intervals[4])).toBeLessThan(0.01);
    for (const id of [holdEn, holdVi]) {
      expect((await cardRow(id)).box_number).toBe(4);
      expect(Math.abs((await days(id)) - intervals[3])).toBeLessThan(0.01); // rescheduled with box 4's interval
    }
    expect((await cardRow(holdEn)).total_reviews).toBe(1);
    expect((await cardRow(reset)).box_number).toBe(1);
    expect((await cardRow(advance2)).box_number).toBe(5);
    const reviews = await pool.query(
      `SELECT leitner_card_id, correct, old_box, new_box FROM leitner_reviews WHERE user_id = $1 ORDER BY new_box`,
      [p.userId]
    );
    expect(reviews.rows).toHaveLength(5);
    expect(reviews.rows.find((r) => r.leitner_card_id === holdEn)).toMatchObject({ correct: true, old_box: 4, new_box: 4 });
    expect(reviews.rows.find((r) => r.leitner_card_id === reset)).toMatchObject({ correct: false, old_box: 4, new_box: 1 });

    // summary: five words, not ten steps
    const done = (await api(p).post('/session/complete', { session_id: start.session_id })).body.data;
    expect(done.summary).toMatchObject({
      total_words: 5,
      correct_words: 2,
      partial_words: 2,
      wrong_words: 1,
      skipped_words: 0,
      accuracy: 0.4,
      mastered_now: 2,
    });
    expect(done.words).toHaveLength(5);
    expect(done.words.find((w: any) => w.leitner_card_id === holdEn)).toMatchObject({ status: 'partial', result: 'hold', old_box_number: 4, new_box_number: 4 });
    expect((await api(p).post('/session/complete', { session_id: start.session_id })).body.error.code).toBe('SESSION_ALREADY_COMPLETED');

    // the same session can be read back
    const again = (await api(p).get(`/session/${start.session_id}`)).body.data;
    expect(again).toMatchObject({ completed: true, total_words: 5, total_steps: 10 });
    expect(again.progress.resolved_words).toBe(5);
  });

  it('does not accept the Vietnamese meaning as the answer to the English check', async () => {
    const p = await newPlayer();
    // [English-check answer, expected]: every Vietnamese form of the meaning is wrong, however it is typed
    const [withMarks, noMarks, otherForm, english] = await addCards(p, [0, 1, 2, 3].map((i) => [i, 4, -10 * (i + 1)] as [number, number, number]));
    const typedEn = new Map<string, string>([
      [withMarks, VI_OK], // "vật mẫu"
      [noMarks, 'vat mau'], // the same meaning typed without diacritics
      [otherForm, 'cái dùng để thử'], // the other Vietnamese form of the meaning
      [english, EN_OK], // a real English answer still passes
    ]);

    const s = (await api(p).post('/session/start', { box_number: 4 })).body.data;
    const seen = new Map<string, any>();
    for (const step of s.steps) {
      const res = await api(p).post('/session/answer', {
        session_id: s.session_id,
        step_index: step.step_index,
        user_answer: step.check === 'en' ? typedEn.get(step.leitner_card_id) : VI_OK, // the Vietnamese check is answered rightly
      });
      expect(res.status).toBe(200);
      if (step.check === 'en') seen.set(step.leitner_card_id, res.body.data.grading);
      else expect(res.body.data.grading.correct).toBe(true);
    }

    for (const id of [withMarks, noMarks, otherForm]) {
      expect(seen.get(id)).toMatchObject({ correct: false, verdict: 'wrong', grading_source: 'deterministic_miss' });
      expect(seen.get(id).reason_vi).toContain('tiếng Anh');
      expect(seen.get(id).accepted_answers).toContain(EN_OK); // what was asked: the English definitions
    }
    expect(seen.get(english)).toMatchObject({ correct: true, grading_source: 'exact' });

    // wrong English check + right Vietnamese check → the box is kept, not promoted
    for (const id of [withMarks, noMarks, otherForm]) expect((await cardRow(id)).box_number).toBe(4);
    expect((await cardRow(english)).box_number).toBe(5);
  });

  it('counts an unfinished word as skipped and leaves its box alone', async () => {
    const p = await newPlayer();
    const cards = await addCards(p, [0, 1, 2].map((i) => [i, 5, -10 * (i + 1)] as [number, number, number]));
    const s = (await api(p).post('/session/start', { box_number: 5 })).body.data;
    expect(s).toMatchObject({ total_words: 3, total_steps: 6 });

    // answer only the first two steps, then stop
    for (const step of s.steps.slice(0, 2)) {
      await api(p).post('/session/answer', { session_id: s.session_id, step_index: step.step_index, user_answer: step.check === 'en' ? EN_OK : VI_OK });
    }
    const done = (await api(p).post('/session/complete', { session_id: s.session_id })).body.data;
    expect(done.summary).toMatchObject({ total_words: 3, skipped_words: 3, correct_words: 0 }); // no word has both checks yet
    expect(done.words.map((w: any) => w.status)).toEqual(['skipped', 'skipped', 'skipped']);
    for (const id of cards) expect((await cardRow(id)).box_number).toBe(5);
  });
});

describe('box 1–3 words and the reviewed-elsewhere guard', () => {
  it('moves a right word up and a wrong word to box 1; leaves a word reviewed elsewhere alone', async () => {
    const p = await newPlayer();
    const [right, wrong, elsewhere] = await addCards(p, [
      [0, 2, -10],
      [1, 2, -20],
      [2, 2, -30],
    ]);
    const s = (await api(p).post('/session/start', { box_number: 2 })).body.data;
    expect(s).toMatchObject({ total_words: 3, total_steps: 3 });

    // another review of the third card lands while the session is open
    await pool.query('UPDATE leitner_cards SET total_reviews = total_reviews + 1 WHERE id = $1', [elsewhere]);

    const out = new Map<string, any>();
    for (const step of s.steps) {
      const typed = step.leitner_card_id === wrong ? { user_answer: '' } : step.leitner_card_id === right ? { user_answer: VI_OK } : { correct: true };
      const res = await api(p).post('/session/answer', { session_id: s.session_id, step_index: step.step_index, ...typed });
      expect(res.status).toBe(200);
      out.set(step.leitner_card_id, res.body.data.word);
    }
    expect(out.get(right)).toMatchObject({ result: 'advance', new_box_number: 3, applied: true });
    expect(out.get(wrong)).toMatchObject({ result: 'reset', new_box_number: 1, applied: true });
    expect(out.get(elsewhere)).toMatchObject({ result: 'advance', applied: false, new_box_number: null });
    expect((await cardRow(right)).box_number).toBe(3);
    expect((await cardRow(wrong)).box_number).toBe(1);
    expect((await cardRow(elsewhere)).box_number).toBe(2);
  });
});
