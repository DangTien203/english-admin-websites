import { Router, Response } from 'express';
import NodeCache from 'node-cache';
import pool from '../../config/db';
import { ApiRequest, requireApiAuth, optionalApiAuth } from '../../middlewares/apiAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { apiSuccess, apiError } from '../../utils/apiResponse';
import { addBatchToBox1 } from '../../utils/leitnerManager';
import { recordActivity } from '../../utils/streakCalculator';
import { createNotification } from '../../services/notificationService';
import { gameCatalogCache } from '../../utils/gameCatalogCache';

const router = Router();

const leaderboardCache = new NodeCache({ stdTTL: 60, checkperiod: 30 });

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Fisher-Yates shuffle (mutates array, returns it). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Compare user_order (array of entry_ids) against the stored correct ordering.
 * Returns accuracy as a value between 0 and 1 (exact-position match).
 */
function computeLadderAccuracy(userOrder: string[], correctItems: Array<{ entry_id: string; correct_order: number }>): number {
  if (correctItems.length === 0) return 0;
  const sorted = [...correctItems].sort((a, b) => a.correct_order - b.correct_order);
  const correct = sorted.map((i) => i.entry_id);
  let hits = 0;
  for (let i = 0; i < Math.min(userOrder.length, correct.length); i++) {
    if (userOrder[i] === correct[i]) hits++;
  }
  return hits / correct.length;
}

/**
 * Anti-cheat: flag runs that look statistically impossible.
 * Returns an admin note string or null.
 */
function detectCheat(
  gameType: string,
  score: number,
  accuracy: number,
  timeSec: number,
  completed: boolean,
  config: any
): string | null {
  const flags: string[] = [];

  if (timeSec < 3 && completed) {
    flags.push('time_too_short');
  }

  if (accuracy > 1 || accuracy < 0) {
    flags.push('accuracy_out_of_range');
  }

  if (score < 0) {
    flags.push('negative_score');
  }

  if (config) {
    const timeLimit: number | undefined =
      config.time_limit ?? (gameType === 'anagram' ? config.time_per_word * 20 : undefined);
    if (timeLimit && timeSec > timeLimit * 3) {
      flags.push('time_far_exceeds_limit');
    }
  }

  if (completed && accuracy === 1 && timeSec < 5 && score > 500) {
    flags.push('perfect_score_suspicious_speed');
  }

  return flags.length > 0 ? `[anti-cheat] ${flags.join(', ')}` : null;
}

/** Calculate XP based on game result. */
function calcXp(gameType: string, score: number, accuracy: number, completed: boolean): number {
  let base = Math.min(Math.round(score / 10), 150);
  let accuracyBonus = accuracy >= 0.8 ? 15 : accuracy >= 0.5 ? 5 : 0;
  let completionBonus = completed ? 20 : 0;
  return Math.max(0, base + accuracyBonus + completionBonus);
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/games/levels  (public)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/levels',
  optionalApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const { type } = req.query as { type?: string };

    const VALID_TYPES = ['lexisweep', 'anagram', 'ladder'];
    if (type && !VALID_TYPES.includes(type)) {
      return apiError(res, 400, 'VALIDATION_ERROR', `game_type phải là một trong: ${VALID_TYPES.join(', ')}`);
    }

    const params: any[] = [];
    let where = `WHERE status = 'active'`;
    if (type) {
      params.push(type);
      where += ` AND game_type = $${params.length}`;
    }

    const items = await gameCatalogCache.getOrLoad(`levels:${type ?? ''}`, async () => {
      const { rows } = await pool.query(
        `SELECT id, game_type, level_number, config_json
         FROM game_levels
         ${where}
         ORDER BY game_type ASC, level_number ASC`,
        params
      );
      return rows;
    });

    return apiSuccess(res, { items });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/games/word-lists  (public — metadata only)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/word-lists',
  optionalApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const { type, topic, level } = req.query as { type?: string; topic?: string; level?: string };

    const VALID_TYPES = ['lexisweep', 'anagram'];
    if (type && !VALID_TYPES.includes(type)) {
      return apiError(res, 400, 'VALIDATION_ERROR', `game_type phải là: lexisweep hoặc anagram`);
    }

    // Accept numeric level_number (1/2/3) from mobile or string proficiency name
    const LEVEL_MAP: Record<string, string> = { '1': 'beginner', '2': 'intermediate', '3': 'advanced' };
    const VALID_LEVELS = ['beginner', 'intermediate', 'advanced'];
    const normalizedLevel = level ? (LEVEL_MAP[level] ?? level) : undefined;
    if (normalizedLevel && !VALID_LEVELS.includes(normalizedLevel)) {
      return apiError(res, 400, 'VALIDATION_ERROR', `level phải là: beginner/intermediate/advanced hoặc 1/2/3`);
    }

    const params: any[] = [];
    const conds: string[] = [`gwl.status = 'published'`];

    if (type) { params.push(type); conds.push(`gwl.game_type = $${params.length}`); }
    if (topic) { params.push(topic); conds.push(`gwl.topic ILIKE $${params.length}`); }
    if (normalizedLevel) { params.push(normalizedLevel); conds.push(`gwl.level = $${params.length}`); }

    const where = `WHERE ${conds.join(' AND ')}`;

    const items = await gameCatalogCache.getOrLoad(`lists:${JSON.stringify(params)}`, async () => {
      const { rows } = await pool.query(
        `SELECT gwl.id, gwl.game_type, gwl.name, gwl.topic, gwl.level,
                COUNT(gwli.entry_id)::int AS word_count
           FROM game_word_lists gwl
           LEFT JOIN game_word_list_items gwli ON gwli.list_id = gwl.id
           ${where}
           GROUP BY gwl.id
           ORDER BY gwl.game_type ASC, gwl.name ASC`,
        params
      );
      return rows;
    });

    return apiSuccess(res, { items });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/games/word-lists/:id  (auth — full with entries)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/word-lists/:id',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const { id } = req.params;

    const { rows: listRows } = await pool.query(
      `SELECT id, game_type, name, topic, level, status
         FROM game_word_lists
        WHERE id = $1 AND status = 'published'`,
      [id]
    );
    if (!listRows[0]) return apiError(res, 404, 'NOT_FOUND', 'Word list không tồn tại');

    const { rows: items } = await pool.query(
      `SELECT gwli.entry_id, de.headword, de.ipa_us, de.pos,
              COALESCE(
                (SELECT es.definition_vi FROM entry_senses es
                 WHERE es.entry_id = de.id AND es.definition_vi IS NOT NULL
                 ORDER BY es.sense_order ASC LIMIT 1),
                NULLIF(SPLIT_PART(COALESCE(de.meaning_vi, ''), E'\\n', 1), '')
              ) AS meaning_vi
         FROM game_word_list_items gwli
         JOIN dictionary_entries de ON de.id = gwli.entry_id
        WHERE gwli.list_id = $1
        ORDER BY de.headword ASC`,
      [id]
    );

    return apiSuccess(res, { ...listRows[0], items });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/games/semantic-sets  (public)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/semantic-sets',
  optionalApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const { level } = req.query as { level?: string };

    // Accept numeric level_number (1/2/3) from mobile or string proficiency name
    const LEVEL_MAP: Record<string, string> = { '1': 'beginner', '2': 'intermediate', '3': 'advanced' };
    const VALID_LEVELS = ['beginner', 'intermediate', 'advanced'];
    const normalizedLevel = level ? (LEVEL_MAP[level] ?? level) : undefined;
    if (normalizedLevel && !VALID_LEVELS.includes(normalizedLevel)) {
      return apiError(res, 400, 'VALIDATION_ERROR', `level phải là: beginner/intermediate/advanced hoặc 1/2/3`);
    }

    const params: any[] = [];
    if (normalizedLevel) params.push(normalizedLevel);

    const items = await gameCatalogCache.getOrLoad(`sets:${normalizedLevel ?? ''}`, async () => {
      const { rows } = await pool.query(
        `SELECT ss.id, ss.name, ss.scale_description, ss.level,
                COUNT(ssi.id)::int AS item_count
           FROM semantic_sets ss
           LEFT JOIN semantic_set_items ssi ON ssi.set_id = ss.id
           WHERE ss.status = 'published'
           ${normalizedLevel ? `AND ss.level = $1` : ''}
           GROUP BY ss.id
           ORDER BY ss.name ASC`,
        params
      );
      return rows;
    });

    return apiSuccess(res, { items });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/games/semantic-sets/:id  (auth — shuffled, NO correct_order)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/semantic-sets/:id',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const { id } = req.params;

    const { rows: setRows } = await pool.query(
      `SELECT id, name, scale_description, level
         FROM semantic_sets
        WHERE id = $1 AND status = 'published'`,
      [id]
    );
    if (!setRows[0]) return apiError(res, 404, 'NOT_FOUND', 'Semantic set không tồn tại');

    const { rows: items } = await pool.query(
      `SELECT ssi.entry_id, de.headword, ssi.hint_vi
         FROM semantic_set_items ssi
         JOIN dictionary_entries de ON de.id = ssi.entry_id
        WHERE ssi.set_id = $1
        ORDER BY ssi.correct_order ASC`,
      [id]
    );

    // Shuffle server-side — correct_order deliberately excluded from response
    const shuffled = shuffle(items.map((i) => ({
      entry_id: i.entry_id,
      headword: i.headword,
      hint_vi: i.hint_vi,
    })));

    return apiSuccess(res, {
      id: setRows[0].id,
      name: setRows[0].name,
      scale_description: setRows[0].scale_description,
      level: setRows[0].level,
      item_count: items.length,
      items: shuffled,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/games/runs  (auth)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/runs',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const {
      game_type,
      level_id,
      list_id,
      set_id,
      score,
      accuracy: rawAccuracy,
      time_sec,
      completed,
      details,
    } = req.body;

    // ── Basic validation ────────────────────────────────────────────────────
    const VALID_TYPES = ['lexisweep', 'anagram', 'ladder'];
    if (!game_type || !VALID_TYPES.includes(game_type)) {
      return apiError(res, 400, 'VALIDATION_ERROR', `game_type phải là: ${VALID_TYPES.join(', ')}`);
    }
    if (typeof score !== 'number' || score < 0) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'score phải là số không âm');
    }
    if (typeof time_sec !== 'number' || time_sec < 0) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'time_sec phải là số không âm');
    }
    if (typeof completed !== 'boolean') {
      return apiError(res, 400, 'VALIDATION_ERROR', 'completed phải là boolean');
    }

    // ── Game-type-specific validation ───────────────────────────────────────
    if (game_type === 'lexisweep') {
      if (!list_id) return apiError(res, 400, 'VALIDATION_ERROR', 'lexisweep yêu cầu list_id');
      if (!details?.words_found || !Array.isArray(details.words_found)) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'lexisweep yêu cầu details.words_found là array');
      }
    }

    if (game_type === 'anagram') {
      if (!list_id) return apiError(res, 400, 'VALIDATION_ERROR', 'anagram yêu cầu list_id');
      if (typeof details?.anagrams_solved !== 'number') {
        return apiError(res, 400, 'VALIDATION_ERROR', 'anagram yêu cầu details.anagrams_solved là số');
      }
    }

    if (game_type === 'ladder') {
      if (!set_id) return apiError(res, 400, 'VALIDATION_ERROR', 'ladder yêu cầu set_id');
      if (!details?.user_order || !Array.isArray(details.user_order)) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'ladder yêu cầu details.user_order là array entry_ids');
      }
    }

    // ── Load level config for anti-cheat, and (ladder) the set to score against: two independent reads, done together ──
    let finalAccuracy: number = typeof rawAccuracy === 'number'
      ? Math.max(0, Math.min(1, rawAccuracy))
      : 0;
    let setEntryIds: string[] = [];

    const [levelRes, setRes] = await Promise.all([
      level_id
        ? pool.query(`SELECT config_json FROM game_levels WHERE id = $1`, [level_id])
        : Promise.resolve(null),
      game_type === 'ladder'
        ? pool.query(
            `SELECT entry_id, correct_order
               FROM semantic_set_items
              WHERE set_id = $1
              ORDER BY correct_order ASC`,
            [set_id]
          )
        : Promise.resolve(null),
    ]);
    const levelConfig: any = levelRes?.rows[0]?.config_json ?? null;

    // ── Ladder: server-side accuracy computation ────────────────────────────
    if (game_type === 'ladder') {
      if (!set_id) return apiError(res, 400, 'VALIDATION_ERROR', 'ladder yêu cầu set_id');

      const setItems = setRes!.rows;
      if (setItems.length === 0) {
        return apiError(res, 404, 'NOT_FOUND', 'Semantic set không tồn tại hoặc không có items');
      }

      setEntryIds = setItems.map((i: any) => i.entry_id);
      finalAccuracy = computeLadderAccuracy(details.user_order, setItems);
    }

    // ── Anti-cheat ──────────────────────────────────────────────────────────
    const cheatNote = detectCheat(game_type, score, finalAccuracy, time_sec, completed, levelConfig);
    const detailsWithNote = cheatNote
      ? { ...details, admin_note: cheatNote }
      : details;

    // ── Insert game_run ─────────────────────────────────────────────────────
    const { rows: runRows } = await pool.query(
      `INSERT INTO game_runs
         (user_id, game_type, level_id, list_id, set_id,
          score, accuracy, time_sec, completed, details_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        userId, game_type,
        level_id ?? null, list_id ?? null, set_id ?? null,
        score, finalAccuracy, time_sec, completed,
        JSON.stringify(detailsWithNote),
      ]
    );
    const runId: string = runRows[0].id;

    // ── XP & streak (fire-and-forget) ───────────────────────────────────────
    const xpEarned = calcXp(game_type, score, finalAccuracy, completed);

    // Log activity and refresh the streak (non-blocking; one statement, it used to be an insert and then updateStreak)
    recordActivity(userId, 'game', { game_type, run_id: runId, score, accuracy: finalAccuracy, xp_earned: xpEarned })
      .catch(() => {/* best-effort */});

    // ── Leitner integration — Ladder ONLY ──────────────────────────────────
    let leitnerAdded: { added: number; skipped: number } | null = null;

    if (game_type === 'ladder' && completed && finalAccuracy >= 0.8 && setEntryIds.length > 0) {
      leitnerAdded = await addBatchToBox1(userId, setEntryIds, 'ladder_game');
    }

    // ── Rank snapshot (best score leaderboard position) ────────────────────
    // Clear cache so next leaderboard request reflects the new run
    leaderboardCache.flushAll();

    // Fire-and-forget: emit `achievement_unlocked` when this run pushes the
    // user into the monthly top-50. Dedupe against the last 7 days so a user
    // hovering near rank 50 doesn't get spammed on every new best.
    void detectTop50Achievement(userId, game_type).catch((err) =>
      console.error('[games] top50 detection failed:', err),
    );

    const response: Record<string, any> = { run_id: runId, xp_earned: xpEarned };
    if (leitnerAdded !== null) response.leitner_added = leitnerAdded;

    return apiSuccess(res, response);
  })
);

async function detectTop50Achievement(userId: string, gameType: string): Promise<void> {
  const { rows } = await pool.query<{ rank: number }>(
    `WITH ranked AS (
       SELECT user_id, RANK() OVER (ORDER BY MAX(score) DESC)::int AS rank
         FROM game_runs
        WHERE game_type = $1 AND completed = TRUE
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY user_id
     )
     SELECT rank FROM ranked WHERE user_id = $2 LIMIT 1`,
    [gameType, userId],
  );
  const rank = rows[0]?.rank;
  if (!rank || rank > 50) return;

  // Dedupe by source_type tag inside title — keep the implementation simple
  // (no separate "achievement_log" table). 7-day window mirrors the milestone
  // cadence used elsewhere.
  const titleTag = `Top 50 — ${gameType}`;
  const { rows: dupes } = await pool.query(
    `SELECT id FROM user_notifications
      WHERE user_id = $1
        AND type = 'achievement_unlocked'
        AND title = $2
        AND created_at >= NOW() - INTERVAL '7 days'
      LIMIT 1`,
    [userId, titleTag],
  );
  if (dupes.length > 0) return;

  await createNotification({
    userId,
    type: 'achievement_unlocked',
    title: titleTag,
    message: `Chúc mừng! Bạn đang xếp hạng #${rank} trong tháng ở game ${gameType}.`,
    linkUrl: `/games/leaderboard?game_type=${gameType}`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/games/leaderboard  (auth)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/leaderboard',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { game_type, range = 'all_time' } = req.query as { game_type?: string; range?: string };

    const VALID_TYPES = ['lexisweep', 'anagram', 'ladder'];
    const VALID_RANGES = ['all_time', 'monthly', 'weekly', 'daily'];

    if (!game_type || !VALID_TYPES.includes(game_type)) {
      return apiError(res, 400, 'VALIDATION_ERROR', `game_type phải là: ${VALID_TYPES.join(', ')}`);
    }
    if (!VALID_RANGES.includes(range)) {
      return apiError(res, 400, 'VALIDATION_ERROR', `range phải là: ${VALID_RANGES.join(', ')}`);
    }

    const cacheKey = `lb:${game_type}:${range}`;
    const cached = leaderboardCache.get<any>(cacheKey);
    if (cached) {
      const myRank = cached.all.find((r: any) => r.user_id === userId) ?? null;
      return apiSuccess(res, formatLeaderboard(cached.all, userId, myRank));
    }

    const dateFilter: Record<string, string> = {
      all_time: '',
      monthly: `AND gr.created_at >= NOW() - INTERVAL '30 days'`,
      weekly:  `AND gr.created_at >= NOW() - INTERVAL '7 days'`,
      daily:   `AND gr.created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')`,
    };

    const { rows } = await pool.query(
      `WITH ranked AS (
         SELECT
           u.id                       AS user_id,
           u.full_name,
           u.avatar_url,
           MAX(gr.score)::int         AS best_score,
           COUNT(gr.id)::int          AS games_played,
           RANK() OVER (ORDER BY MAX(gr.score) DESC)::int AS rank
         FROM game_runs gr
         JOIN users u ON u.id = gr.user_id
         WHERE gr.game_type = $1
           AND gr.completed = TRUE
           ${dateFilter[range]}
         GROUP BY u.id, u.full_name, u.avatar_url
       )
       SELECT * FROM ranked
       WHERE rank <= 100
       ORDER BY rank ASC`,
      [game_type]
    );

    leaderboardCache.set(cacheKey, { all: rows });

    return apiSuccess(res, formatLeaderboard(rows, userId, null));
  })
);

function formatLeaderboard(rows: any[], userId: string, _cached: any) {
  const top3 = rows.slice(0, 3);
  const rank4to100 = rows.slice(3);
  const myEntry = rows.find((r) => r.user_id === userId);

  let myRank: Record<string, any> | null = null;
  if (myEntry) {
    const above = rows.find((r) => r.rank === myEntry.rank - 1);
    myRank = {
      rank: myEntry.rank,
      best_score: myEntry.best_score,
      delta: above ? above.best_score - myEntry.best_score : 0,
    };
  }

  return { top_3: top3, rank_4_to_100: rank4to100, my_rank: myRank };
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/games/me/stats  (auth)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/me/stats',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;

    const [{ rows: agg }, { rows: recent }] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int                                                   AS games_played,
           COALESCE(SUM(score), 0)::int                                    AS total_score,
           COALESCE(SUM(time_sec), 0)::int                                 AS time_spent_sec,
           MAX(score) FILTER (WHERE game_type = 'lexisweep')::int          AS best_lexisweep,
           MAX(score) FILTER (WHERE game_type = 'anagram')::int            AS best_anagram,
           MAX(score) FILTER (WHERE game_type = 'ladder')::int             AS best_ladder,
           COUNT(*) FILTER (WHERE game_type = 'lexisweep')::int            AS lexisweep_played,
           COUNT(*) FILTER (WHERE game_type = 'anagram')::int              AS anagram_played,
           COUNT(*) FILTER (WHERE game_type = 'ladder')::int               AS ladder_played,
           ROUND(AVG(accuracy)::numeric, 3)::float                         AS avg_accuracy
         FROM game_runs
         WHERE user_id = $1 AND completed = TRUE`,
        [userId]
      ),
      pool.query(
        `SELECT game_type, score, accuracy, time_sec, created_at
           FROM game_runs
          WHERE user_id = $1 AND completed = TRUE
          ORDER BY created_at DESC
          LIMIT 5`,
        [userId]
      ),
    ]);

    const a = agg[0];
    return apiSuccess(res, {
      games_played: a.games_played,
      total_score: a.total_score,
      time_spent_sec: a.time_spent_sec,
      avg_accuracy: a.avg_accuracy ?? 0,
      best_scores: {
        lexisweep: a.best_lexisweep ?? 0,
        anagram: a.best_anagram ?? 0,
        ladder: a.best_ladder ?? 0,
      },
      by_type: {
        lexisweep: { games_played: a.lexisweep_played },
        anagram:   { games_played: a.anagram_played },
        ladder:    { games_played: a.ladder_played },
      },
      top_games: recent,
    });
  })
);

export default router;
