/**
 * GET /api/v1/profile/stats answered 500 ("column ucp.leitner_box does not exist": the column was dropped when the Leitner boxes moved
 * to leitner_cards) and nothing noticed, because nothing tested it. "Words learned" now counts the words in Leitner box 4 or 5.
 */
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser, type RegisteredUser } from './helpers/auth';
import { RUN, cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(120_000);

let user: RegisteredUser;
const entries: string[] = [];

beforeAll(async () => {
  user = await registerUser('pstats');
  for (const tag of ['ps1', 'ps2', 'ps3']) entries.push(await createEntry({ tag }));
});

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE email = $1', [user.email]);
  await cleanup();
  await pool.end();
});

const stats = () => request(app).get('/api/v1/profile/stats').set('Authorization', `Bearer ${user.accessToken}`);

describe('GET /api/v1/profile/stats', () => {
  it('answers 200 for a user with no history, with the whole shape', async () => {
    const res = await stats();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      streak_current: 0,
      streak_longest: 0,
      total_reviews: 0,
      correct_rate: 0,
      total_study_time_minutes: 0,
      total_words_learned: 0,
    });
    expect(res.body.data.last_30_days_activity).toHaveLength(30);
    expect(res.body.data.last_30_days_activity[0]).toMatchObject({ review_count: 0, minutes_studied: 0 });
  });

  it('counts the words in Leitner box 4 and 5 as learned, and the study time of the activity log', async () => {
    await pool.query(
      `INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at, source, added_from_mode)
       VALUES ($1, $2, 3, NOW(), 'practice', 'test'), ($1, $3, 4, NOW(), 'practice', 'test'), ($1, $4, 5, NOW(), 'practice', 'test')`,
      [user.userId, entries[0], entries[1], entries[2]]
    );
    await pool.query(`INSERT INTO user_activity_log (user_id, action, details, duration_sec) VALUES ($1, 'flashcard', '{}'::jsonb, 600)`, [user.userId]);

    const res = await stats();
    expect(res.status).toBe(200);
    expect(res.body.data.total_words_learned).toBe(2);
    expect(res.body.data.total_study_time_minutes).toBe(10);
    const today = res.body.data.last_30_days_activity.at(-1);
    expect(today.minutes_studied).toBe(10);
  });

  it(`uses the streak the user row carries (run ${RUN})`, async () => {
    await pool.query('UPDATE users SET streak_current = 4, streak_longest = 9 WHERE id = $1', [user.userId]);
    const res = await stats();
    expect(res.body.data).toMatchObject({ streak_current: 4, streak_longest: 9 });
  });
});
