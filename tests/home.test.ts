import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser } from './helpers/auth';

const SUFFIX = `home-${Date.now()}`;

let user: { userId: string; accessToken: string; email: string };

beforeAll(async () => {
  user = await registerUser(SUFFIX);
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`test-${SUFFIX}%`]);
  await pool.end();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('GET /api/v1/home/dashboard', () => {
  it('returns all 9 sections with snake_case keys', async () => {
    // Seed a notification so notification_unread_count > 0 path exercises.
    await pool.query(
      `INSERT INTO user_notifications (user_id, type, title)
       VALUES ($1, 'system_update', 'Hello')`,
      [user.userId],
    );

    const res = await request(app)
      .get('/api/v1/home/dashboard')
      .set(auth(user.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const d = res.body.data;
    // Section 1: user
    expect(d.user).toBeDefined();
    expect(d.user.id).toBe(user.userId);
    expect(d.user).toHaveProperty('full_name');
    expect(d.user).toHaveProperty('avatar_url');
    expect(d.user).toHaveProperty('level');
    expect(d.user).toHaveProperty('subscription_badge');

    // Section 2: streak
    expect(d.streak).toBeDefined();
    expect(d.streak).toHaveProperty('current');
    expect(d.streak).toHaveProperty('longest');
    expect(Array.isArray(d.streak.last_7_days)).toBe(true);
    expect(d.streak.last_7_days.length).toBe(7);
    expect(d.streak.last_7_days[0]).toHaveProperty('date');
    expect(d.streak.last_7_days[0]).toHaveProperty('had_activity');

    // Section 3: due_review
    expect(d.due_review).toBeDefined();
    expect(d.due_review).toHaveProperty('total_cards');
    expect(d.due_review).toHaveProperty('practice_due_cards');
    expect(d.due_review).toHaveProperty('estimated_minutes');

    // Section 4: continue_decks
    expect(Array.isArray(d.continue_decks)).toBe(true);

    // Section 5: word_of_the_day
    expect(d.word_of_the_day).toBeDefined();
    expect(d.word_of_the_day).toHaveProperty('entry');

    // Section 6: recent_activity
    expect(Array.isArray(d.recent_activity)).toBe(true);

    // Section 7: reading_progress
    expect(d.reading_progress).toBeDefined();
    expect(d.reading_progress).toHaveProperty('current_book');
    expect(d.reading_progress).toHaveProperty('total_books_reading');

    // Section 8: game_stats
    expect(d.game_stats).toBeDefined();
    expect(d.game_stats).toHaveProperty('last_played');
    expect(d.game_stats).toHaveProperty('weekly_rank');

    // Section 9: notification_unread_count
    expect(d.notification_unread_count).toBeGreaterThanOrEqual(1);
  });

  it('handles a fresh user (no decks/games/ebooks) without erroring', async () => {
    // Exercises the empty-data branches; perf is asserted manually rather than
    // in automated tests because CI timing is too noisy for a hard ceiling.
    const fresh = await registerUser(`${SUFFIX}-perf`);
    const res = await request(app)
      .get('/api/v1/home/dashboard')
      .set(auth(fresh.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.continue_decks).toEqual([]);
    expect(res.body.data.reading_progress.current_book).toBeNull();
    expect(res.body.data.game_stats.last_played).toBeNull();
  });

  it('without auth → 401 NO_TOKEN', async () => {
    const res = await request(app).get('/api/v1/home/dashboard');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NO_TOKEN');
  });

  it('streak.current is computed fresh, not the stale users.streak_current value', async () => {
    // Regression: trackActivity middleware only fires on study endpoints,
    // so users.streak_current can hold a value from weeks ago. Dashboard must
    // recompute from user_activity_log so the number matches last_7_days.
    const stale = await registerUser(`${SUFFIX}-stale`);

    // Forge a stale "30-day streak" with no actual activity rows.
    await pool.query(
      `UPDATE users SET streak_current = 30, streak_longest = 30 WHERE id = $1`,
      [stale.userId],
    );

    const res = await request(app)
      .get('/api/v1/home/dashboard')
      .set(auth(stale.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.streak.current).toBe(0);
    // last_7_days must agree — no had_activity:true anywhere.
    expect(
      res.body.data.streak.last_7_days.every((d: any) => d.had_activity === false),
    ).toBe(true);
  });

  it('streak.current counts today when activity exists today', async () => {
    const active = await registerUser(`${SUFFIX}-active`);
    await pool.query(
      `INSERT INTO user_activity_log (user_id, action) VALUES ($1, 'flashcard')`,
      [active.userId],
    );
    const res = await request(app)
      .get('/api/v1/home/dashboard')
      .set(auth(active.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.streak.current).toBe(1);
  });
});

describe('GET /api/v1/home/word-of-the-day', () => {
  it('is public (no auth) and returns the same word across calls on the same day', async () => {
    const a = await request(app).get('/api/v1/home/word-of-the-day');
    const b = await request(app).get('/api/v1/home/word-of-the-day');

    // Skip the assertion gracefully if the dictionary is empty in this env.
    if (a.status === 404) {
      expect(a.body.error.code).toBe('NO_ENTRIES');
      return;
    }

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data.entry).toBeTruthy();
    expect(a.body.data.entry.id).toBe(b.body.data.entry.id);
    expect(a.body.data.date).toBe(b.body.data.date);
  });

  it('dashboard.word_of_the_day matches the public endpoint id for today', async () => {
    const dash = await request(app)
      .get('/api/v1/home/dashboard')
      .set(auth(user.accessToken));
    const pub = await request(app).get('/api/v1/home/word-of-the-day');
    if (pub.status === 404) return;

    expect(dash.status).toBe(200);
    if (dash.body.data.word_of_the_day.entry && pub.body.data.entry) {
      expect(dash.body.data.word_of_the_day.entry.id).toBe(pub.body.data.entry.id);
    }
  });
});
