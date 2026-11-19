import { Router, Response } from 'express';
import { z } from 'zod';
import pool from '../../config/db';
import { ApiRequest } from '../../middlewares/apiAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { apiSuccess, apiError } from '../../utils/apiResponse';
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
  PracticeAnswerGradeResult,
} from '../../services/answerGradingService';
import {
  SESSION_CARD_SELECT,
  closePracticeSession,
  getActivePracticeSession,
  getPracticeSession,
  toSessionCard,
} from '../../services/practiceSessionService';

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
//
//  Optional `options` (what the client chose; stored with the session, echoed back, returned again when the session is resumed):
//    cloze_level  1 | 2 | 3             only for mode = cloze_craft
//    direction    'english'|'vietnamese' only for mode = flashcard
//  The ordered cards are stored too (practice_session_cards): the order is random, and a resumed session must show the same one.
const sessionOptionsSchema = z
  .object({
    cloze_level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    direction: z.enum(['english', 'vietnamese']).optional(),
  })
  .strict();

const sessionStartSchema = z
  .object({
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
    options: sessionOptionsSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.options?.cloze_level !== undefined && body.mode !== 'cloze_craft') {
      ctx.addIssue({ code: 'custom', path: ['options', 'cloze_level'], message: 'cloze_level chỉ dùng cho mode cloze_craft' });
    }
    if (body.options?.direction !== undefined && body.mode !== 'flashcard') {
      ctx.addIssue({ code: 'custom', path: ['options', 'direction'], message: 'direction chỉ dùng cho mode flashcard' });
    }
  });

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
    const options = parsed.data.options ?? {};

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

    // Create the session AND store the ordered queue (position 0 = first card shown) in ONE statement. last_activity_at and status
    // take their defaults (now, 'open').
    const { rows: sessionRows } = await pool.query(
      `WITH s AS (
         INSERT INTO practice_sessions (user_id, deck_id, mode, total_count, options)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id
       ), q AS (
         INSERT INTO practice_session_cards (session_id, position, card_id)
         SELECT s.id, t.pos - 1, t.card_id
           FROM s, unnest($6::uuid[]) WITH ORDINALITY AS t(card_id, pos)
       )
       SELECT id FROM s`,
      [userId, deck_id, mode, cards.length, JSON.stringify(options), cards.map((c) => c.card_id)]
    );
    const session_id: string = sessionRows[0].id;

    return apiSuccess(res, {
      session_id,
      mode,
      options,
      cards: cards.map(toSessionCard),
      total_count: cards.length,
    });
  })
);

/** The counters of a session as the answer endpoint reports them. */
interface SessionCounters {
  answered_count: number;
  total_count: number;
  correct_count: number;
  wrong_count: number;
}

/** What an answer was graded as: everything the answer response (first answer or repeat) is built from. */
interface AnswerOutcome {
  correct: boolean;
  grading: PracticeAnswerGradeResult;
  requiresEnglish: boolean;
  englishGrading: PracticeAnswerGradeResult | null;
}

/**
 * The stored answer to a card of a session ($1 = session, $2 = card) with the counters of the session, read in ONE statement so the
 * two come from the same snapshot (a repeat is answered with "n/total" that includes this answer, never the count from before it).
 */
const STORED_ANSWER_SQL = `
  SELECT pa.correct, pa.grading_source, pa.verdict, pa.confidence, pa.matched_answer, pa.accepted_answers, pa.grading_details,
         s.answered_count, s.total_count, s.correct_count, s.wrong_count
    FROM practice_answers pa
    JOIN practice_sessions s ON s.id = pa.session_id
   WHERE pa.session_id = $1 AND pa.card_id = $2`;

/**
 * The outcome of an answer from the row that was stored for it, in the shape the first response had. Rows written before the grading
 * columns existed (migration 29) have NULL there: they were client-graded. `confidence` is NUMERIC, which pg returns as text. The
 * English accepted answers were not stored before this endpoint became idempotent: [] for those.
 */
function answerOutcomeFromRow(row: any): AnswerOutcome {
  const details = row.grading_details ?? {};
  const toGrade = (g: any, correct: boolean): PracticeAnswerGradeResult => ({
    correct,
    verdict: g.verdict ?? (correct ? 'correct' : 'wrong'),
    confidence: g.confidence == null ? 1 : Number(g.confidence),
    grading_source: g.grading_source ?? 'client_legacy',
    matched_answer: g.matched_answer ?? null,
    accepted_answers: Array.isArray(g.accepted_answers) ? g.accepted_answers : [],
    reason_vi: g.reason_vi ?? null,
    details: {},
  });
  const english = details.english ?? null;
  return {
    correct: row.correct,
    grading: toGrade({ ...row, reason_vi: details.reason_vi }, row.correct),
    requiresEnglish: details.requires_english_meaning === true,
    englishGrading: english ? toGrade(english, english.correct === true) : null,
  };
}

/** The body of a successful answer response (a first answer, or a repeat with `already_answered`). */
function answerResponseBody(counters: SessionCounters, outcome: AnswerOutcome, alreadyAnswered: boolean) {
  const { grading, englishGrading } = outcome;
  return {
    progress: `${counters.answered_count}/${counters.total_count}`,
    correct_so_far: counters.correct_count,
    wrong_so_far: counters.wrong_count,
    grading: {
      correct: outcome.correct,
      verdict: grading.verdict,
      confidence: grading.confidence,
      grading_source: grading.grading_source,
      matched_answer: grading.matched_answer,
      accepted_answers: grading.accepted_answers,
      reason_vi: grading.reason_vi,
    },
    requires_english_meaning: outcome.requiresEnglish,
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
    ...(alreadyAnswered ? { already_answered: true } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/practice/session/answer
//  body:
//    Legacy client-graded: { session_id, card_id, correct, time_ms?, user_answer? }
//    Typed answer:         { session_id, card_id, user_answer, user_answer_en?, time_ms? }
//
//  Cards already in Leitner box 4/5 (`requires_english_meaning` in session/start)
//  are only `correct` when BOTH `user_answer` (Vietnamese) and `user_answer_en`
//  (English meaning) are right.
//
//  Idempotent per (session_id, card_id): a session answers a card ONCE. The mobile app re-sends an answer after a timeout or a crash,
//  and resumes sessions hours later. A repeat is answered with the STORED result plus `already_answered: true`, without grading
//  again (no model call) and without touching the counters or the card progress. The UNIQUE index of migration 35 is the arbiter
//  when two copies of the same answer arrive at once.
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

    // Fetch and validate the session, find the card and look for an answer to it already: independent reads, asked together. A typed
    // answer needs the card anyway, with what the grader compares it with, so that one read also tells whether the card exists; a
    // client-graded answer only checks. The stored answer is only used when the session turns out to be the user's and still open.
    const [{ rows: sessionRows }, { rows: storedRows }, cardToGrade, cardExists] = await Promise.all([
      pool.query(
        `SELECT id, user_id, status, total_count, answered_count, correct_count, wrong_count, completed_at
         FROM practice_sessions WHERE id = $1`,
        [session_id]
      ),
      pool.query(STORED_ANSWER_SQL, [session_id, card_id]),
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
    if (sessionRows[0].status !== 'open' || sessionRows[0].completed_at !== null) {
      return apiError(res, 400, 'SESSION_ALREADY_COMPLETED', 'Session đã hoàn thành');
    }
    // Answered already (a retry, or a resumed session): the stored result, nothing is graded or counted again.
    if (storedRows.length > 0) {
      return apiSuccess(res, answerResponseBody(storedRows[0], answerOutcomeFromRow(storedRows[0]), true));
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
    // one after the other, and could half-apply. The INSERT is the claim: ON CONFLICT (session_id, card_id) DO NOTHING, and the
    // counters and the progress move only when it really inserted a row (they read `ans`, not a snapshot), so two copies of the same
    // answer sent at once count once. The counters come back from the UPDATE.
    const { rows: written } = await pool.query(
      `WITH ans AS (
         INSERT INTO practice_answers
           (session_id, card_id, correct, time_ms, user_answer,
            grading_source, verdict, confidence, matched_answer, accepted_answers, grading_details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (session_id, card_id) DO NOTHING
         RETURNING id
       ), upd AS (
         UPDATE practice_sessions
            SET answered_count   = answered_count + 1,
                correct_count    = correct_count  + $13::int,
                wrong_count      = wrong_count    + (1 - $13::int),
                last_activity_at = NOW()
          WHERE id = $1 AND user_id = $12 AND EXISTS (SELECT 1 FROM ans)
      RETURNING answered_count, correct_count, wrong_count, total_count
       ), prog AS (
         -- Track card progress (idempotent — creates row if missing)
         INSERT INTO user_card_progress (user_id, card_id, times_seen, times_correct, first_seen_at)
         SELECT $12::uuid, $2::uuid, 1, $13::int, NOW()
          WHERE EXISTS (SELECT 1 FROM ans)
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
                accepted_answers: englishGrading.accepted_answers,
                reason_vi: englishGrading.reason_vi,
              }
            : null,
        }),
        userId,
        finalCorrect ? 1 : 0,
      ]
    );

    if (written.length === 0) {
      // Nothing was inserted: another copy of this answer won the INSERT between our read and our write (it is committed by now, or
      // the INSERT would have waited for it). Answer like any repeat: with the stored result of the winner.
      const { rows: raced } = await pool.query(STORED_ANSWER_SQL, [session_id, card_id]);
      if (raced.length === 0) {
        return apiError(res, 404, 'CARD_NOT_FOUND', 'Card không tồn tại');
      }
      return apiSuccess(res, answerResponseBody(raced[0], answerOutcomeFromRow(raced[0]), true));
    }

    return apiSuccess(
      res,
      answerResponseBody(written[0], { correct: finalCorrect, grading, requiresEnglish: needsEnglish, englishGrading }, false)
    );
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/practice/session/complete
//  body: { session_id }
//
//  Marks the session completed (status 'completed') and applies its correct answers to Leitner, in ONE statement with the claim
//  (closePracticeSession). XP: 10 per correct answer + 20 completion bonus, the bonus only when something was answered.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/session/complete',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const { session_id } = req.body as { session_id: string };

    if (!session_id) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'session_id là bắt buộc');
    }

    const out = await closePracticeSession({ sessionId: session_id, userId: req.user!.id, kind: 'complete' });
    if (out.outcome === 'not_found') return apiError(res, 404, 'SESSION_NOT_FOUND', 'Session không tồn tại');
    if (out.outcome === 'already_closed') return apiError(res, 400, 'SESSION_ALREADY_COMPLETED', 'Session đã hoàn thành');
    return apiSuccess(res, out.body);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/practice/session/abandon
//  body: { session_id }
//
//  "Start a new one": closes an open session WITHOUT the completion bonus. The same claim and the same Leitner application as
//  /complete (closePracticeSession): the correct answers still count, once. status 'abandoned', abandoned_at = now(); no activity is
//  logged and the streak is untouched. A session with no answers is simply closed (200, nothing applied). A session that is already
//  closed (completed, abandoned, expired) is 400 SESSION_ALREADY_COMPLETED. Response: the shape of /complete, with xp_earned 0.
// ─────────────────────────────────────────────────────────────────────────────
const sessionIdBodySchema = z.object({
  session_id: z.string().uuid({ message: 'session_id phải là UUID hợp lệ' }),
});

router.post(
  '/session/abandon',
  validateBody(sessionIdBodySchema),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const { session_id } = req.body as z.infer<typeof sessionIdBodySchema>;
    const out = await closePracticeSession({ sessionId: session_id, userId: req.user!.id, kind: 'abandon' });
    if (out.outcome === 'not_found') return apiError(res, 404, 'SESSION_NOT_FOUND', 'Session không tồn tại');
    if (out.outcome === 'already_closed') return apiError(res, 400, 'SESSION_ALREADY_COMPLETED', 'Session đã hoàn thành');
    return apiSuccess(res, out.body);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/practice/session/active
//  { session: null } or { session: <payload> }: the user's most recently active RESUMABLE session — open, touched within the last
//  7 days, something answered, at least one card of its queue unanswered. (Declared before /session/:id.)
//
//  GET /api/v1/practice/session/:id
//  The payload of one of the user's sessions, any status (completed ones too). Somebody else's session, one that does not exist and
//  an id that is not a UUID are all 404 SESSION_NOT_FOUND.
//
//  Payload: { session_id, deck_id, deck_title, mode, options, status, total_count, answered_count, correct_count, wrong_count,
//             started_at, last_activity_at, completed_at, cards (as in /session/start, in the stored order),
//             answers: [{ card_id, correct, time_ms, user_answer }], next_card_id }
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/session/active',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    return apiSuccess(res, { session: await getActivePracticeSession(req.user!.id) });
  })
);

router.get(
  '/session/:id',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      return apiError(res, 404, 'SESSION_NOT_FOUND', 'Session không tồn tại');
    }
    const session = await getPracticeSession(req.user!.id, id.data);
    if (!session) return apiError(res, 404, 'SESSION_NOT_FOUND', 'Session không tồn tại');
    return apiSuccess(res, session);
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
