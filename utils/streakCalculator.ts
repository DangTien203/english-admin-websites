import pool from '../config/db';
import { fireNotification } from '../services/notificationService';
import { invalidateAuthUser } from './authUserCache';

const STREAK_MILESTONES = [7, 30, 100] as const;

export interface StreakResult {
  current: number;
  longest: number;
}

export interface StreakSummary extends StreakResult {
  /** 'YYYY-MM-DD' (UTC) days inside the requested window that have activity, oldest first (empty when no window was asked for) */
  recentDays: string[];
}

/** Today's date in UTC as 'YYYY-MM-DD' (the application clock, as the streak has always been counted). */
export const utcToday = (now: number = Date.now()): string => new Date(now).toISOString().slice(0, 10);

/**
 * The streak, computed by the database from the DISTINCT UTC days in user_activity_log (a "gaps and islands" query): consecutive days
 * share the same `day - row_number`, so each run of days is one group.
 *   current = length of the run that ends TODAY — 0 when today has no activity, exactly as before;
 *   longest = length of the longest run ever.
 * It used to fetch EVERY active day of the user into Node and count there; now two numbers come back. The result is the same
 * (checked against the old code on real users and on synthetic day sets).
 *
 * `extraCtes` are CTEs that come first in the WITH list (recordActivity puts its INSERT there); `daysSql` is where the days come from
 * and `todaySql` what "today" is.
 */
function streakCte(daysSql: string, todaySql: string, extraCtes = ''): string {
  return `
  WITH ${extraCtes}days AS (
    ${daysSql}
  ), runs AS (
    SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::int AS grp FROM days
  ), agg AS (
    SELECT MAX(d) AS end_d, COUNT(*)::int AS len FROM runs GROUP BY grp
  ), calc AS (
    SELECT COALESCE(MAX(len), 0)::int                                      AS longest,
           COALESCE(MAX(len) FILTER (WHERE end_d = ${todaySql}), 0)::int   AS current
      FROM agg
  )`;
}

const ACTIVE_DAYS_SQL = `SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date AS d FROM user_activity_log WHERE user_id = $1`;

/**
 * The streak (and, when a window is given, the active days inside [recentFrom, recentTo]) in one statement:
 * the home dashboard gets its 7-day strip from the same rows (it used to be a second query over them).
 */
export async function loadStreakSummary(
  userId: string,
  opts: { today?: string; recentFrom?: string; recentTo?: string } = {}
): Promise<StreakSummary> {
  const { rows } = await pool.query<{ current: number; longest: number; recent_days: string[] | null }>(
    `${streakCte(ACTIVE_DAYS_SQL, '$2::date')}
     SELECT calc.current, calc.longest,
            (SELECT COALESCE(ARRAY_AGG(TO_CHAR(d, 'YYYY-MM-DD') ORDER BY d), '{}')
               FROM days WHERE d >= $3::date AND d <= $4::date) AS recent_days
       FROM calc`,
    [userId, opts.today ?? utcToday(), opts.recentFrom ?? null, opts.recentTo ?? null]
  );
  const r = rows[0];
  return { current: r?.current ?? 0, longest: r?.longest ?? 0, recentDays: r?.recent_days ?? [] };
}

/**
 * Tính streak_current + streak_longest cho 1 user dựa trên DISTINCT ngày
 * trong user_activity_log. Current = số ngày liên tiếp tính ngược từ HÔM NAY.
 */
export async function calculateStreak(userId: string): Promise<StreakResult> {
  const { current, longest } = await loadStreakSummary(userId);
  return { current, longest };
}

/**
 * The statements of updateStreak / recordActivity end the same way: persist the streak, read the old values (the sub-selects see the
 * row as it was before this statement), answer.
 */
const PERSIST_STREAK_SQL = `
  UPDATE users u
     SET streak_current = calc.current,
         streak_longest = GREATEST(COALESCE(u.streak_longest, 0), calc.longest),
         last_active_at = NOW()
    FROM calc
   WHERE u.id = $1
RETURNING calc.current AS current,
          u.streak_longest AS longest,
          (SELECT streak_current FROM users WHERE id = $1) AS previous,
          (SELECT streak_longest FROM users WHERE id = $1) AS previous_longest`;

interface StreakWriteRow {
  current: number;
  longest: number;
  previous: number | null;
  previous_longest: number | null;
}

/**
 * What follows every streak write: forget the cached req.user (utils/authUserCache.ts) — but only when the streak itself changed. A
 * second activity on the same day writes the same numbers, and dropping the cache for it made the NEXT request of the app pay a
 * round trip to read the unchanged row again. last_active_at, the other column written, is not part of req.user.
 */
function afterStreakWrite(userId: string, rows: StreakWriteRow[]): void {
  const row = rows[0];
  const changed =
    !row ||
    row.previous === null ||
    row.previous_longest === null ||
    Number(row.current) !== Number(row.previous) ||
    Number(row.longest) !== Number(row.previous_longest);
  if (changed) invalidateAuthUser(userId);
  announceMilestones(userId, rows);
}

/**
 * Fires an `achievement_unlocked` notification when the new `streak_current` crossed a milestone (7/30/100) that was not crossed
 * before. The row's old `streak_current` is the "previous" baseline, so repeated calls within the same day do NOT re-emit.
 */
function announceMilestones(userId: string, rows: StreakWriteRow[]): void {
  if (rows.length === 0) return;
  const current = Number(rows[0].current);
  const previous = Number(rows[0].previous ?? 0);

  for (const milestone of STREAK_MILESTONES) {
    if (previous < milestone && current >= milestone) {
      fireNotification({
        userId,
        type: 'achievement_unlocked',
        title: `Streak ${milestone} ngày!`,
        message: `Bạn đã học liên tục ${milestone} ngày. Tiếp tục giữ phong độ nhé!`,
        linkUrl: '/profile/achievements',
      });
    }
  }
}

/**
 * Recalculate + persist streak vào bảng users + cập nhật last_active_at.
 * Dùng từ trackActivity middleware; an toàn khi gọi sai (best-effort).
 *
 * One statement: the streak is calculated, written, and the previous value is read in the same snapshot
 * (it used to be three round trips: calculate, read the old value, update).
 */
export async function updateStreak(userId: string): Promise<void> {
  const { rows } = await pool.query<StreakWriteRow>(
    `${streakCte(ACTIVE_DAYS_SQL, '$2::date')}
     ${PERSIST_STREAK_SQL}`,
    [userId, utcToday()]
  );
  afterStreakWrite(userId, rows);
}

/**
 * Logs one line in user_activity_log AND refreshes the streak, in ONE statement (the two used to be an INSERT followed by updateStreak,
 * two round trips). Rows written by a data-modifying CTE are not visible to the other CTEs of the same statement, so the day of the
 * line is added to the day list by hand; "today" is the database's own UTC date for both, so the two cannot disagree around midnight.
 */
export async function recordActivity(userId: string, action: string, details: unknown): Promise<void> {
  const { rows } = await pool.query<StreakWriteRow>(
    `${streakCte(
      `${ACTIVE_DAYS_SQL} UNION SELECT (NOW() AT TIME ZONE 'UTC')::date`,
      `(NOW() AT TIME ZONE 'UTC')::date`,
      `act AS (INSERT INTO user_activity_log (user_id, action, details) VALUES ($1, $2, $3) RETURNING 1), `
    )}
     ${PERSIST_STREAK_SQL}`,
    [userId, action, typeof details === 'string' ? details : JSON.stringify(details ?? {})]
  );
  afterStreakWrite(userId, rows);
}
