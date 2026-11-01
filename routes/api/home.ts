import { Router, Response, Request } from 'express';
import NodeCache from 'node-cache';
import pool from '../../config/db';
import { ApiRequest, requireApiAuth, optionalApiAuth } from '../../middlewares/apiAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { apiSuccess, apiError } from '../../utils/apiResponse';
import { computeSubscriptionBadge } from '../../utils/subscriptionHelper';
import { FULL_ENTRY_SQL } from '../../utils/entryQueries';
import { loadStreakSummary } from '../../utils/streakCalculator';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
//  Caches
//  - dashboard: per-user 30s. Aggregating the sections is the hot path.
//  - wod:       global 24h, keyed by date (YYYY-MM-DD UTC).
// ─────────────────────────────────────────────────────────────────────────────
const dashboardCache = new NodeCache({ stdTTL: 30, checkperiod: 10 });
const wodCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 60 * 60 });

const DAY_MS = 24 * 60 * 60 * 1000;

const todayUtcKey = (): { key: string; midnightMs: number } => {
  const midnightMs = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return { key: new Date(midnightMs).toISOString().slice(0, 10), midnightMs };
};

// Three counters and the last finished game with the player's weekly rank, in ONE statement (they were five, the rank one of them
// only after the last game was known). `played_at` stays a timestamptz column so it reaches the client in the same format as before.
const SUMMARY_SQL = `
  WITH last_game AS (
    SELECT game_type, score, created_at AS played_at
      FROM game_runs
     WHERE user_id = $1 AND completed = TRUE
     ORDER BY created_at DESC
     LIMIT 1
  )
  SELECT (SELECT COUNT(*)::int FROM leitner_cards WHERE user_id = $1 AND due_at <= NOW())          AS leitner_due,
         (SELECT COUNT(*)::int FROM practice_sessions WHERE user_id = $1 AND completed_at IS NULL) AS practice_due,
         (SELECT COUNT(*)::int FROM user_notifications WHERE user_id = $1 AND is_read = FALSE)     AS unread_count,
         lg.game_type, lg.score, lg.played_at,
         (SELECT r.rank
            FROM (SELECT user_id, RANK() OVER (ORDER BY MAX(score) DESC)::int AS rank
                    FROM game_runs
                   WHERE game_type = lg.game_type AND completed = TRUE
                     AND created_at >= NOW() - INTERVAL '7 days'
                   GROUP BY user_id) r
           WHERE r.user_id = $1
           LIMIT 1) AS weekly_rank
    FROM (SELECT 1) one
    LEFT JOIN last_game lg ON TRUE`;

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/home/dashboard  (auth)
//  Aggregates the sections in parallel + per-user 30s cache for sub-500ms p95.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/dashboard',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const user = req.user!;
    const userId = user.id;
    const cacheKey = `dash:${userId}`;
    const cached = dashboardCache.get<object>(cacheKey);
    if (cached) {
      return apiSuccess(res, cached);
    }

    const { key: todayKey, midnightMs } = todayUtcKey();
    const sevenStartKey = new Date(midnightMs - 6 * DAY_MS).toISOString().slice(0, 10);

    // Fan out: 5 independent statements + the (cached) badge and WOD, all at once. The user's own row is req.user (auth loaded it).
    //
    // Streak is computed live (not read from users.streak_current) because
    // that column only gets refreshed via trackActivity on study endpoints
    // (flashcard/review/game/lookup). A user who only opens the home tab
    // would otherwise see a value frozen at their last study session — even
    // if that was weeks ago — while last_7_days correctly shows the gaps.
    // The same statement returns the active days of the last 7 (it used to be a second query over the same rows).
    const [badge, streakLive, summaryR, decksR, activityR, readingR, wodEntry] = await Promise.all([
      computeSubscriptionBadge(userId),
      loadStreakSummary(userId, { today: todayKey, recentFrom: sevenStartKey, recentTo: todayKey }),
      pool.query(SUMMARY_SQL, [userId]),
      // Continue learning: top 5 decks favorited or owned by this user, with progress.
      pool.query(
        `SELECT
           d.id              AS deck_id,
           d.title,
           d.thumbnail_url,
           (SELECT COUNT(*)::int FROM cards WHERE deck_id = d.id) AS total_cards,
           (SELECT COUNT(*)::int FROM cards c
              JOIN leitner_cards lc ON lc.entry_id = c.entry_id AND lc.user_id = $1
             WHERE c.deck_id = d.id AND lc.due_at <= NOW()) AS due_cards,
           (SELECT COUNT(*)::int FROM cards c
              JOIN leitner_cards lc ON lc.entry_id = c.entry_id AND lc.user_id = $1
             WHERE c.deck_id = d.id AND lc.box_number >= 5) AS mastered_count
         FROM decks d
         WHERE d.user_id = $1
            OR d.id IN (SELECT deck_id FROM user_deck_favorites WHERE user_id = $1)
         ORDER BY d.created_at DESC
         LIMIT 5`,
        [userId],
      ),
      pool.query(
        `SELECT action, details, created_at
           FROM user_activity_log
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 5`,
        [userId],
      ),
      pool.query(
        `SELECT e.id AS ebook_id, e.title, e.cover_url, urp.progress
           FROM user_reading_progress urp
           JOIN ebooks e ON e.id = urp.ebook_id
          WHERE urp.user_id = $1 AND urp.progress > 0 AND urp.progress < 1
          ORDER BY urp.last_read_at DESC NULLS LAST
          LIMIT 1`,
        [userId],
      ),
      getWordOfTheDay(todayKey, /* fullDetail */ false),
    ]);

    // 7-day activity strip (ordered oldest → today).
    const activeDays = new Set(streakLive.recentDays);
    const lastSevenDays: { date: string; had_activity: boolean }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(midnightMs - i * DAY_MS).toISOString().slice(0, 10);
      lastSevenDays.push({ date: d, had_activity: activeDays.has(d) });
    }

    const summary = summaryR.rows[0] ?? {};
    const leitnerDue = summary.leitner_due ?? 0;
    const practiceDue = summary.practice_due ?? 0;
    const totalDueCards = leitnerDue + practiceDue;
    // Heuristic: ~20s per due card, floor at 1 minute when there's anything to review.
    const estimatedMinutes = totalDueCards === 0 ? 0 : Math.max(1, Math.ceil(totalDueCards / 3));

    const continueDecks = decksR.rows.map((r: any) => ({
      deck_id: r.deck_id,
      title: r.title,
      thumbnail_url: r.thumbnail_url ?? null,
      progress:
        r.total_cards > 0
          ? +Math.min(1, (r.mastered_count ?? 0) / r.total_cards).toFixed(3)
          : 0,
      total_cards: r.total_cards ?? 0,
      due_cards: r.due_cards ?? 0,
    }));

    const currentBookRow = readingR.rows[0];
    const currentBook = currentBookRow
      ? {
          ebook_id: currentBookRow.ebook_id,
          title: currentBookRow.title,
          cover_url: currentBookRow.cover_url ?? null,
          progress: Number(currentBookRow.progress) || 0,
        }
      : null;

    const lastPlayed = summary.game_type
      ? {
          game_type: summary.game_type,
          score: summary.score,
          played_at: summary.played_at,
        }
      : null;

    // Weekly rank only exists when there is a last game to rank in.
    const weeklyRank: { game_type: string; rank: number } | null =
      lastPlayed && summary.weekly_rank
        ? { game_type: lastPlayed.game_type, rank: summary.weekly_rank }
        : null;

    const dashboard = {
      user: {
        id: user.id,
        full_name: user.full_name ?? null,
        avatar_url: user.avatar_url ?? null,
        level: user.level,
        subscription_badge: badge,
      },
      streak: {
        current: streakLive.current,
        // Stored longest is monotonic — keep whichever is greater so a
        // historical peak isn't lost if user_activity_log was ever pruned.
        longest: Math.max(streakLive.longest, Number(user.streak_longest ?? 0)),
        last_7_days: lastSevenDays,
      },
      due_review: {
        total_cards: totalDueCards,
        practice_due_cards: practiceDue,
        estimated_minutes: estimatedMinutes,
      },
      continue_decks: continueDecks,
      word_of_the_day: { entry: wodEntry ? slimEntry(wodEntry) : null },
      recent_activity: activityR.rows.map((r: any) => ({
        action: r.action,
        details: r.details ?? {},
        created_at: r.created_at,
      })),
      reading_progress: {
        current_book: currentBook,
        total_books_reading: currentBook ? 1 : 0,
      },
      game_stats: {
        last_played: lastPlayed,
        weekly_rank: weeklyRank,
      },
      notification_unread_count: summary.unread_count ?? 0,
    };

    dashboardCache.set(cacheKey, dashboard);
    return apiSuccess(res, dashboard);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/home/word-of-the-day  (public)
//  Same word for all users on a given date. 24h cache.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/word-of-the-day',
  optionalApiAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const { key: todayKey } = todayUtcKey();
    const entry = await getWordOfTheDay(todayKey, /* fullDetail */ true);
    if (!entry) {
      return apiError(res, 404, 'NO_ENTRIES', 'Chưa có từ điển để chọn');
    }
    return apiSuccess(res, { date: todayKey, entry });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick a single dictionary entry deterministically from the date string.
 * Hash(date) % count → stable offset into the published, frequency-ranked pool.
 *
 * `fullDetail` controls projection:
 *   - false: SELECT * → basic columns; cheap and enough for the dashboard card.
 *   - true:  FULL_ENTRY_SQL → senses[], word_forms[], etc. for the public endpoint.
 *
 * Both projections share the same hashed offset, so dashboard.entry.id and
 * /word-of-the-day.entry.id always match for a given date.
 */
async function getWordOfTheDay(
  dateKey: string,
  fullDetail: boolean,
): Promise<any | null> {
  const cacheKey = `wod:${fullDetail ? 'full' : 'slim'}:${dateKey}`;
  const cached = wodCache.get<any>(cacheKey);
  if (cached) return cached;

  // FNV-1a 32-bit hash — deterministic, no crypto needed.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }

  // Restrict to common, published vocabulary so the WOD is appropriate.
  const { rows: cntRows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM dictionary_entries
      WHERE published = TRUE
        AND frequency_rank IS NOT NULL
        AND frequency_rank <= 5000`,
  );
  let total = cntRows[0]?.count ?? 0;
  let usePool = true;

  // Fallback: relax filter if no high-frequency pool seeded yet.
  if (total === 0) {
    const { rows: fbRows } = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM dictionary_entries WHERE published = TRUE`,
    );
    total = fbRows[0]?.count ?? 0;
    usePool = false;
    if (total === 0) return null;
  }

  const offset = h % total;

  let entry: any;
  if (fullDetail) {
    // FULL_ENTRY_SQL aliases dictionary_entries as `e`.
    const where = usePool
      ? 'e.published = TRUE AND e.frequency_rank IS NOT NULL AND e.frequency_rank <= 5000'
      : 'e.published = TRUE';
    const orderBy = usePool ? 'e.frequency_rank ASC, e.id ASC' : 'e.id ASC';
    const { rows } = await pool.query(
      `${FULL_ENTRY_SQL}
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT 1 OFFSET $1`,
      [offset],
    );
    entry = rows[0] ?? null;
  } else {
    const where = usePool
      ? 'published = TRUE AND frequency_rank IS NOT NULL AND frequency_rank <= 5000'
      : 'published = TRUE';
    const orderBy = usePool ? 'frequency_rank ASC, id ASC' : 'id ASC';
    const { rows } = await pool.query(
      `SELECT id, headword, lemma, ipa_us, ipa_uk, audio_us_url, audio_uk_url,
              pos, cefr_level, frequency_rank, meaning_vi
         FROM dictionary_entries
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT 1 OFFSET $1`,
      [offset],
    );
    entry = rows[0] ?? null;
  }

  if (entry) wodCache.set(cacheKey, entry);
  return entry;
}

/**
 * Project a slim entry shape for the dashboard card. Strips bulky fields and
 * derives a 1-line meaning_preview from meaning_vi.
 */
function slimEntry(row: any) {
  const meaningVi: string | null = row.meaning_vi ?? null;
  let meaningPreview: string | null = null;
  if (meaningVi) {
    const firstLine = meaningVi.split('\n')[0].trim();
    meaningPreview = firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine;
  }
  return {
    id: row.id,
    headword: row.headword,
    lemma: row.lemma ?? null,
    ipa_us: row.ipa_us ?? null,
    ipa_uk: row.ipa_uk ?? null,
    audio_us_url: row.audio_us_url ?? null,
    audio_uk_url: row.audio_uk_url ?? null,
    pos: row.pos ?? [],
    cefr_level: row.cefr_level ?? null,
    frequency_rank: row.frequency_rank ?? null,
    meaning_preview: meaningPreview,
  };
}

export default router;
