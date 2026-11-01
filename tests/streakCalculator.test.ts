/**
 * The streak is computed by the database (a "gaps and islands" query) instead of in Node. These tests keep it identical to the algorithm
 * it replaced — the reference below is that old code — on random sets of active days, and cover updateStreak / recordActivity,
 * which now do the calculation, the write and the "previous value" read in ONE statement. Real PostgreSQL, one throw-away user per case.
 */
import pool from '../config/db';
import * as authCache from '../utils/authUserCache';
import { calculateStreak, loadStreakSummary, recordActivity, updateStreak, utcToday } from '../utils/streakCalculator';

jest.setTimeout(120_000);

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const DAY_MS = 24 * 60 * 60 * 1000;
let counter = 0;
const userIds: string[] = [];

async function newUser(extra: { streak_current?: number; streak_longest?: number } = {}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, level, streak_current, streak_longest)
     VALUES ($1, 'x', 'Streak Test', 'beginner', $2, $3) RETURNING id`,
    [`test-streak-${RUN}-${counter++}@example.com`, extra.streak_current ?? 0, extra.streak_longest ?? 0]
  );
  userIds.push(rows[0].id);
  return rows[0].id;
}

/** One activity row at noon UTC on each of today-offset days. */
async function addDays(userId: string, offsets: number[]): Promise<void> {
  const today = Date.parse(utcToday() + 'T00:00:00Z');
  const days = offsets.map((o) => new Date(today - o * DAY_MS).toISOString().slice(0, 10));
  await pool.query(
    `INSERT INTO user_activity_log (user_id, action, details, created_at)
     SELECT $1, 'flashcard', '{}'::jsonb, (d::date + TIME '12:00') AT TIME ZONE 'UTC' FROM unnest($2::text[]) AS d`,
    [userId, days]
  );
}

/** The algorithm calculateStreak used before: every active day into Node, then count there. */
function reference(offsets: number[]): { current: number; longest: number } {
  const todayUtc = Math.floor(Date.parse(utcToday() + 'T00:00:00Z') / DAY_MS) * DAY_MS;
  const dates = [...new Set(offsets)].map((o) => todayUtc - o * DAY_MS).sort((a, b) => b - a);
  if (dates.length === 0) return { current: 0, longest: 0 };

  let current = 0;
  let cursor = todayUtc;
  for (const ts of dates) {
    if (ts === cursor) {
      current++;
      cursor -= DAY_MS;
    } else if (ts < cursor) {
      break;
    }
  }
  const asc = dates.slice().reverse();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < asc.length; i++) {
    if (asc[i] - asc[i - 1] === DAY_MS) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }
  return { current, longest };
}

afterAll(async () => {
  if (userIds.length > 0) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]); // activity and notifications cascade
  await pool.end();
});

describe('calculateStreak', () => {
  it.each([
    ['no activity at all', []],
    ['today only', [0]],
    ['today and the two days before', [0, 1, 2]],
    ['a gap in the middle', [0, 1, 3, 4, 5, 6]],
    ['yesterday but not today', [1, 2, 3]],
    ['a long run long ago', [10, 11, 12, 13, 14, 15]],
    ['today, then separate runs', [0, 2, 3, 4, 8, 9]],
    ['the same day logged several times', [0, 0, 1, 1, 1]],
  ])('%s', async (_name, offsets) => {
    const userId = await newUser();
    if (offsets.length > 0) await addDays(userId, offsets);
    expect(await calculateStreak(userId)).toEqual(reference(offsets));
  });

  it('agrees with the old algorithm on 25 random sets of active days', async () => {
    let seed = 20261031;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 25; i++) {
      const offsets: number[] = [];
      const size = next() % 14;
      for (let j = 0; j < size; j++) offsets.push(next() % 25);
      const userId = await newUser();
      if (offsets.length > 0) await addDays(userId, offsets);
      expect({ case: offsets, ...(await calculateStreak(userId)) }).toEqual({ case: offsets, ...reference(offsets) });
    }
  });
});

describe('loadStreakSummary', () => {
  it('returns the active days of the requested window, oldest first, from the same statement', async () => {
    const userId = await newUser();
    await addDays(userId, [0, 2, 3, 9]);
    const today = utcToday();
    const from = new Date(Date.parse(today + 'T00:00:00Z') - 6 * DAY_MS).toISOString().slice(0, 10);

    const summary = await loadStreakSummary(userId, { today, recentFrom: from, recentTo: today });
    const day = (o: number) => new Date(Date.parse(today + 'T00:00:00Z') - o * DAY_MS).toISOString().slice(0, 10);
    expect(summary.recentDays).toEqual([day(3), day(2), day(0)]); // 9 days ago is outside the window
    expect({ current: summary.current, longest: summary.longest }).toEqual(reference([0, 2, 3, 9]));
  });

  it('has no recent days when no window is asked for', async () => {
    const userId = await newUser();
    await addDays(userId, [0]);
    expect((await loadStreakSummary(userId)).recentDays).toEqual([]);
  });
});

describe('updateStreak', () => {
  it('writes the streak, keeps the longest it has ever been, and sets last_active_at', async () => {
    const userId = await newUser({ streak_current: 0, streak_longest: 40 }); // a past record of 40 days
    await addDays(userId, [0, 1, 2]);
    await updateStreak(userId);
    const { rows } = await pool.query('SELECT streak_current, streak_longest, last_active_at FROM users WHERE id = $1', [userId]);
    expect(rows[0].streak_current).toBe(3);
    expect(rows[0].streak_longest).toBe(40); // GREATEST(stored, calculated)
    expect(rows[0].last_active_at).not.toBeNull();
  });

  it('announces a 7-day streak once: the old value is the baseline, so a second call the same day says nothing', async () => {
    const userId = await newUser({ streak_current: 6 });
    await addDays(userId, [0, 1, 2, 3, 4, 5, 6]);
    await updateStreak(userId);
    await updateStreak(userId);
    await new Promise((r) => setTimeout(r, 1500)); // the notification is written after the call returns
    const { rows } = await pool.query(`SELECT title FROM user_notifications WHERE user_id = $1 AND type = 'achievement_unlocked'`, [userId]);
    expect(rows.map((r) => r.title)).toEqual(['Streak 7 ngày!']);
  });

  it('does nothing, without failing, for a user that does not exist', async () => {
    await expect(updateStreak('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
  });
});

describe('recordActivity', () => {
  it('logs the line and counts it in the streak in one statement', async () => {
    const userId = await newUser();
    await recordActivity(userId, 'game', { game_type: 'anagram', score: 10 });

    const log = await pool.query('SELECT action, details FROM user_activity_log WHERE user_id = $1', [userId]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].action).toBe('game');
    expect(log.rows[0].details).toEqual({ game_type: 'anagram', score: 10 });

    const { rows } = await pool.query('SELECT streak_current, streak_longest FROM users WHERE id = $1', [userId]);
    expect(rows[0]).toMatchObject({ streak_current: 1, streak_longest: 1 }); // today counts although the row was written by the same statement
  });

  it('extends yesterday\'s run to two days', async () => {
    const userId = await newUser();
    await addDays(userId, [1]);
    await recordActivity(userId, 'practice_session', { session_id: 'x' });
    const { rows } = await pool.query('SELECT streak_current, streak_longest FROM users WHERE id = $1', [userId]);
    expect(rows[0]).toMatchObject({ streak_current: 2, streak_longest: 2 });
  });

  it('writes nothing when the user does not exist (the foreign key refuses the line)', async () => {
    await expect(recordActivity('00000000-0000-4000-8000-000000000000', 'game', {})).rejects.toBeDefined();
  });
});

/**
 * A streak write drops the cached req.user (utils/authUserCache.ts) — only when the streak itself changed. A second activity on the
 * same day writes the same numbers; dropping the cache for it made the next request of the app read the unchanged row again.
 */
describe('the cached req.user after a streak write', () => {
  let invalidate: jest.SpyInstance;
  beforeEach(() => {
    invalidate = jest.spyOn(authCache, 'invalidateAuthUser');
  });
  afterEach(() => {
    invalidate.mockRestore();
  });

  it('is dropped when the current streak changes', async () => {
    const userId = await newUser(); // streak 0, no activity yet
    await recordActivity(userId, 'game', {});
    expect(invalidate).toHaveBeenCalledWith(userId);
  });

  it('is kept when another activity of the same day leaves the streak as it was', async () => {
    const userId = await newUser();
    await recordActivity(userId, 'game', {}); // 0 → 1
    invalidate.mockClear();

    await recordActivity(userId, 'practice_session', {}); // still day 1 of 1
    await updateStreak(userId);
    expect(invalidate).not.toHaveBeenCalled();
    const { rows } = await pool.query('SELECT streak_current, streak_longest FROM users WHERE id = $1', [userId]);
    expect(rows[0]).toMatchObject({ streak_current: 1, streak_longest: 1 });
  });

  it('is dropped when only the longest streak changes (a past run longer than the record)', async () => {
    const userId = await newUser({ streak_current: 0, streak_longest: 1 });
    await addDays(userId, [5, 6, 7]); // three days in a row, not ending today: current stays 0, the record becomes 3
    await updateStreak(userId);
    expect(invalidate).toHaveBeenCalledWith(userId);
    const { rows } = await pool.query('SELECT streak_current, streak_longest FROM users WHERE id = $1', [userId]);
    expect(rows[0]).toMatchObject({ streak_current: 0, streak_longest: 3 });
  });

  it('is dropped when the streak falls back to 0 (yesterday was the last day)', async () => {
    const userId = await newUser({ streak_current: 4, streak_longest: 4 });
    await addDays(userId, [1, 2, 3, 4]);
    await updateStreak(userId);
    expect(invalidate).toHaveBeenCalledWith(userId);
    expect((await pool.query('SELECT streak_current FROM users WHERE id = $1', [userId])).rows[0].streak_current).toBe(0);
  });

  it('is dropped for a user that does not exist (nothing to compare, nothing to trust)', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    await updateStreak(ghost);
    expect(invalidate).toHaveBeenCalledWith(ghost);
  });
});
