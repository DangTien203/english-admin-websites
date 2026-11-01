import { Router, Response } from 'express';
import { z } from 'zod';
import pool from '../../config/db';
import { ApiRequest } from '../../middlewares/apiAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { apiSuccess, apiError } from '../../utils/apiResponse';
import { PRACTICE_ADVANCE_COUNTS, getIntervals, practiceAdvanceCtes } from '../../utils/leitnerManager';
import { recordActivity } from '../../utils/streakCalculator';
import { parsePagination } from '../../utils/pagination';
import { validateBody } from '../../middlewares/validateBody';
import { buildPracticeQuestions } from '../../services/practiceQuestionService';
import {
  VI_COALESCE,
  shuffleArray,
  buildSwiftChoiceQuestion,
  buildClozeQuestion,
  InsufficientDistractorsError,
  NoExamplesError,
} from '../../utils/questionHelpers';
import {
  gradeLoadedPracticeCard,
  loadPracticeCardForGrading,
  requiresEnglishMeaning,
  PracticeAnswerGradeResult,
} from '../../services/answerGradingService';

const router = Router();

const questionsSchema = z.object({
  card_ids: z.array(z.string().uuid()).min(1).max(20),
  type: z.enum(['swift_choice', 'cloze']),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

router.post('/questions', validateBody(questionsSchema), asyncHandler(async (req: ApiRequest, res: Response) => {
  const { card_ids, type, level } = req.body as z.infer<typeof questionsSchema>;
  return apiSuccess(res, await buildPracticeQuestions(req.user!.id, card_ids, type, level ?? 1));
}));

const VALID_MODES = ['flashcard', 'swift_choice', 'cloze_craft', 'pair_link'] as const;
type PracticeMode = (typeof VALID_MODES)[number];

// A card of a deck the user may use: its own deck, or a published premade / system-generated one.
const DECK_ACCESS = `(d.user_id = $2 OR (d.deck_type IN ('premade','system_generated') AND d.status = 'published'))`;

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/practice/session/start
//
//  Two selection modes:
//    1. Random:  body has `limit` only          → words NOT yet in Leitner first (random),
//                                                  then, only if the deck has fewer unlearned
//                                                  words than `limit`, random words already in
//                                                  Leitner boxes 1–5 fill the remainder
//    2. Manual:  body has `card_ids`            → exact ids (must all belong to deck)
//  If both provided, `card_ids` wins and `limit` is ignored.
// ─────────────────────────────────────────────────────────────────────────────
const sessionStartSchema = z.object({
  deck_id: z.string().uuid({ message: 'deck_id phải là UUID hợp lệ' }),
  mode: z.enum(VALID_MODES, {
    message: `mode phải là một trong: ${VALID_MODES.join(', ')}`,
  }),
  limit: z.number().int().min(1).max(100).optional(),
  card_ids: z
    .array(z.string().uuid())
    .min(1, { message: 'card_ids phải có ít nhất 1 phần tử' })
    .max(200, { message: 'card_ids tối đa 200 phần tử' })
    .optional(),
});

// What a session card needs: the card, its entry, the user's progress on the card and the Leitner box of the word.
const SESSION_CARD_SELECT = `
  SELECT
    c.id            AS card_id,
    c.entry_id,
    c.note_html,
    de.headword,
    de.ipa_us,
    de.audio_us_url,
    ${VI_COALESCE} AS meaning_vi,
    ucp.times_seen,
    ucp.times_correct,
    lc.box_number   AS leitner_box_number
  FROM cards c
  JOIN dictionary_entries de ON de.id = c.entry_id
  LEFT JOIN user_card_progress ucp ON ucp.card_id = c.id AND ucp.user_id = $2
  LEFT JOIN leitner_cards lc ON lc.entry_id = c.entry_id AND lc.user_id = $2`;

router.post(
  '/session/start',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;

    const parsed = sessionStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(
        res,
        400,
        'VALIDATION_ERROR',
        'Dữ liệu không hợp lệ',
        parsed.error.issues
      );
    }
    const { deck_id, mode, limit, card_ids } = parsed.data;

    // ── Card selection ────────────────────────────────────────────────────────
    // Manual selection wins over random when both provided. Dedupe silently (per spec — duplicates are not an error).
    const manualIds = card_ids && card_ids.length > 0 ? Array.from(new Set(card_ids)) : null;
    const safeLimit = Math.min(100, Math.max(1, limit ?? 20));

    // The access check and the card query do not depend on each other, so they are asked together (one round trip, not two or three).
    // The cards are only used when the deck turns out to be the user's to use.
    const [deckRes, cardsRes] = await Promise.all([
      pool.query(
        `SELECT id FROM decks
         WHERE id = $1 AND (user_id = $2 OR deck_type IN ('premade','system_generated'))`,
        [deck_id, userId]
      ),
      manualIds
        ? // Manual selection bypasses the mastered filter — user explicitly picked these. The deck filter makes the rows that come back
          // exactly the ids that belong to the deck, so no separate "do they all belong?" query is needed.
          pool.query(`${SESSION_CARD_SELECT} WHERE c.deck_id = $1 AND c.id = ANY($3::uuid[])`, [deck_id, userId, manualIds])
        : // Random selection: unlearned words (no Leitner card) first, then learned words
          // (any box 1–5, mastered included) to top up to `limit`. Both groups are random
          // (RANDOM() tie-break inside each group); the final list is shuffled so new and
          // review words are mixed. If the deck has fewer than `limit` cards, return all
          // of them (no error — mobile shows snackbar with the actual count).
          pool.query(`${SESSION_CARD_SELECT} WHERE c.deck_id = $1 ORDER BY (lc.id IS NOT NULL), RANDOM() LIMIT $3`, [deck_id, userId, safeLimit]),
    ]);
    if (deckRes.rows.length === 0) {
      return apiError(res, 404, 'DECK_NOT_FOUND', 'Deck không tồn tại');
    }

    let cards: any[] = cardsRes.rows;
    if (manualIds) {
      const found = new Set(cards.map((c: any) => c.card_id as string));
      const invalidIds = manualIds.filter((id) => !found.has(id));
      if (invalidIds.length > 0) {
        return apiError(
          res,
          400,
          'INVALID_CARDS',
          'Một số thẻ không thuộc bộ thẻ này',
          { invalid_card_ids: invalidIds }
        );
      }
    } else {
      cards = shuffleArray(cards);
    }

    // Create DB session
    const { rows: sessionRows } = await pool.query(
      `INSERT INTO practice_sessions (user_id, deck_id, mode, total_count)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, deck_id, mode, cards.length]
    );
    const session_id: string = sessionRows[0].id;

    return apiSuccess(res, {
      session_id,
      mode,
      cards: cards.map((c) => ({
        card_id: c.card_id,
        entry_id: c.entry_id,
        note_html: c.note_html,
        headword: c.headword,
        ipa_us: c.ipa_us || null,
        audio_us_url: c.audio_us_url || null,
        meaning_vi: c.meaning_vi || null,
        times_seen: c.times_seen ?? 0,
        times_correct: c.times_correct ?? 0,
        leitner_box_number: c.leitner_box_number ?? null,
        is_new_word: c.leitner_box_number == null,
        // Box 4/5 cards must be answered in BOTH Vietnamese and English (`user_answer_en`).
        requires_english_meaning: requiresEnglishMeaning(c.leitner_box_number),
      })),
      total_count: cards.length,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/practice/session/answer
//  body:
//    Legacy client-graded: { session_id, card_id, correct, time_ms?, user_answer? }
//    Typed answer:         { session_id, card_id, user_answer, user_answer_en?, time_ms? }
//
//  Cards already in Leitner box 4/5 (`requires_english_meaning` in session/start)
//  are only `correct` when BOTH `user_answer` (Vietnamese) and `user_answer_en`
//  (English meaning) are right.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/session/answer',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { session_id, card_id, correct, time_ms, user_answer, user_answer_en } = req.body as {
      session_id: string;
      card_id: string;
      correct: boolean;
      time_ms?: number;
      user_answer?: string;
      user_answer_en?: string;
    };

    const hasLegacyCorrect = typeof correct === 'boolean';
    const hasTypedAnswer = typeof user_answer === 'string';

    if (!session_id || !card_id || (!hasLegacyCorrect && !hasTypedAnswer)) {
      return apiError(
        res,
        400,
        'VALIDATION_ERROR',
        'session_id, card_id và correct hoặc user_answer là bắt buộc'
      );
    }

    // Fetch and validate the session, and find the card: independent reads, asked together. A typed answer needs the card anyway,
    // with what the grader compares it with, so that one read also tells whether the card exists; a client-graded answer only checks.
    const [{ rows: sessionRows }, cardToGrade, cardExists] = await Promise.all([
      pool.query(
        `SELECT id, user_id, total_count, answered_count, correct_count, wrong_count, completed_at
         FROM practice_sessions WHERE id = $1`,
        [session_id]
      ),
      hasLegacyCorrect
        ? Promise.resolve(null)
        : loadPracticeCardForGrading(card_id, userId).catch((err) => {
            if (err?.message === 'CARD_NOT_FOUND') return null;
            throw err;
          }),
      hasLegacyCorrect ? pool.query(`SELECT 1 FROM cards WHERE id = $1`, [card_id]).then((r) => r.rows.length > 0) : Promise.resolve(true),
    ]);
    if (sessionRows.length === 0 || sessionRows[0].user_id !== userId) {
      return apiError(res, 404, 'SESSION_NOT_FOUND', 'Session không tồn tại');
    }
    if (sessionRows[0].completed_at !== null) {
      return apiError(res, 400, 'SESSION_ALREADY_COMPLETED', 'Session đã hoàn thành');
    }
    if (!cardExists || (!hasLegacyCorrect && !cardToGrade)) {
      return apiError(res, 404, 'CARD_NOT_FOUND', 'Card không tồn tại');
    }

    let finalCorrect = hasLegacyCorrect ? correct : false;
    let grading: PracticeAnswerGradeResult = {
      correct: finalCorrect,
      verdict: finalCorrect ? 'correct' : 'wrong',
      confidence: 1,
      grading_source: 'client_legacy',
      matched_answer: null,
      accepted_answers: [],
      reason_vi: null,
      details: {},
    };

    let englishGrading: PracticeAnswerGradeResult | null = null;
    let needsEnglish = false;

    if (!hasLegacyCorrect) {
      const cardGrade = await gradeLoadedPracticeCard(
        cardToGrade!,
        user_answer ?? '',
        typeof user_answer_en === 'string' ? user_answer_en : undefined
      );
      grading = cardGrade.vi;
      englishGrading = cardGrade.en;
      needsEnglish = cardGrade.requires_english_meaning;
      finalCorrect = cardGrade.correct;
    }

    // Record the answer, bump the session counters and the card progress in ONE statement: the three used to be three round trips,
    // one after the other, and could half-apply. The counters come back from the UPDATE.
    const { rows: updated } = await pool.query(
      `WITH ans AS (
         INSERT INTO practice_answers
           (session_id, card_id, correct, time_ms, user_answer,
            grading_source, verdict, confidence, matched_answer, accepted_answers, grading_details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ), upd AS (
         UPDATE practice_sessions
            SET answered_count = answered_count + 1,
                correct_count  = correct_count  + $13::int,
                wrong_count    = wrong_count    + (1 - $13::int)
          WHERE id = $1 AND user_id = $12
      RETURNING answered_count, correct_count, wrong_count, total_count
       ), prog AS (
         -- Track card progress (idempotent — creates row if missing)
         INSERT INTO user_card_progress (user_id, card_id, times_seen, times_correct, first_seen_at)
         VALUES ($12, $2, 1, $13::int, NOW())
         ON CONFLICT (user_id, card_id) DO UPDATE SET
           times_seen    = user_card_progress.times_seen + 1,
           times_correct = user_card_progress.times_correct + $13::int,
           last_review   = NOW(),
           updated_at    = NOW()
       )
       SELECT answered_count, correct_count, wrong_count, total_count FROM upd`,
      [
        session_id,
        card_id,
        finalCorrect,
        time_ms ?? null,
        user_answer ?? null,
        grading.grading_source,
        grading.verdict,
        grading.confidence,
        grading.matched_answer,
        JSON.stringify(grading.accepted_answers),
        JSON.stringify({
          reason_vi: grading.reason_vi,
          ...grading.details,
          requires_english_meaning: needsEnglish,
          english: englishGrading
            ? {
                user_answer: user_answer_en ?? null,
                correct: englishGrading.correct,
                verdict: englishGrading.verdict,
                confidence: englishGrading.confidence,
                grading_source: englishGrading.grading_source,
                matched_answer: englishGrading.matched_answer,
                reason_vi: englishGrading.reason_vi,
              }
            : null,
        }),
        userId,
        finalCorrect ? 1 : 0,
      ]
    );
    const s = updated[0];

    return apiSuccess(res, {
      progress: `${s.answered_count}/${s.total_count}`,
      correct_so_far: s.correct_count,
      wrong_so_far: s.wrong_count,
      grading: {
        correct: finalCorrect,
        verdict: grading.verdict,
        confidence: grading.confidence,
        grading_source: grading.grading_source,
        matched_answer: grading.matched_answer,
        accepted_answers: grading.accepted_answers,
        reason_vi: grading.reason_vi,
      },
      requires_english_meaning: needsEnglish,
      english_grading: englishGrading
        ? {
            correct: englishGrading.correct,
            verdict: englishGrading.verdict,
            confidence: englishGrading.confidence,
            grading_source: englishGrading.grading_source,
            matched_answer: englishGrading.matched_answer,
            accepted_answers: englishGrading.accepted_answers,
            reason_vi: englishGrading.reason_vi,
          }
        : null,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/practice/session/complete
//  body: { session_id }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/session/complete',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { session_id } = req.body as { session_id: string };

    if (!session_id) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'session_id là bắt buộc');
    }

    // The session, the distinct correctly-answered cards of it (both keyed by the session id) and the box intervals are read
    // together. (The cards of a session that turns out not to be the user's are simply not used.)
    const [{ rows: sessionRows }, { rows: correctRows }, intervals] = await Promise.all([
      pool.query(
        `SELECT id, user_id, deck_id, mode, correct_count, wrong_count, total_count,
                started_at, completed_at
         FROM practice_sessions WHERE id = $1`,
        [session_id]
      ),
      pool.query(
        `SELECT DISTINCT pa.card_id, c.entry_id
         FROM practice_answers pa
         JOIN cards c ON c.id = pa.card_id
         WHERE pa.session_id = $1 AND pa.correct = true`,
        [session_id]
      ),
      getIntervals(),
    ]);
    if (sessionRows.length === 0 || sessionRows[0].user_id !== userId) {
      return apiError(res, 404, 'SESSION_NOT_FOUND', 'Session không tồn tại');
    }
    if (sessionRows[0].completed_at !== null) {
      return apiError(res, 400, 'SESSION_ALREADY_COMPLETED', 'Session đã hoàn thành');
    }

    const session = sessionRows[0];
    const timeTotalMs = Date.now() - new Date(session.started_at).getTime();
    const correctCount: number = session.correct_count;
    const wrongCount: number = session.wrong_count;
    const xpEarned = correctCount * 10 + 20; // +20 completion bonus

    const correctCardIds = [...new Set(correctRows.map((r: any) => r.card_id as string))];
    const correctEntryIds = [...new Set(correctRows.map((r: any) => r.entry_id as string))];

    // Marking the session complete and applying its correct answers to Leitner are ONE statement: the claim comes first and only
    // the request that wins it moves the cards (new words → Leitner box 1, words already in a box → next box; `correct` already
    // means "Vietnamese AND English right" for box 4/5 cards). Two completions at once, or a client that retries a slow one, used to
    // read the session as open, both advance the cards, and push every word up two boxes. Atomic: a failure leaves the session open.
    // Beside it (they do not depend on each other) the activity is logged and the streak updated; non-critical streak work must
    // not fail the request.
    const [{ rows: [done] }, streakUpdated] = await Promise.all([
      pool.query(
        `WITH claim AS (
           UPDATE practice_sessions
              SET completed_at = NOW(), time_total_ms = $2, xp_earned = $3
            WHERE id = $1 AND user_id = $4 AND completed_at IS NULL
        RETURNING id
         ), ${practiceAdvanceCtes({
           user: '$4::uuid',
           entryIds: '$5::uuid[]',
           intervals: '$6::float8[]',
           mode: '$7::text',
           gate: 'EXISTS (SELECT 1 FROM claim)',
         })}
         SELECT (SELECT COUNT(*) FROM claim)::int AS claimed, ${PRACTICE_ADVANCE_COUNTS}`,
        [session_id, timeTotalMs, xpEarned, userId, correctEntryIds, intervals, session.mode]
      ),
      recordActivity(userId, 'practice_session', {
        mode: session.mode,
        deck_id: session.deck_id,
        session_id,
        correct_count: correctCount,
        xp_earned: xpEarned,
      }).then(
        () => true,
        () => false
      ),
    ]);
    if (done.claimed === 0) {
      // Another request completed this session between our read and our claim.
      return apiError(res, 400, 'SESSION_ALREADY_COMPLETED', 'Session đã hoàn thành');
    }
    const leitnerResult = { added: done.added, skipped: correctEntryIds.length - done.added, advanced: done.advanced, mastered_now: done.mastered_now };

    const accuracy = (correctCount + wrongCount) > 0
      ? Math.round((correctCount / (correctCount + wrongCount)) * 100) / 100
      : 0;

    return apiSuccess(res, {
      summary: {
        correct_count: correctCount,
        wrong_count: wrongCount,
        accuracy,
        time_total_ms: timeTotalMs,
      },
      xp_earned: xpEarned,
      leitner_added: { added: leitnerResult.added, skipped: leitnerResult.skipped },
      leitner_advanced: leitnerResult.advanced,
      leitner_mastered_now: leitnerResult.mastered_now,
      streak_updated: streakUpdated,
      correct_card_ids: correctCardIds,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/practice/swift-choice/question
//  body: { card_id }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/swift-choice/question',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { card_id } = req.body as { card_id: string };

    if (!card_id) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'card_id là bắt buộc');
    }

    const { rows: cardRows } = await pool.query(
      `SELECT c.entry_id, de.headword, de.ipa_us, de.pos, de.cefr_level,
         ${VI_COALESCE} AS correct_vi
       FROM cards c
       JOIN dictionary_entries de ON de.id = c.entry_id
       JOIN decks d ON d.id = c.deck_id
       WHERE c.id = $1 AND ${DECK_ACCESS}`,
      [card_id, userId]
    );
    if (cardRows.length === 0) {
      return apiError(res, 404, 'CARD_NOT_FOUND', 'Card không tồn tại');
    }

    const card = cardRows[0];

    // The same question builder as /leitner/swift-choice/question (the two surfaces share the question shape).
    try {
      const question = await buildSwiftChoiceQuestion({
        entry_id: card.entry_id,
        headword: card.headword,
        ipa_us: card.ipa_us,
        pos: card.pos,
        cefr_level: card.cefr_level,
        correct_vi: card.correct_vi,
      });
      return apiSuccess(res, { card_id, ...question });
    } catch (err) {
      if (err instanceof InsufficientDistractorsError) {
        return apiError(res, 422, 'INSUFFICIENT_DISTRACTORS', 'Không đủ distractors');
      }
      throw err;
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/practice/cloze/question
//  body: { card_id, level (1|2|3) }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/cloze/question',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { card_id, level } = req.body as { card_id: string; level: 1 | 2 | 3 };

    if (!card_id) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'card_id là bắt buộc');
    }
    if (![1, 2, 3].includes(level)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'level phải là 1, 2, hoặc 3');
    }

    const { rows: cardRows } = await pool.query(
      `SELECT c.entry_id, de.headword, de.pos
       FROM cards c
       JOIN dictionary_entries de ON de.id = c.entry_id
       JOIN decks d ON d.id = c.deck_id
       WHERE c.id = $1 AND ${DECK_ACCESS}`,
      [card_id, userId]
    );
    if (cardRows.length === 0) {
      return apiError(res, 404, 'CARD_NOT_FOUND', 'Card không tồn tại');
    }

    const card = cardRows[0];

    try {
      const question = await buildClozeQuestion(
        { entry_id: card.entry_id, headword: card.headword, pos: card.pos },
        level
      );
      return apiSuccess(res, { card_id, ...question });
    } catch (err) {
      if (err instanceof NoExamplesError) {
        return apiError(
          res,
          422,
          'NO_EXAMPLES',
          err.reason === 'none' ? 'Card này không có câu ví dụ' : 'Không tìm được câu ví dụ phù hợp'
        );
      }
      throw err;
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/practice/pair-link/session
//  body: { deck_id, count }
// ─────────────────────────────────────────────────────────────────────────────
const PAIR_ORDER = `
  CASE
    WHEN lc.id IS NOT NULL AND lc.due_at <= NOW() THEN 0
    WHEN lc.id IS NOT NULL AND lc.box_number IN (1, 2) THEN 1
    WHEN lc.id IS NULL THEN 2
    ELSE 3
  END, RANDOM()
`;

router.post(
  '/pair-link/session',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { deck_id, count = 5 } = req.body as {
      deck_id: string;
      count?: number;
    };

    if (!deck_id) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'deck_id là bắt buộc');
    }

    const safeCount = Math.min(10, Math.max(1, count || 5));

    // Deck access and the pairs are independent reads: asked together (the pairs are only used when the deck is accessible).
    const [{ rows: deckRows }, { rows }] = await Promise.all([
      pool.query(
        `SELECT id FROM decks WHERE id = $1
         AND (user_id = $2 OR deck_type IN ('premade','system_generated'))`,
        [deck_id, userId]
      ),
      pool.query(
        `SELECT c.id AS card_id, de.headword, ${VI_COALESCE} AS vi_text
         FROM cards c
         JOIN dictionary_entries de ON de.id = c.entry_id
         LEFT JOIN leitner_cards lc ON lc.entry_id = c.entry_id AND lc.user_id = $2
         WHERE c.deck_id = $1
         ORDER BY ${PAIR_ORDER}
         LIMIT $3`,
        [deck_id, userId, safeCount]
      ),
    ]);
    if (deckRows.length === 0) {
      return apiError(res, 404, 'DECK_NOT_FOUND', 'Deck không tồn tại');
    }

    const pairs = rows.map((row: any, idx: number) => ({
      card_id: row.card_id,
      pair_id: `p${idx + 1}`,
      en: row.headword,
      vi: row.vi_text || '',
    }));

    return apiSuccess(res, { pairs });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/practice/history
//  query: page, limit
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/history',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { page, limit, offset } = parsePagination(req);

    const [listResult, countResult] = await Promise.all([
      pool.query(
        `SELECT
           id AS session_id, deck_id, mode,
           total_count, answered_count, correct_count, wrong_count,
           xp_earned, time_total_ms, started_at, completed_at
         FROM practice_sessions
         WHERE user_id = $1
         ORDER BY started_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM practice_sessions WHERE user_id = $1`,
        [userId]
      ),
    ]);

    const total = countResult.rows[0].total;
    return apiSuccess(res, {
      items: listResult.rows,
      meta: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  })
);

export default router;
