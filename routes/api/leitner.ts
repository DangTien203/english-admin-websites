import { Router, Response } from 'express';
import { z } from 'zod';
import NodeCache from 'node-cache';
import pool from '../../config/db';
import { ApiRequest } from '../../middlewares/apiAuth';
import { validateBody } from '../../middlewares/validateBody';
import { asyncHandler } from '../../utils/asyncHandler';
import { apiSuccess, apiError } from '../../utils/apiResponse';
import { getIntervals, moveCard } from '../../utils/leitnerManager';
import {
  VI_COALESCE,
  shuffleArray,
  buildSwiftChoiceQuestion,
  buildClozeQuestion,
  InsufficientDistractorsError,
  NoExamplesError,
} from '../../utils/questionHelpers';
import { buildAcceptedAnswerTexts } from '../../utils/answerMatcher';
import {
  gradeLeitnerAnswer,
  requiresEnglishMeaning,
  PracticeAnswerGradeResult,
} from '../../services/answerGradingService';
import {
  LeitnerSessionError,
  answerReviewStep,
  completeReviewSession,
  getReviewSession,
  startReviewSession,
} from '../../services/leitnerSessionService';

const statsCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

const router = Router();

// First VI definition — Pro sense first, legacy meaning_vi fallback
const VI_PREVIEW = `COALESCE(
  (SELECT es.definition_vi FROM entry_senses es
   WHERE es.entry_id = de.id AND es.definition_vi IS NOT NULL
   ORDER BY es.sense_order ASC LIMIT 1),
  NULLIF(SPLIT_PART(COALESCE(de.meaning_vi, ''), E'\\n', 1), '')
)`;

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/leitner/overview
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/overview',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const intervals = await getIntervals();

    const [{ rows: boxRows }, { rows: retRows }, { rows: masteredRows }, { rows: avgRows }] =
      await Promise.all([
        // Box distribution + due counts
        pool.query(
          `SELECT
             box_number,
             COUNT(*)::int                                        AS total_cards,
             COUNT(*) FILTER (WHERE due_at <= NOW())::int        AS due_today
           FROM leitner_cards
           WHERE user_id = $1
           GROUP BY box_number
           ORDER BY box_number`,
          [userId]
        ),
        // Retention rate last 30 days
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE correct = true)::float
               / NULLIF(COUNT(*), 0) AS rate
           FROM leitner_reviews
           WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
          [userId]
        ),
        // Mastered (box 5) all time
        pool.query(
          `SELECT COUNT(*)::int AS mastered
           FROM leitner_cards WHERE user_id = $1 AND box_number = 5`,
          [userId]
        ),
        // Avg days from card creation to reaching box 5
        pool.query(
          `SELECT AVG(
             EXTRACT(EPOCH FROM (last_reviewed_at - created_at)) / 86400
           )::numeric(10,1) AS avg_days
           FROM leitner_cards
           WHERE user_id = $1 AND box_number = 5 AND last_reviewed_at IS NOT NULL`,
          [userId]
        ),
      ]);

    const boxMap = new Map<number, { total_cards: number; due_today: number }>(
      boxRows.map((r: any) => [r.box_number as number, r])
    );

    const boxes = [1, 2, 3, 4, 5].map(n => {
      const row = boxMap.get(n);
      return {
        box_number: n,
        interval_days: intervals[n - 1],
        total_cards: row?.total_cards ?? 0,
        due_today: row?.due_today ?? 0,
      };
    });

    return apiSuccess(res, {
      boxes,
      today_due_total: boxes.reduce((sum, b) => sum + b.due_today, 0),
      stats: {
        retention_30d: Math.round((retRows[0]?.rate ?? 0) * 100) / 100,
        mastered_all_time: masteredRows[0]?.mastered ?? 0,
        avg_days_to_box_5: parseFloat(avgRows[0]?.avg_days ?? '0') || 0,
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/leitner/due?limit=20&offset=0
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/due',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const safeLimit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const safeOffset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);

    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT
           lc.id,
           lc.entry_id,
           lc.box_number,
           lc.due_at,
           lc.last_reviewed_at,
           lc.correct_streak,
           lc.total_reviews,
           lc.source,
           lc.added_from_mode,
           lc.created_at,
           de.headword,
           de.lemma,
           de.ipa_us,
           de.ipa_uk,
           de.audio_us_url,
           de.audio_uk_url,
           de.pos,
           de.cefr_level,
           ${VI_PREVIEW}  AS meaning_preview
         FROM leitner_cards lc
         JOIN dictionary_entries de ON de.id = lc.entry_id
         WHERE lc.user_id = $1 AND lc.due_at <= NOW()
         ORDER BY lc.due_at ASC
         LIMIT $2 OFFSET $3`,
        [userId, safeLimit, safeOffset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total_due
         FROM leitner_cards
         WHERE user_id = $1 AND due_at <= NOW()`,
        [userId]
      ),
    ]);

    return apiSuccess(res, {
      items: items.map((row: any) => ({
        id: row.id,
        entry_id: row.entry_id,
        box_number: row.box_number,
        due_at: row.due_at,
        last_reviewed_at: row.last_reviewed_at ?? null,
        correct_streak: row.correct_streak ?? 0,
        total_reviews: row.total_reviews ?? 0,
        source: row.source ?? null,
        added_from_mode: row.added_from_mode ?? null,
        created_at: row.created_at,
        entry: {
          id: row.entry_id,
          headword: row.headword,
          lemma: row.lemma ?? null,
          ipa_us: row.ipa_us ?? null,
          ipa_uk: row.ipa_uk ?? null,
          audio_us_url: row.audio_us_url ?? null,
          audio_uk_url: row.audio_uk_url ?? null,
          pos: row.pos ?? [],
          meaning_preview: row.meaning_preview ?? null,
          accepted_answers: buildAcceptedAnswerTexts({ meaningVi: row.meaning_preview ?? null }),
          cefr_level: row.cefr_level ?? null,
        },
      })),
      meta: {
        total_due: countRows[0]?.total_due ?? 0,
        returned: items.length,
        offset: safeOffset,
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/leitner/box/:box_number?page=1&limit=20
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/box/:box_number',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const boxNumber = parseInt(req.params.box_number as string, 10);

    if (!Number.isInteger(boxNumber) || boxNumber < 1 || boxNumber > 5) {
      return apiError(res, 400, 'INVALID_BOX_NUMBER', 'box_number phải là 1–5');
    }

    const intervals = await getIntervals();
    const safePage = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const safeLimit = Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20);
    const offset = (safePage - 1) * safeLimit;

    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT
           lc.id,
           lc.entry_id,
           lc.box_number,
           lc.due_at,
           lc.last_reviewed_at,
           lc.correct_streak,
           lc.total_reviews,
           lc.source,
           lc.added_from_mode,
           lc.created_at,
           de.headword,
           de.lemma,
           de.ipa_us,
           de.ipa_uk,
           de.audio_us_url,
           de.audio_uk_url,
           de.pos,
           de.cefr_level,
           ${VI_PREVIEW}  AS meaning_preview
         FROM leitner_cards lc
         JOIN dictionary_entries de ON de.id = lc.entry_id
         WHERE lc.user_id = $1 AND lc.box_number = $2
         ORDER BY lc.due_at ASC NULLS LAST
         LIMIT $3 OFFSET $4`,
        [userId, boxNumber, safeLimit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE due_at <= NOW())::int AS due_count
         FROM leitner_cards WHERE user_id = $1 AND box_number = $2`,
        [userId, boxNumber]
      ),
    ]);

    const total: number = countRows[0]?.count ?? 0;
    const dueCount: number = countRows[0]?.due_count ?? 0;

    return apiSuccess(res, {
      box_number: boxNumber,
      items: items.map((row: any) => ({
        id: row.id,
        entry_id: row.entry_id,
        box_number: row.box_number,
        due_at: row.due_at,
        last_reviewed_at: row.last_reviewed_at ?? null,
        correct_streak: row.correct_streak ?? 0,
        total_reviews: row.total_reviews ?? 0,
        source: row.source ?? null,
        added_from_mode: row.added_from_mode ?? null,
        created_at: row.created_at,
        entry: {
          id: row.entry_id,
          headword: row.headword,
          lemma: row.lemma ?? null,
          ipa_us: row.ipa_us ?? null,
          ipa_uk: row.ipa_uk ?? null,
          audio_us_url: row.audio_us_url ?? null,
          audio_uk_url: row.audio_uk_url ?? null,
          pos: row.pos ?? [],
          meaning_preview: row.meaning_preview ?? null,
          accepted_answers: buildAcceptedAnswerTexts({ meaningVi: row.meaning_preview ?? null }),
          cefr_level: row.cefr_level ?? null,
        },
      })),
      total,
      // cards of this box that are due now = the words "review the due words of this box" can use
      due_count: dueCount,
      page: safePage,
      limit: safeLimit,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/leitner/review
//  body:
//    Legacy client-graded: { leitner_card_id, correct, time_ms? }
//    Typed answer:         { leitner_card_id, user_answer, time_ms? }
//
//  Single-check cards only (box 1–3). Box 4/5 cards must be checked on BOTH the
//  English and the Vietnamese meaning, spaced apart, which only works inside a
//  review session (POST /leitner/session/start).
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/review',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { leitner_card_id, correct, time_ms, user_answer } = req.body as {
      leitner_card_id: string;
      correct?: boolean;
      time_ms?: number;
      user_answer?: string;
    };

    if (!leitner_card_id || typeof leitner_card_id !== 'string') {
      return apiError(res, 400, 'VALIDATION_ERROR', 'leitner_card_id là bắt buộc');
    }

    const { rows: cardRows } = await pool.query(
      `SELECT box_number FROM leitner_cards WHERE id = $1 AND user_id = $2`,
      [leitner_card_id, userId]
    );
    if (cardRows.length === 0) {
      return apiError(res, 404, 'CARD_NOT_FOUND', 'Leitner card không tồn tại');
    }
    if (requiresEnglishMeaning(cardRows[0].box_number)) {
      return apiError(
        res,
        409,
        'REVIEW_SESSION_REQUIRED',
        'Thẻ ở box 4/5 phải kiểm tra cả nghĩa tiếng Anh và tiếng Việt trong một phiên ôn tập (POST /api/v1/leitner/session/start)'
      );
    }

    const hasTypedAnswer = typeof user_answer === 'string';
    const hasLegacyCorrect = typeof correct === 'boolean';
    if (!hasTypedAnswer && !hasLegacyCorrect) {
      return apiError(
        res,
        400,
        'VALIDATION_ERROR',
        'correct hoặc user_answer là bắt buộc'
      );
    }

    let finalCorrect = hasLegacyCorrect ? correct! : false;
    let grading: PracticeAnswerGradeResult | null = null;

    if (hasTypedAnswer) {
      try {
        grading = await gradeLeitnerAnswer(leitner_card_id, userId, user_answer ?? '');
      } catch (err: any) {
        if (err.statusCode === 404) {
          return apiError(res, 404, 'CARD_NOT_FOUND', 'Leitner card không tồn tại');
        }
        throw err;
      }
      finalCorrect = grading.correct;
    }

    let result: { newBoxNumber: number; nextDueAt: Date; masteredNow: boolean };
    try {
      result = await moveCard(leitner_card_id, userId, finalCorrect, time_ms);
    } catch (err: any) {
      if (err.statusCode === 404) {
        return apiError(res, 404, 'CARD_NOT_FOUND', 'Leitner card không tồn tại');
      }
      throw err;
    }

    return apiSuccess(res, {
      new_box_number: result.newBoxNumber,
      next_due_at: result.nextDueAt,
      mastered_now: result.masteredNow,
      grading: grading
        ? {
            correct: finalCorrect,
            verdict: grading.verdict,
            confidence: grading.confidence,
            grading_source: grading.grading_source,
            matched_answer: grading.matched_answer,
            accepted_answers: grading.accepted_answers,
            reason_vi: grading.reason_vi,
          }
        : {
            correct: finalCorrect,
            verdict: finalCorrect ? 'correct' : 'wrong',
            confidence: 1,
            grading_source: 'client_legacy',
            matched_answer: null,
            accepted_answers: [],
            reason_vi: null,
          },
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  Review sessions — box 4/5 words are checked on BOTH meanings
//
//  Flow:
//    1. POST /session/start    → server picks the due words and returns the ordered steps.
//                                A box 4/5 word appears twice (English meaning, then Vietnamese
//                                meaning, ≥ 2 other steps in between); other words once.
//    2. POST /session/answer   → answer the steps in order. A word's box moves once, after its
//                                last step: every check right → up one box; box 4/5 word with
//                                exactly one meaning right → stays in its box; none right → box 1.
//    3. POST /session/complete → summary counted per original word (10 words → 10, not 13).
//    GET  /session/:id         → resume / re-sync.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_USER_ANSWER_LENGTH = 500;

const sessionStartSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  box_number: z.number().int().min(1).max(5).optional(),
});

const sessionAnswerSchema = z
  .object({
    session_id: z.string().uuid(),
    step_index: z.number().int().min(0),
    user_answer: z.string().max(MAX_USER_ANSWER_LENGTH).optional(),
    correct: z.boolean().optional(),
    time_ms: z.number().int().min(0).max(3_600_000).optional(),
  })
  .refine((b) => b.user_answer !== undefined || b.correct !== undefined, {
    message: 'user_answer hoặc correct là bắt buộc',
  });

const sessionCompleteSchema = z.object({
  session_id: z.string().uuid(),
});

function sendSessionError(res: Response, err: unknown) {
  if (err instanceof LeitnerSessionError) {
    return apiError(res, err.status, err.code, err.message, err.details);
  }
  throw err;
}

// ── POST /api/v1/leitner/session/start ────────────────────────────────────────
//  body: { limit?, box_number? }
//    limit      counts words (default 20, max 100), not steps.
//    box_number omitted → "review due now" (due cards only);
//               1–5     → only the DUE cards of that box (never words that are not due yet).
router.post(
  '/session/start',
  validateBody(sessionStartSchema),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const { limit, box_number } = req.body as z.infer<typeof sessionStartSchema>;
    try {
      return apiSuccess(res, await startReviewSession(req.user!.id, limit ?? 20, box_number));
    } catch (err) {
      return sendSessionError(res, err);
    }
  })
);

// ── POST /api/v1/leitner/session/answer ───────────────────────────────────────
//  body: { session_id, step_index, user_answer?, correct?, time_ms? }
//  Box 4/5 steps need `user_answer` (the meaning asked by the step's `check`);
//  `correct` (client-graded) is only accepted for single-check words.
router.post(
  '/session/answer',
  validateBody(sessionAnswerSchema),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const body = req.body as z.infer<typeof sessionAnswerSchema>;
    try {
      return apiSuccess(
        res,
        await answerReviewStep(req.user!.id, {
          sessionId: body.session_id,
          stepIndex: body.step_index,
          userAnswer: body.user_answer,
          correct: body.correct,
          timeMs: body.time_ms,
        })
      );
    } catch (err) {
      return sendSessionError(res, err);
    }
  })
);

// ── POST /api/v1/leitner/session/complete ─────────────────────────────────────
//  body: { session_id }
router.post(
  '/session/complete',
  validateBody(sessionCompleteSchema),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const { session_id } = req.body as z.infer<typeof sessionCompleteSchema>;
    try {
      return apiSuccess(res, await completeReviewSession(req.user!.id, session_id));
    } catch (err) {
      return sendSessionError(res, err);
    }
  })
);

// ── GET /api/v1/leitner/session/:id ───────────────────────────────────────────
router.get(
  '/session/:id',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      return apiError(res, 404, 'SESSION_NOT_FOUND', 'Session không tồn tại');
    }
    try {
      return apiSuccess(res, await getReviewSession(req.user!.id, id.data));
    } catch (err) {
      return sendSessionError(res, err);
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/leitner/stats?range=7d|30d|all
// ─────────────────────────────────────────────────────────────────────────────
const VALID_RANGES = ['7d', '30d', 'all'] as const;
type ValidRange = (typeof VALID_RANGES)[number];
const RANGE_INTERVAL: Record<ValidRange, string | null> = {
  '7d': '7 days',
  '30d': '30 days',
  all: null,
};

router.get(
  '/stats',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const rangeParam = String(req.query.range || '30d');

    if (!(VALID_RANGES as readonly string[]).includes(rangeParam)) {
      return apiError(res, 400, 'INVALID_RANGE', 'range phải là "7d", "30d", hoặc "all"');
    }

    const range = rangeParam as ValidRange;
    const cacheKey = `stats:${userId}:${range}`;
    const cached = statsCache.get<object>(cacheKey);
    if (cached) return apiSuccess(res, cached);

    const intervalStr = RANGE_INTERVAL[range];
    const dateFilter = intervalStr
      ? `AND lr.created_at >= NOW() - INTERVAL '${intervalStr}'`
      : '';

    const [{ rows: distRows }, { rows: retRows }, { rows: hardRows }, { rows: easyRows }] =
      await Promise.all([
        // 1. Box distribution
        pool.query(
          `SELECT box_number, COUNT(*)::int AS cnt
           FROM leitner_cards WHERE user_id = $1
           GROUP BY box_number`,
          [userId]
        ),

        // 2. Retention rate in range
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE lr.correct = true)::float
               / NULLIF(COUNT(*), 0) AS rate,
             COUNT(*)::int AS total
           FROM leitner_reviews lr
           WHERE lr.user_id = $1 ${dateFilter}`,
          [userId]
        ),

        // 3. Top hardest: most lapses (times sent back to box 1 from higher box)
        pool.query(
          `SELECT de.id AS entry_id, de.headword,
             COUNT(*) FILTER (WHERE lr.new_box = 1 AND lr.old_box > 1)::int AS lapses
           FROM leitner_cards lc
           JOIN dictionary_entries de ON de.id = lc.entry_id
           JOIN leitner_reviews lr ON lr.leitner_card_id = lc.id
           WHERE lc.user_id = $1 ${dateFilter.replace(/lr\./g, 'lr.')}
           GROUP BY de.id, de.headword
           HAVING COUNT(*) FILTER (WHERE lr.new_box = 1 AND lr.old_box > 1) > 0
           ORDER BY lapses DESC
           LIMIT 5`,
          [userId]
        ),

        // 4. Top easiest: highest correct_streak
        pool.query(
          `SELECT de.id AS entry_id, de.headword, lc.correct_streak AS consecutive_correct
           FROM leitner_cards lc
           JOIN dictionary_entries de ON de.id = lc.entry_id
           WHERE lc.user_id = $1 AND lc.correct_streak > 0
           ORDER BY lc.correct_streak DESC
           LIMIT 5`,
          [userId]
        ),
      ]);

    const distribution: Record<string, number> = {
      box_1: 0, box_2: 0, box_3: 0, box_4: 0, box_5: 0,
    };
    for (const row of distRows) {
      distribution[`box_${row.box_number}`] = row.cnt;
    }

    const statsData = {
      distribution,
      retention_rate: Math.round((retRows[0]?.rate ?? 0) * 100) / 100,
      top_hardest: hardRows.map((row: any) => ({
        entry_id: row.entry_id,
        headword: row.headword,
        lapses: row.lapses,
      })),
      top_easiest: easyRows.map((row: any) => ({
        entry_id: row.entry_id,
        headword: row.headword,
        consecutive_correct: row.consecutive_correct,
      })),
    };

    statsCache.set(cacheKey, statsData);
    return apiSuccess(res, statsData);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  Question generation for Leitner review modes (SwiftChoice / Cloze / PairLink)
//
//  Lookup is by leitner_cards.id (not cards.id) so these endpoints work for
//  cross-deck SRS reviews. Distractors for SwiftChoice and Cloze are drawn from
//  a global pool (cefr_level + pos), same as /practice/* — no deck filter.
//
//  The mobile flow per due card:
//    1. Mobile picks one of the 3 modes per card.
//    2. Calls the matching endpoint here to fetch a question.
//    3. User answers. Typed-answer modes should send user_answer so the API can
//       apply the same accepted-answer grading as practice.
//    4. Mobile calls POST /api/v1/leitner/review with leitner_card_id +
//       user_answer (preferred) or correct (legacy) to apply the SRS transition.
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/v1/leitner/swift-choice/question ────────────────────────────────
const swiftChoiceSchema = z.object({
  leitner_card_id: z.string().uuid(),
});

router.post(
  '/swift-choice/question',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const parsed = swiftChoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(
        res, 400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', parsed.error.issues
      );
    }
    const { leitner_card_id } = parsed.data;

    const { rows } = await pool.query(
      `SELECT lc.id AS leitner_card_id, lc.entry_id,
              de.headword, de.ipa_us, de.pos, de.cefr_level,
              ${VI_COALESCE} AS correct_vi
       FROM leitner_cards lc
       JOIN dictionary_entries de ON de.id = lc.entry_id
       WHERE lc.id = $1 AND lc.user_id = $2`,
      [leitner_card_id, userId]
    );
    if (rows.length === 0) {
      return apiError(res, 404, 'LEITNER_CARD_NOT_FOUND', 'Leitner card không tồn tại');
    }
    const card = rows[0];

    try {
      const question = await buildSwiftChoiceQuestion({
        entry_id: card.entry_id,
        headword: card.headword,
        ipa_us: card.ipa_us,
        pos: card.pos,
        cefr_level: card.cefr_level,
        correct_vi: card.correct_vi,
      });
      return apiSuccess(res, {
        leitner_card_id: card.leitner_card_id,
        entry_id: card.entry_id,
        ...question,
      });
    } catch (err) {
      if (err instanceof InsufficientDistractorsError) {
        return apiError(res, 422, 'INSUFFICIENT_DISTRACTORS', 'Không đủ distractors');
      }
      throw err;
    }
  })
);

// ── POST /api/v1/leitner/cloze/question ───────────────────────────────────────
const clozeSchema = z.object({
  leitner_card_id: z.string().uuid(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

router.post(
  '/cloze/question',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const parsed = clozeSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(
        res, 400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', parsed.error.issues
      );
    }
    const { leitner_card_id, level } = parsed.data;

    const { rows } = await pool.query(
      `SELECT lc.entry_id, de.headword, de.pos
       FROM leitner_cards lc
       JOIN dictionary_entries de ON de.id = lc.entry_id
       WHERE lc.id = $1 AND lc.user_id = $2`,
      [leitner_card_id, userId]
    );
    if (rows.length === 0) {
      return apiError(res, 404, 'LEITNER_CARD_NOT_FOUND', 'Leitner card không tồn tại');
    }
    const card = rows[0];

    try {
      const question = await buildClozeQuestion(
        { entry_id: card.entry_id, headword: card.headword, pos: card.pos },
        level
      );
      return apiSuccess(res, {
        leitner_card_id,
        entry_id: card.entry_id,
        ...question,
      });
    } catch (err) {
      if (err instanceof NoExamplesError) {
        return apiError(res, 422, 'NO_EXAMPLES', 'Card này không có câu ví dụ');
      }
      throw err;
    }
  })
);

// ── POST /api/v1/leitner/pair-link/session ────────────────────────────────────
//
// Schema-level rule: min(1) keeps the array non-empty (empty = invalid input shape
// → VALIDATION_ERROR). The "need at least 2 to play" rule is functional, not
// structural, so it's enforced inside the handler with a domain-specific
// INSUFFICIENT_PAIRS code.
const pairLinkSchema = z.object({
  leitner_card_ids: z
    .array(z.string().uuid())
    .min(1, { message: 'leitner_card_ids phải có ít nhất 1 phần tử' })
    .max(20, { message: 'Tối đa 20 leitner cards' }),
});

router.post(
  '/pair-link/session',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const parsed = pairLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(
        res, 400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', parsed.error.issues
      );
    }
    const uniqueIds = Array.from(new Set(parsed.data.leitner_card_ids));

    if (uniqueIds.length < 2) {
      return apiError(
        res, 400, 'INSUFFICIENT_PAIRS',
        'Cần tối thiểu 2 thẻ đến hạn để chơi PairLink'
      );
    }

    const { rows } = await pool.query(
      `SELECT lc.id AS leitner_card_id, lc.entry_id,
              de.headword, ${VI_COALESCE} AS vi_text
       FROM leitner_cards lc
       JOIN dictionary_entries de ON de.id = lc.entry_id
       WHERE lc.user_id = $1 AND lc.id = ANY($2::uuid[])`,
      [userId, uniqueIds]
    );

    if (rows.length < 2) {
      // Most/all ids invalid (foreign user or non-existent) — surface as enumeration-safe
      // INSUFFICIENT_PAIRS rather than leaking which specific ids exist.
      return apiError(
        res, 400, 'INSUFFICIENT_PAIRS',
        'Cần tối thiểu 2 thẻ đến hạn để chơi PairLink'
      );
    }

    const validIds = new Set(rows.map((r: any) => r.leitner_card_id as string));
    const invalid = uniqueIds.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      return apiError(
        res, 404, 'LEITNER_CARD_NOT_FOUND',
        'Một số leitner_card_id không tồn tại hoặc không thuộc bạn',
        { invalid_leitner_card_ids: invalid }
      );
    }

    const shuffled = shuffleArray(rows);
    const pairs = shuffled.map((row: any, idx: number) => ({
      leitner_card_id: row.leitner_card_id,
      entry_id: row.entry_id,
      pair_id: `p${idx + 1}`,
      en: row.headword,
      vi: row.vi_text || '',
    }));

    return apiSuccess(res, { pairs });
  })
);

export default router;
