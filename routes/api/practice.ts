import { Router, Response } from 'express';
import { z } from 'zod';
import pool from '../../config/db';
import { ApiRequest } from '../../middlewares/apiAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { apiSuccess, apiError } from '../../utils/apiResponse';
import { applyPracticeCorrectAnswers } from '../../utils/leitnerManager';
import { updateStreak } from '../../utils/streakCalculator';
import { parsePagination } from '../../utils/pagination';
import {
  gradePracticeCard,
  requiresEnglishMeaning,
  PracticeAnswerGradeResult,
} from '../../services/answerGradingService';

const router = Router();

// ── Shared SQL helpers ────────────────────────────────────────────────────────

const VI_COALESCE = `COALESCE(
  (SELECT es.definition_vi FROM entry_senses es
   WHERE es.entry_id = de.id AND es.definition_vi IS NOT NULL
   ORDER BY es.sense_order ASC LIMIT 1),
  de.meaning_vi
)`;

const HAS_VI = `(de.meaning_vi IS NOT NULL OR EXISTS (
  SELECT 1 FROM entry_senses es
  WHERE es.entry_id = de.id AND es.definition_vi IS NOT NULL
))`;

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function maskWord(sentence: string, word: string): string {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sentence.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '___');
}

function findWordInSentence(
  sentence: string,
  candidates: string[]
): { form: string } | null {
  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = sentence.match(new RegExp(`\\b${escaped}\\b`, 'i'));
    if (match) return { form: match[0] };
  }
  return null;
}

const VALID_MODES = ['flashcard', 'swift_choice', 'cloze_craft', 'pair_link'] as const;
type PracticeMode = (typeof VALID_MODES)[number];

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

    // Verify deck access
    const { rows: deckRows } = await pool.query(
      `SELECT id FROM decks
       WHERE id = $1 AND (user_id = $2 OR deck_type IN ('premade','system_generated'))`,
      [deck_id, userId]
    );
    if (deckRows.length === 0) {
      return apiError(res, 404, 'DECK_NOT_FOUND', 'Deck không tồn tại');
    }

    // ── Card selection ────────────────────────────────────────────────────────
    // Manual selection wins over random when both provided.
    let cards: any[];

    if (card_ids && card_ids.length > 0) {
      // Dedupe silently (per spec — duplicates are not an error).
      const uniqueIds = Array.from(new Set(card_ids));

      // Cross-check: all ids must belong to this deck.
      const { rows: validRows } = await pool.query(
        `SELECT id FROM cards WHERE deck_id = $1 AND id = ANY($2::uuid[])`,
        [deck_id, uniqueIds]
      );
      const validSet = new Set(validRows.map((r: any) => r.id as string));
      const invalidIds = uniqueIds.filter((id) => !validSet.has(id));
      if (invalidIds.length > 0) {
        return apiError(
          res,
          400,
          'INVALID_CARDS',
          'Một số thẻ không thuộc bộ thẻ này',
          { invalid_card_ids: invalidIds }
        );
      }

      // Manual selection bypasses the mastered filter — user explicitly picked these.
      ({ rows: cards } = await pool.query(
        `SELECT
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
         LEFT JOIN leitner_cards lc ON lc.entry_id = c.entry_id AND lc.user_id = $2
         WHERE c.deck_id = $1 AND c.id = ANY($3::uuid[])`,
        [deck_id, userId, uniqueIds]
      ));
    } else {
      // Random selection: unlearned words (no Leitner card) first, then learned words
      // (any box 1–5, mastered included) to top up to `limit`. Both groups are random
      // (RANDOM() tie-break inside each group); the final list is shuffled so new and
      // review words are mixed. If the deck has fewer than `limit` cards, return all
      // of them (no error — mobile shows snackbar with the actual count).
      const safeLimit = Math.min(100, Math.max(1, limit ?? 20));
      ({ rows: cards } = await pool.query(
        `SELECT
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
         LEFT JOIN leitner_cards lc ON lc.entry_id = c.entry_id AND lc.user_id = $2
         WHERE c.deck_id = $1
         ORDER BY (lc.id IS NOT NULL), RANDOM()
         LIMIT $3`,
        [deck_id, userId, safeLimit]
      ));
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

    // Fetch and validate session
    const { rows: sessionRows } = await pool.query(
      `SELECT id, user_id, total_count, answered_count, correct_count, wrong_count, completed_at
       FROM practice_sessions WHERE id = $1`,
      [session_id]
    );
    if (sessionRows.length === 0 || sessionRows[0].user_id !== userId) {
      return apiError(res, 404, 'SESSION_NOT_FOUND', 'Session không tồn tại');
    }
    if (sessionRows[0].completed_at !== null) {
      return apiError(res, 400, 'SESSION_ALREADY_COMPLETED', 'Session đã hoàn thành');
    }

    // Verify card exists
    const { rows: cardRows } = await pool.query(
      `SELECT id FROM cards WHERE id = $1`, [card_id]
    );
    if (cardRows.length === 0) {
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
      const cardGrade = await gradePracticeCard(
        card_id,
        userId,
        user_answer ?? '',
        typeof user_answer_en === 'string' ? user_answer_en : undefined
      );
      grading = cardGrade.vi;
      englishGrading = cardGrade.en;
      needsEnglish = cardGrade.requires_english_meaning;
      finalCorrect = cardGrade.correct;
    }

    // Record answer
    await pool.query(
      `INSERT INTO practice_answers
         (session_id, card_id, correct, time_ms, user_answer,
          grading_source, verdict, confidence, matched_answer, accepted_answers, grading_details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
      ]
    );

    // Update session counters
    const { rows: updated } = await pool.query(
      `UPDATE practice_sessions
       SET answered_count = answered_count + 1,
           correct_count  = correct_count  + $3::int,
           wrong_count    = wrong_count    + (1 - $3::int)
       WHERE id = $1 AND user_id = $2
       RETURNING answered_count, correct_count, wrong_count, total_count`,
      [session_id, userId, finalCorrect ? 1 : 0]
    );
    const s = updated[0];

    // Track card progress (idempotent — creates row if missing)
    await pool.query(
      `INSERT INTO user_card_progress (user_id, card_id, times_seen, times_correct, first_seen_at)
       VALUES ($1, $2, 1, $3, NOW())
       ON CONFLICT (user_id, card_id) DO UPDATE SET
         times_seen    = user_card_progress.times_seen + 1,
         times_correct = user_card_progress.times_correct + $3,
         last_review   = NOW(),
         updated_at    = NOW()`,
      [userId, card_id, finalCorrect ? 1 : 0]
    );

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

    const { rows: sessionRows } = await pool.query(
      `SELECT id, user_id, deck_id, mode, correct_count, wrong_count, total_count,
              started_at, completed_at
       FROM practice_sessions WHERE id = $1`,
      [session_id]
    );
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

    // Get distinct entry_ids for correctly-answered cards
    const { rows: correctRows } = await pool.query(
      `SELECT DISTINCT pa.card_id, c.entry_id
       FROM practice_answers pa
       JOIN cards c ON c.id = pa.card_id
       WHERE pa.session_id = $1 AND pa.correct = true`,
      [session_id]
    );
    const correctCardIds = [...new Set(correctRows.map((r: any) => r.card_id as string))];
    const correctEntryIds = [...new Set(correctRows.map((r: any) => r.entry_id as string))];

    // Correct entries: new words → Leitner box 1, words already in a box → next box.
    // (`correct` already means "Vietnamese AND English right" for box 4/5 cards.)
    const leitnerResult = await applyPracticeCorrectAnswers(userId, correctEntryIds, session.mode);

    // Mark session complete
    await pool.query(
      `UPDATE practice_sessions
       SET completed_at = NOW(), time_total_ms = $2, xp_earned = $3
       WHERE id = $1`,
      [session_id, timeTotalMs, xpEarned]
    );

    // Log activity
    await pool.query(
      `INSERT INTO user_activity_log (user_id, action, details)
       VALUES ($1, 'practice_session', $2)`,
      [userId, JSON.stringify({
        mode: session.mode,
        deck_id: session.deck_id,
        session_id,
        correct_count: correctCount,
        xp_earned: xpEarned,
      })]
    );

    // Update streak
    let streakUpdated = false;
    try {
      await updateStreak(userId);
      streakUpdated = true;
    } catch {
      // Non-critical — don't fail the request
    }

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

    const DECK_ACCESS = `(d.user_id = $2 OR (d.deck_type IN ('premade','system_generated') AND d.status = 'published'))`;

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
    const posArray: string[] | null =
      Array.isArray(card.pos) && card.pos.length > 0 ? card.pos : null;

    const DISTRACTOR_SELECT = `
      SELECT ${VI_COALESCE} AS display_vi
      FROM dictionary_entries de`;
    let distractors: any[] = [];

    if (posArray) {
      ({ rows: distractors } = await pool.query(
        `${DISTRACTOR_SELECT}
         WHERE de.cefr_level = $1 AND de.id != $2 AND de.pos && $3::varchar[] AND ${HAS_VI}
         ORDER BY RANDOM() LIMIT 3`,
        [card.cefr_level, card.entry_id, posArray]
      ));
      if (distractors.length < 3) {
        ({ rows: distractors } = await pool.query(
          `${DISTRACTOR_SELECT}
           WHERE de.id != $1 AND de.pos && $2::varchar[] AND ${HAS_VI}
           ORDER BY RANDOM() LIMIT 3`,
          [card.entry_id, posArray]
        ));
      }
    } else {
      ({ rows: distractors } = await pool.query(
        `${DISTRACTOR_SELECT}
         WHERE de.cefr_level = $1 AND de.id != $2 AND ${HAS_VI}
         ORDER BY RANDOM() LIMIT 3`,
        [card.cefr_level, card.entry_id]
      ));
      if (distractors.length < 3) {
        ({ rows: distractors } = await pool.query(
          `${DISTRACTOR_SELECT}
           WHERE de.id != $1 AND ${HAS_VI}
           ORDER BY RANDOM() LIMIT 3`,
          [card.entry_id]
        ));
      }
    }

    if (distractors.length < 3) {
      return apiError(res, 422, 'INSUFFICIENT_DISTRACTORS', 'Không đủ distractors');
    }

    const { rows: exRows } = await pool.query(
      `SELECT se.example_en
       FROM sense_examples se
       JOIN entry_senses es ON es.id = se.sense_id
       WHERE es.entry_id = $1 AND se.example_en IS NOT NULL
       ORDER BY es.sense_order ASC, se.sort_order ASC LIMIT 1`,
      [card.entry_id]
    );

    const hintExample = exRows.length > 0
      ? `e.g., ${maskWord(exRows[0].example_en, card.headword)}`
      : null;

    const optionItems = shuffleArray([
      { text: card.correct_vi || '', correct: true },
      { text: distractors[0].display_vi || '', correct: false },
      { text: distractors[1].display_vi || '', correct: false },
      { text: distractors[2].display_vi || '', correct: false },
    ]);
    const options = optionItems.map((opt, idx) => ({ index: idx, text: opt.text }));
    const correct_index = optionItems.findIndex(opt => opt.correct);

    return apiSuccess(res, {
      card_id,
      question_type: 'meaning_from_word',
      prompt: { word: card.headword, ipa_us: card.ipa_us || null, pos: posArray?.[0] ?? null },
      hint_example: hintExample,
      options,
      correct_index,
    });
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

    const DECK_ACCESS = `(d.user_id = $2 OR (d.deck_type IN ('premade','system_generated') AND d.status = 'published'))`;

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

    const [{ rows: wfRows }, { rows: examples }] = await Promise.all([
      pool.query(`SELECT form_value, form_type FROM word_forms WHERE entry_id = $1`, [card.entry_id]),
      pool.query(
        `SELECT example_en FROM (
           SELECT se.example_en, 0 AS priority, es.sense_order, se.sort_order
           FROM sense_examples se
           JOIN entry_senses es ON es.id = se.sense_id
           WHERE es.entry_id = $1 AND se.example_en IS NOT NULL
           UNION ALL
           SELECT TRIM(unnest) AS example_en, 1 AS priority, 0 AS sense_order, ordinality::int AS sort_order
           FROM dictionary_entries de,
                LATERAL unnest(string_to_array(de.example_en, E'\\n')) WITH ORDINALITY AS unnest
           WHERE de.id = $1 AND de.example_en IS NOT NULL AND TRIM(unnest) != ''
         ) AS combined
         ORDER BY priority ASC, sense_order ASC, sort_order ASC`,
        [card.entry_id]
      ),
    ]);

    if (examples.length === 0) {
      return apiError(res, 422, 'NO_EXAMPLES', 'Card này không có câu ví dụ');
    }

    const wordForms: Array<{ value: string; type: string }> = wfRows.map((r: any) => ({
      value: r.form_value,
      type: r.form_type,
    }));
    const candidates = [
      card.headword,
      ...wordForms.sort((a, b) => b.value.length - a.value.length).map(wf => wf.value),
    ];

    let targetWord: string | null = null;
    let targetExample: string | null = null;
    let matchedFormType: string | null = null;

    for (const ex of shuffleArray(examples)) {
      const found = findWordInSentence(ex.example_en, candidates);
      if (found) {
        targetWord = found.form;
        targetExample = ex.example_en;
        const lowerForm = found.form.toLowerCase();
        const matchedWF = wordForms.find(wf => wf.value.toLowerCase() === lowerForm);
        matchedFormType = matchedWF ? matchedWF.type : null;
        break;
      }
    }

    if (!targetWord || !targetExample) {
      return apiError(res, 422, 'NO_EXAMPLES', 'Không tìm được câu ví dụ phù hợp');
    }

    const sentenceMasked = maskWord(targetExample, targetWord);
    const hintPos = Array.isArray(card.pos) && card.pos.length > 0 ? card.pos[0] : null;

    let wordChoices: string[] | null = null;
    let scrambledLetters: string[] | null = null;

    if (level === 1) {
      const { rows: wrongWords } = hintPos
        ? await pool.query(
            `SELECT de.headword FROM dictionary_entries de
             WHERE de.id != $1
             ORDER BY CASE WHEN $2 = ANY(de.pos) THEN 0 ELSE 1 END, RANDOM() LIMIT 3`,
            [card.entry_id, hintPos]
          )
        : await pool.query(
            `SELECT de.headword FROM dictionary_entries de
             WHERE de.id != $1 ORDER BY RANDOM() LIMIT 3`,
            [card.entry_id]
          );
      wordChoices = shuffleArray([targetWord, ...wrongWords.map((r: any) => r.headword as string)]);
    } else if (level === 2) {
      const CONSONANTS = 'bcdfghjklmnpqrstvwxyz';
      const letters = targetWord.split('');
      const decoyCount = letters.length <= 4 ? 1 : 2;
      for (let i = 0; i < decoyCount; i++) {
        letters.push(CONSONANTS[Math.floor(Math.random() * CONSONANTS.length)]);
      }
      scrambledLetters = shuffleArray(letters);
    }

    return apiSuccess(res, {
      card_id,
      level,
      target_word: targetWord,
      sentence_masked: sentenceMasked,
      sentence_full: targetExample,
      hint_pos: hintPos,
      hint_tense: matchedFormType,
      word_choices: wordChoices,
      scrambled_letters: scrambledLetters,
    });
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

    const { rows: deckRows } = await pool.query(
      `SELECT id FROM decks WHERE id = $1
       AND (user_id = $2 OR deck_type IN ('premade','system_generated'))`,
      [deck_id, userId]
    );
    if (deckRows.length === 0) {
      return apiError(res, 404, 'DECK_NOT_FOUND', 'Deck không tồn tại');
    }

    const safeCount = Math.min(10, Math.max(1, count || 5));

    const { rows } = await pool.query(
      `SELECT c.id AS card_id, de.headword, ${VI_COALESCE} AS vi_text
       FROM cards c
       JOIN dictionary_entries de ON de.id = c.entry_id
       LEFT JOIN leitner_cards lc ON lc.entry_id = c.entry_id AND lc.user_id = $2
       WHERE c.deck_id = $1
       ORDER BY ${PAIR_ORDER}
       LIMIT $3`,
      [deck_id, userId, safeCount]
    );

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
