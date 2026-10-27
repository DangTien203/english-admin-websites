import pool from '../config/db';
import { Queryable, moveCard } from '../utils/leitnerManager';
import { shuffleArray } from '../utils/questionHelpers';
import {
  QueueStep,
  ReviewCheck,
  buildReviewSequence,
  minStepsBetweenChecks,
} from '../utils/leitnerReviewQueue';
import {
  PracticeAnswerGradeResult,
  gradeLeitnerAnswer,
  gradeLeitnerEnglishAnswer,
  requiresEnglishMeaning,
} from './answerGradingService';

/**
 * Leitner review sessions.
 *
 * A session is a server-ordered list of steps (see utils/leitnerReviewQueue.ts):
 * words in box 4/5 own two steps — English meaning, then Vietnamese meaning, at
 * least MIN_STEPS_BETWEEN_CHECKS steps apart — every other word owns one.
 * Steps must be answered in order. A word's Leitner box moves exactly once, when
 * its last step is answered:
 *   every check right          → up one box ("advance")
 *   box 4/5, exactly one right → stays in its box ("hold")
 *   no check right             → back to box 1 ("reset")
 * Summaries count words, never steps.
 */

export class LeitnerSessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'LeitnerSessionError';
  }
}

export type WordResult = 'advance' | 'hold' | 'reset';

export interface WordOutcome {
  /** Every check of the word was right (= result "advance"). */
  correct: boolean;
  /** Absent on outcomes stored before the "hold" rule existed — use resultOf(). */
  result?: WordResult;
  /** false → the card was already reviewed elsewhere, so its box was left alone. */
  applied: boolean;
  old_box_number: number;
  new_box_number: number | null;
  next_due_at: Date | null;
  mastered_now: boolean;
}

interface SessionRow {
  id: string;
  /** null → "review due now" session; 1–5 → session built from that box. */
  box_number: number | null;
  total_words: number;
  total_steps: number;
  started_at: Date;
  completed_at: Date | null;
}

interface StepRow {
  id: string;
  step_index: number;
  leitner_card_id: string;
  check_lang: ReviewCheck;
  check_number: number;
  checks_total: number;
  start_box: number;
  /** null for steps created before migration 32 (no "reviewed elsewhere" guard). */
  start_total_reviews: number | null;
  answered_at: Date | null;
  correct: boolean | null;
  time_ms: number | null;
  word_outcome: WordOutcome | null;
}

export interface AnswerStepInput {
  sessionId: string;
  stepIndex: number;
  /** Typed answer: the meaning asked by the step (`check`). Server-graded. */
  userAnswer?: string;
  /** Client-graded result. Only accepted for single-check words (box 1–3). */
  correct?: boolean;
  timeMs?: number;
}

const sessionNotFound = () =>
  new LeitnerSessionError(404, 'SESSION_NOT_FOUND', 'Session không tồn tại');

const sessionCompleted = () =>
  new LeitnerSessionError(400, 'SESSION_ALREADY_COMPLETED', 'Session đã hoàn thành');

async function fetchOwnedSession(
  db: Queryable,
  sessionId: string,
  userId: string,
  lock = false
): Promise<SessionRow | null> {
  const { rows } = await db.query(
    `SELECT id, box_number, total_words, total_steps, started_at, completed_at
       FROM leitner_review_sessions
      WHERE id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [sessionId, userId]
  );
  return rows[0] ?? null;
}

async function loadSteps(db: Queryable, sessionId: string): Promise<StepRow[]> {
  const { rows } = await db.query(
    `SELECT id, step_index, leitner_card_id, check_lang, check_number, checks_total,
            start_box, start_total_reviews, answered_at, correct, time_ms, word_outcome
       FROM leitner_review_steps
      WHERE session_id = $1
      ORDER BY step_index`,
    [sessionId]
  );
  return rows;
}

/** Steps are answered strictly in order — that is what keeps the two checks of a word apart. */
function assertAnswerable(steps: StepRow[], stepIndex: number): StepRow {
  const step = steps.find((s) => s.step_index === stepIndex);
  if (!step) {
    throw new LeitnerSessionError(404, 'STEP_NOT_FOUND', 'Bước không tồn tại');
  }
  if (step.answered_at) {
    throw new LeitnerSessionError(409, 'STEP_ALREADY_ANSWERED', 'Bước này đã được trả lời');
  }
  const expected = steps.find((s) => !s.answered_at)!;
  if (expected.step_index !== stepIndex) {
    throw new LeitnerSessionError(
      409,
      'STEP_OUT_OF_ORDER',
      'Phải trả lời theo đúng thứ tự các bước',
      { expected_step_index: expected.step_index }
    );
  }
  return step;
}

function computeProgress(
  steps: { step_index: number; answered_at: Date | null; word_outcome: unknown }[],
  totalWords: number
) {
  const next = steps.find((s) => !s.answered_at);
  return {
    answered_steps: steps.filter((s) => s.answered_at).length,
    total_steps: steps.length,
    resolved_words: steps.filter((s) => s.word_outcome).length,
    total_words: totalWords,
    next_step_index: next ? next.step_index : null,
  };
}

function toGradingPayload(grading: PracticeAnswerGradeResult | null, correct: boolean) {
  return grading
    ? {
        correct,
        verdict: grading.verdict,
        confidence: grading.confidence,
        grading_source: grading.grading_source,
        matched_answer: grading.matched_answer,
        accepted_answers: grading.accepted_answers,
        reason_vi: grading.reason_vi,
      }
    : {
        correct,
        verdict: correct ? 'correct' : 'wrong',
        confidence: 1,
        grading_source: 'client_legacy',
        matched_answer: null,
        accepted_answers: [],
        reason_vi: null,
      };
}

// ── start / get ──────────────────────────────────────────────────────────────

/**
 * Only DUE words are ever reviewed — a word that is not due yet must not move up a box, or finishing
 * one box and opening the next would let the learner re-review (and re-promote) the same words.
 *
 * @param limit     number of words (not steps); fewer are used when fewer are due
 * @param boxNumber omitted → every box ("review due now"). 1–5 → only the due words of that box.
 *                  Either way the most overdue come first, and the picked words are shuffled
 *                  before ordering.
 */
export async function startReviewSession(userId: string, limit: number, boxNumber?: number) {
  const { rows: picked } = await pool.query(
    `SELECT id, box_number, COALESCE(total_reviews, 0) AS total_reviews
       FROM leitner_cards
      WHERE user_id = $1 AND due_at <= NOW() AND ($3::int IS NULL OR box_number = $3::int)
      ORDER BY due_at ASC
      LIMIT $2`,
    [userId, limit, boxNumber ?? null]
  );
  if (picked.length === 0) {
    throw new LeitnerSessionError(
      400,
      'NO_DUE_CARDS',
      boxNumber ? `Box ${boxNumber} chưa có từ nào đến hạn ôn tập` : 'Không có thẻ nào đến hạn ôn tập',
      boxNumber ? { box_number: boxNumber } : undefined
    );
  }

  const cardById = new Map<string, { box_number: number; total_reviews: number }>(
    picked.map((r: any) => [r.id, r])
  );
  const words = shuffleArray(picked).map((r: any) => ({
    id: r.id as string,
    dual: requiresEnglishMeaning(r.box_number),
  }));
  const sequence = buildReviewSequence(words);

  const client = await pool.connect();
  let sessionId: string;
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO leitner_review_sessions (user_id, box_number, total_words, total_steps)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, boxNumber ?? null, picked.length, sequence.length]
    );
    sessionId = rows[0].id;

    await client.query(
      `INSERT INTO leitner_review_steps
         (session_id, step_index, leitner_card_id, check_lang, check_number, checks_total,
          start_box, start_total_reviews)
       SELECT $1::uuid, v.step_index, v.card_id, v.check_lang, v.check_number, v.checks_total,
              v.start_box, v.start_total_reviews
         FROM unnest($2::int[], $3::uuid[], $4::text[], $5::int[], $6::int[], $7::int[], $8::int[])
           AS v(step_index, card_id, check_lang, check_number, checks_total, start_box, start_total_reviews)`,
      [
        sessionId,
        sequence.map((_, i) => i),
        sequence.map((s) => s.wordId),
        sequence.map((s) => s.check),
        sequence.map((s) => s.checkNumber),
        sequence.map((s) => s.checksTotal),
        sequence.map((s) => cardById.get(s.wordId)!.box_number),
        sequence.map((s) => cardById.get(s.wordId)!.total_reviews),
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  return getReviewSession(userId, sessionId);
}

export async function getReviewSession(userId: string, sessionId: string) {
  const session = await fetchOwnedSession(pool, sessionId, userId);
  if (!session) throw sessionNotFound();

  // The entry preview deliberately carries no meaning: the learner has to recall it.
  const { rows } = await pool.query(
    `SELECT s.step_index, s.leitner_card_id, s.check_lang, s.check_number, s.checks_total,
            s.start_box, s.answered_at, s.correct, s.word_outcome,
            lc.entry_id, de.headword, de.lemma, de.ipa_us, de.ipa_uk,
            de.audio_us_url, de.audio_uk_url, de.pos, de.cefr_level
       FROM leitner_review_steps s
       JOIN leitner_cards lc ON lc.id = s.leitner_card_id
       JOIN dictionary_entries de ON de.id = lc.entry_id
      WHERE s.session_id = $1
      ORDER BY s.step_index`,
    [sessionId]
  );

  const queue: QueueStep[] = rows.map((r: any) => ({
    wordId: r.leitner_card_id,
    check: r.check_lang,
    checkNumber: r.check_number,
    checksTotal: r.checks_total,
  }));

  return {
    session_id: session.id,
    box_number: session.box_number,
    total_words: session.total_words,
    total_steps: session.total_steps,
    completed: session.completed_at !== null,
    min_steps_between_checks: minStepsBetweenChecks(queue),
    progress: computeProgress(rows, session.total_words),
    steps: rows.map((r: any) => ({
      step_index: r.step_index,
      leitner_card_id: r.leitner_card_id,
      entry_id: r.entry_id,
      check: r.check_lang as ReviewCheck,
      check_number: r.check_number,
      checks_total: r.checks_total,
      box_number: r.start_box,
      typed_answer_required: r.checks_total === 2,
      answered: r.answered_at !== null,
      correct: r.correct,
      entry: {
        id: r.entry_id,
        headword: r.headword,
        lemma: r.lemma ?? null,
        ipa_us: r.ipa_us ?? null,
        ipa_uk: r.ipa_uk ?? null,
        audio_us_url: r.audio_us_url ?? null,
        audio_uk_url: r.audio_uk_url ?? null,
        pos: r.pos ?? [],
        cefr_level: r.cefr_level ?? null,
      },
    })),
  };
}

// ── answer ───────────────────────────────────────────────────────────────────

function resultOf(outcome: WordOutcome): WordResult {
  return outcome.result ?? (outcome.correct ? 'advance' : 'reset');
}

async function finalizeWord(
  db: Queryable,
  userId: string,
  target: StepRow,
  wordSteps: StepRow[]
): Promise<WordOutcome> {
  const rightChecks = wordSteps.filter((s) => s.correct === true).length;
  const result: WordResult =
    rightChecks === wordSteps.length ? 'advance' : rightChecks === 0 ? 'reset' : 'hold';
  const correct = result === 'advance';
  const totalMs = wordSteps.reduce((sum, s) => sum + (s.time_ms ?? 0), 0);

  try {
    const moved = await moveCard(
      target.leitner_card_id,
      userId,
      result !== 'reset',
      totalMs > 0 ? totalMs : undefined,
      { db, expectedTotalReviews: target.start_total_reviews, hold: result === 'hold' }
    );
    return {
      correct,
      result,
      applied: true,
      old_box_number: target.start_box,
      new_box_number: moved.newBoxNumber,
      next_due_at: moved.nextDueAt,
      mastered_now: moved.masteredNow,
    };
  } catch (err: any) {
    // 409: the card was reviewed elsewhere since the session started (another session,
    // a practice run…) → don't move the same card twice.
    if (err.statusCode === 409 || err.statusCode === 404) {
      return {
        correct,
        result,
        applied: false,
        old_box_number: target.start_box,
        new_box_number: null,
        next_due_at: null,
        mastered_now: false,
      };
    }
    throw err;
  }
}

export async function answerReviewStep(userId: string, input: AnswerStepInput) {
  const { sessionId, stepIndex, userAnswer, correct, timeMs } = input;

  const session = await fetchOwnedSession(pool, sessionId, userId);
  if (!session) throw sessionNotFound();
  if (session.completed_at) throw sessionCompleted();

  // Cheap checks first, so a bad request never costs an OpenAI call.
  const step = assertAnswerable(await loadSteps(pool, sessionId), stepIndex);

  if (userAnswer === undefined && step.checks_total === 2) {
    throw new LeitnerSessionError(
      400,
      'TYPED_ANSWER_REQUIRED',
      'Từ ở box 4/5 phải trả lời bằng user_answer (nghĩa tiếng Anh / tiếng Việt), không dùng correct'
    );
  }

  // Grade outside the transaction — it may call OpenAI.
  let grading: PracticeAnswerGradeResult | null = null;
  let stepCorrect: boolean;
  if (userAnswer !== undefined) {
    try {
      grading =
        step.check_lang === 'en'
          ? await gradeLeitnerEnglishAnswer(step.leitner_card_id, userId, userAnswer)
          : await gradeLeitnerAnswer(step.leitner_card_id, userId, userAnswer);
    } catch (err: any) {
      if (err.statusCode === 404) {
        throw new LeitnerSessionError(404, 'CARD_NOT_FOUND', 'Leitner card không tồn tại');
      }
      throw err;
    }
    stepCorrect = grading.correct;
  } else {
    stepCorrect = correct!;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Locking the session row applies the answers of one session one at a time.
    const locked = await fetchOwnedSession(client, sessionId, userId, true);
    if (!locked) throw sessionNotFound();
    if (locked.completed_at) throw sessionCompleted();

    const steps = await loadSteps(client, sessionId);
    const target = assertAnswerable(steps, stepIndex);

    target.answered_at = new Date();
    target.correct = stepCorrect;
    target.time_ms = timeMs ?? null;

    const wordSteps = steps.filter((s) => s.leitner_card_id === target.leitner_card_id);
    const outcome = wordSteps.every((s) => s.answered_at)
      ? await finalizeWord(client, userId, target, wordSteps)
      : null;
    target.word_outcome = outcome;

    await client.query(
      `UPDATE leitner_review_steps
          SET answered_at = NOW(), correct = $2, user_answer = $3, time_ms = $4,
              grading = $5, word_outcome = $6
        WHERE id = $1`,
      [
        target.id,
        stepCorrect,
        userAnswer ?? null,
        timeMs ?? null,
        grading ? JSON.stringify(grading) : null,
        outcome ? JSON.stringify(outcome) : null,
      ]
    );

    await client.query('COMMIT');

    return {
      step_index: stepIndex,
      check: target.check_lang,
      grading: toGradingPayload(grading, stepCorrect),
      word: {
        leitner_card_id: target.leitner_card_id,
        checks_total: target.checks_total,
        checks_done: wordSteps.filter((s) => s.answered_at).length,
        checks_correct: wordSteps.filter((s) => s.correct).length,
        resolved: outcome !== null,
        correct: outcome ? outcome.correct : null,
        result: outcome ? resultOf(outcome) : null,
        applied: outcome ? outcome.applied : null,
        new_box_number: outcome ? outcome.new_box_number : null,
        next_due_at: outcome ? outcome.next_due_at : null,
        mastered_now: outcome ? outcome.mastered_now : false,
      },
      progress: computeProgress(steps, locked.total_words),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── complete ─────────────────────────────────────────────────────────────────

export async function completeReviewSession(userId: string, sessionId: string) {
  // Claiming the session here also waits for any answer still being applied.
  const { rows: claimed } = await pool.query(
    `UPDATE leitner_review_sessions
        SET completed_at  = NOW(),
            time_total_ms = LEAST(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000, 2147483647)::int
      WHERE id = $1 AND user_id = $2 AND completed_at IS NULL
      RETURNING total_words, time_total_ms`,
    [sessionId, userId]
  );
  if (claimed.length === 0) {
    const existing = await fetchOwnedSession(pool, sessionId, userId);
    throw existing ? sessionCompleted() : sessionNotFound();
  }
  const session = claimed[0];

  // One row per original word — a box 4/5 word counts once, not once per check.
  const { rows } = await pool.query(
    `SELECT s.leitner_card_id, lc.entry_id, de.headword,
            MIN(s.step_index)::int AS first_step_index,
            MIN(s.start_box)::int AS start_box,
            COUNT(*)::int AS checks_total,
            (COUNT(*) FILTER (WHERE s.answered_at IS NOT NULL))::int AS checks_done,
            (COUNT(*) FILTER (WHERE s.correct))::int AS checks_correct,
            (ARRAY_AGG(s.word_outcome) FILTER (WHERE s.word_outcome IS NOT NULL))[1] AS outcome
       FROM leitner_review_steps s
       JOIN leitner_cards lc ON lc.id = s.leitner_card_id
       JOIN dictionary_entries de ON de.id = lc.entry_id
      WHERE s.session_id = $1
      GROUP BY s.leitner_card_id, lc.entry_id, de.headword
      ORDER BY first_step_index`,
    [sessionId]
  );

  const words = rows.map((r: any) => {
    const outcome: WordOutcome | null = r.outcome;
    const result = outcome ? resultOf(outcome) : null;
    return {
      leitner_card_id: r.leitner_card_id,
      entry_id: r.entry_id,
      headword: r.headword,
      // correct = every check right, partial = box 4/5 word with one meaning right (box kept),
      // wrong = nothing right (back to box 1), skipped = not all its steps were answered.
      status: result
        ? ({ advance: 'correct', hold: 'partial', reset: 'wrong' } as const)[result]
        : 'skipped',
      result,
      correct: outcome ? outcome.correct : null,
      checks: { total: r.checks_total, done: r.checks_done, correct: r.checks_correct },
      old_box_number: r.start_box,
      new_box_number: outcome ? outcome.new_box_number : null,
      next_due_at: outcome ? outcome.next_due_at : null,
      mastered_now: outcome ? outcome.mastered_now : false,
    };
  });

  const correctWords = words.filter((w) => w.status === 'correct').length;
  const partialWords = words.filter((w) => w.status === 'partial').length;
  const wrongWords = words.filter((w) => w.status === 'wrong').length;
  const answeredWords = correctWords + partialWords + wrongWords;

  return {
    session_id: sessionId,
    summary: {
      total_words: session.total_words,
      correct_words: correctWords,
      partial_words: partialWords,
      wrong_words: wrongWords,
      skipped_words: words.length - answeredWords,
      accuracy: answeredWords > 0 ? Math.round((correctWords / answeredWords) * 100) / 100 : 0,
      mastered_now: words.filter((w) => w.mastered_now).length,
      time_total_ms: session.time_total_ms,
    },
    words,
  };
}
