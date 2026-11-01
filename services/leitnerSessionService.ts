import pool from '../config/db';
import { getIntervals, moveCardCtes } from '../utils/leitnerManager';
import { shuffleArray } from '../utils/questionHelpers';
import {
  QueueStep,
  ReviewCheck,
  buildReviewSequence,
  minStepsBetweenChecks,
} from '../utils/leitnerReviewQueue';
import {
  PracticeAnswerGradeResult,
  gradeLoadedLeitnerCard,
  gradeLoadedLeitnerEnglishCard,
  loadLeitnerCardForStepGrading,
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
  /** ISO 8601 (UTC, milliseconds): the text stored in word_outcome, which is also what the API serves. */
  next_due_at: string | null;
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

async function fetchOwnedSession(sessionId: string, userId: string): Promise<SessionRow | null> {
  const { rows } = await pool.query(
    `SELECT id, box_number, total_words, total_steps, started_at, completed_at
       FROM leitner_review_sessions
      WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  return rows[0] ?? null;
}

/** The session of this user with all its steps, in one round trip. null when there is no such session. */
async function loadSessionWithSteps(
  sessionId: string,
  userId: string
): Promise<{ session: SessionRow; steps: StepRow[] } | null> {
  const { rows } = await pool.query(
    `SELECT s.box_number AS session_box_number, s.total_words, s.total_steps, s.started_at, s.completed_at,
            st.id, st.step_index, st.leitner_card_id, st.check_lang, st.check_number, st.checks_total,
            st.start_box, st.start_total_reviews, st.answered_at, st.correct, st.time_ms, st.word_outcome
       FROM leitner_review_sessions s
       LEFT JOIN leitner_review_steps st ON st.session_id = s.id
      WHERE s.id = $1 AND s.user_id = $2
      ORDER BY st.step_index`,
    [sessionId, userId]
  );
  if (rows.length === 0) return null;

  const first = rows[0];
  const session: SessionRow = {
    id: sessionId,
    box_number: first.session_box_number,
    total_words: first.total_words,
    total_steps: first.total_steps,
    started_at: first.started_at,
    completed_at: first.completed_at,
  };
  const steps: StepRow[] = rows
    .filter((r: any) => r.id !== null)
    .map(({ session_box_number, total_words, total_steps, started_at, completed_at, ...step }: any) => step as StepRow);
  return { session, steps };
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

  // The session row and all its steps in ONE statement. A statement is atomic on its own, so this replaces BEGIN, two INSERTs and
  // COMMIT (four round trips, on a connection taken out of the pool for the purpose). The new steps come back joined with their
  // words — exactly the rows getReviewSession() reads — so the session is not read a second time.
  const { rows } = await pool.query(
    `WITH s AS (
       INSERT INTO leitner_review_sessions (user_id, box_number, total_words, total_steps)
       VALUES ($1, $2, $3, $4)
       RETURNING id, box_number, total_words, total_steps, started_at, completed_at
     ), st AS (
       INSERT INTO leitner_review_steps
         (session_id, step_index, leitner_card_id, check_lang, check_number, checks_total,
          start_box, start_total_reviews)
       SELECT s.id, v.step_index, v.card_id, v.check_lang, v.check_number, v.checks_total,
              v.start_box, v.start_total_reviews
         FROM s,
              unnest($5::int[], $6::uuid[], $7::text[], $8::int[], $9::int[], $10::int[], $11::int[])
                AS v(step_index, card_id, check_lang, check_number, checks_total, start_box, start_total_reviews)
       RETURNING session_id, step_index, leitner_card_id, check_lang, check_number, checks_total, start_box,
                 answered_at, correct, word_outcome
     )
     SELECT s.id AS session_id, s.box_number AS session_box_number, s.total_words, s.total_steps, s.started_at, s.completed_at,
            st.step_index, st.leitner_card_id, st.check_lang, st.check_number, st.checks_total, st.start_box,
            st.answered_at, st.correct, st.word_outcome,
            ${STEP_ENTRY_COLUMNS}
       FROM s
       JOIN st ON st.session_id = s.id
       JOIN leitner_cards lc ON lc.id = st.leitner_card_id
       JOIN dictionary_entries de ON de.id = lc.entry_id
      ORDER BY st.step_index`,
    [
      userId,
      boxNumber ?? null,
      picked.length,
      sequence.length,
      sequence.map((_, i) => i),
      sequence.map((s) => s.wordId),
      sequence.map((s) => s.check),
      sequence.map((s) => s.checkNumber),
      sequence.map((s) => s.checksTotal),
      sequence.map((s) => cardById.get(s.wordId)!.box_number),
      sequence.map((s) => cardById.get(s.wordId)!.total_reviews),
    ]
  );

  const first = rows[0];
  return reviewSessionPayload(
    {
      id: first.session_id,
      box_number: first.session_box_number,
      total_words: first.total_words,
      total_steps: first.total_steps,
      started_at: first.started_at,
      completed_at: first.completed_at,
    },
    rows
  );
}

/**
 * The entry columns of a step as the session payload shows them (`lc` = the step's leitner_cards row, `de` = its dictionary entry).
 * Deliberately no meaning: the learner has to recall it.
 */
const STEP_ENTRY_COLUMNS = `lc.entry_id, de.headword, de.lemma, de.ipa_us, de.ipa_uk,
            de.audio_us_url, de.audio_uk_url, de.pos, de.cefr_level`;

/** The answer of start / get: the session with its ordered steps (rows as read with STEP_ENTRY_COLUMNS). */
function reviewSessionPayload(session: SessionRow, rows: any[]) {
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

export async function getReviewSession(userId: string, sessionId: string) {
  // The session row and its steps are read together (steps of a session that is not the user's are simply not used).
  const [session, { rows }] = await Promise.all([
    fetchOwnedSession(sessionId, userId),
    pool.query(
      `SELECT s.step_index, s.leitner_card_id, s.check_lang, s.check_number, s.checks_total,
              s.start_box, s.answered_at, s.correct, s.word_outcome,
              ${STEP_ENTRY_COLUMNS}
         FROM leitner_review_steps s
         JOIN leitner_cards lc ON lc.id = s.leitner_card_id
         JOIN dictionary_entries de ON de.id = lc.entry_id
        WHERE s.session_id = $1
        ORDER BY s.step_index`,
      [sessionId]
    ),
  ]);
  if (!session) throw sessionNotFound();

  return reviewSessionPayload(session, rows);
}

// ── answer ───────────────────────────────────────────────────────────────────

function resultOf(outcome: WordOutcome): WordResult {
  return outcome.result ?? (outcome.correct ? 'advance' : 'reset');
}

/**
 * Writes one answer: the step AND, when it was the last open check of its word, the move of the word's card — in ONE statement, so the
 * answer costs one round trip where it used to cost BEGIN, a locked read of the session, a read of the steps, the move, the update
 * of the step and COMMIT.
 *
 * What the old transaction guaranteed, and what keeps it true here:
 *   - answers of one session are applied one at a time, and a session being completed waits for the answer in flight (and the
 *     answer finds a completed session): `sess` takes the row lock of the session, held until the statement commits;
 *   - a step is answered once: `claim` locks the step and only matches while it is still unanswered. When a second request for
 *     the same step waits for the first one, PostgreSQL re-checks that condition on the committed row, finds it false and the
 *     whole chain below it (card lock, move, update) has no rows. Nothing is written, `claimed` is 0;
 *   - steps are answered in order, and a word is finished by its last check: both are decided by the caller from the steps it read
 *     before the write. An answered step never changes again, so those facts cannot go stale, and the only step that can change under
 *     it — the one being answered — is the one claimed;
 *   - the card moves at most once per word: moveCardCtes() locks it and refuses ($8) when its total_reviews moved since the session
 *     started (reviewed elsewhere → `applied: false`, the step is still recorded).
 * $10 switches the card move on (the answer finishes its word); only then is `word_outcome` filled in, with the shape (and the ISO
 * date) that JSON.stringify(WordOutcome) used to produce.
 */
const ANSWER_STEP_SQL = `
  WITH sess AS (
    SELECT id FROM leitner_review_sessions
     WHERE id = $1::uuid AND user_id = $2::uuid AND completed_at IS NULL
       FOR UPDATE
  ), claim AS (
    SELECT st.id FROM leitner_review_steps st
     WHERE st.id = $3::uuid AND st.session_id = $1::uuid AND st.answered_at IS NULL
       AND EXISTS (SELECT 1 FROM sess)
       FOR UPDATE OF st
  ), ${moveCardCtes({
    card: '$4::uuid',
    user: '$2::uuid',
    correct: '$5::bool',
    timeMs: '$6::int',
    hold: '$7::bool',
    expectedTotalReviews: '$8::int',
    intervals: '$9::float8[]',
    gate: '$10::bool AND EXISTS (SELECT 1 FROM claim)',
  })}, stp AS (
    UPDATE leitner_review_steps st
       SET answered_at  = NOW(),
           correct      = $11::bool,
           user_answer  = $12::text,
           time_ms      = $13::int,
           grading      = $14::jsonb,
           word_outcome = CASE WHEN $10::bool THEN jsonb_build_object(
                            'correct',        $15::bool,
                            'result',         $16::text,
                            'applied',        EXISTS (SELECT 1 FROM upd),
                            'old_box_number', $17::int,
                            'new_box_number', (SELECT new_box FROM upd),
                            'next_due_at',    (SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM upd),
                            'mastered_now',   COALESCE((SELECT new_box = 5 AND old_box < 5 FROM upd), FALSE)
                          ) END
      FROM claim
     WHERE st.id = claim.id
 RETURNING st.word_outcome
  )
  SELECT (SELECT COUNT(*) FROM sess)::int  AS session_rows,
         (SELECT COUNT(*) FROM claim)::int AS claimed,
         (SELECT word_outcome FROM stp)    AS word_outcome`;

export async function answerReviewStep(userId: string, input: AnswerStepInput) {
  const { sessionId, stepIndex, userAnswer, correct, timeMs } = input;

  // One round trip asks everything the answer needs first: the session with its steps; for a typed answer the card of the step with
  // what the grader compares it with (found through the step index — the card id is only known once the steps are read); and the
  // box intervals (cached in the process). What turns out not to be needed, like that card when the step cannot be answered, is dropped.
  const [loaded, card, intervals] = await Promise.all([
    loadSessionWithSteps(sessionId, userId),
    userAnswer !== undefined ? loadLeitnerCardForStepGrading(sessionId, stepIndex, userId) : Promise.resolve(null),
    getIntervals(),
  ]);
  if (!loaded) throw sessionNotFound();
  const { session, steps } = loaded;
  if (session.completed_at) throw sessionCompleted();

  // Cheap checks first, so a bad request never costs an OpenAI call.
  const target = assertAnswerable(steps, stepIndex);

  if (userAnswer === undefined && target.checks_total === 2) {
    throw new LeitnerSessionError(
      400,
      'TYPED_ANSWER_REQUIRED',
      'Từ ở box 4/5 phải trả lời bằng user_answer (nghĩa tiếng Anh / tiếng Việt), không dùng correct'
    );
  }

  // Grade before the write: the write holds row locks, and grading may call OpenAI.
  let grading: PracticeAnswerGradeResult | null = null;
  let stepCorrect: boolean;
  if (userAnswer !== undefined) {
    if (!card) throw new LeitnerSessionError(404, 'CARD_NOT_FOUND', 'Leitner card không tồn tại');
    grading =
      target.check_lang === 'en'
        ? await gradeLoadedLeitnerEnglishCard(card, userAnswer)
        : await gradeLoadedLeitnerCard(card, userAnswer);
    stepCorrect = grading.correct;
  } else {
    stepCorrect = correct!;
  }

  // The word is finished when this was its last open check. Its box then moves once, by the checks it had:
  //   every check right → up ("advance"), none right → back to box 1 ("reset"), otherwise it stays ("hold").
  const wordSteps = steps.filter((s) => s.leitner_card_id === target.leitner_card_id);
  const finishesWord = wordSteps.every((s) => s === target || s.answered_at);
  let result: WordResult | null = null;
  let totalMs = 0;
  if (finishesWord) {
    const rightChecks = wordSteps.filter((s) => (s === target ? stepCorrect : s.correct === true)).length;
    result = rightChecks === wordSteps.length ? 'advance' : rightChecks === 0 ? 'reset' : 'hold';
    totalMs = wordSteps.reduce((sum, s) => sum + ((s === target ? timeMs : s.time_ms) ?? 0), 0);
  }

  const {
    rows: [written],
  } = await pool.query(ANSWER_STEP_SQL, [
    sessionId, //                                                 $1
    userId, //                                                    $2
    target.id, //                                                 $3
    target.leitner_card_id, //                                    $4
    result !== null && result !== 'reset', //                     $5  the word's box goes up or stays
    totalMs > 0 ? totalMs : null, //                              $6
    result === 'hold', //                                         $7
    target.start_total_reviews ?? null, //                        $8  null: a session from before migration 32 has no guard
    intervals, //                                                 $9
    finishesWord, //                                              $10
    stepCorrect, //                                               $11
    userAnswer ?? null, //                                        $12
    timeMs ?? null, //                                            $13
    grading ? JSON.stringify(grading) : null, //                  $14
    result === 'advance', //                                      $15
    result, //                                                    $16
    target.start_box, //                                          $17
  ]);

  if (written.claimed === 0) {
    // Nothing was written: since the first read the session was completed (or removed), or another request answered this step.
    if (written.session_rows === 0) {
      const existing = await fetchOwnedSession(sessionId, userId);
      throw existing ? sessionCompleted() : sessionNotFound();
    }
    throw new LeitnerSessionError(409, 'STEP_ALREADY_ANSWERED', 'Bước này đã được trả lời');
  }

  const outcome: WordOutcome | null = written.word_outcome ?? null;
  target.answered_at = new Date();
  target.correct = stepCorrect;
  target.time_ms = timeMs ?? null;
  target.word_outcome = outcome;

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
    progress: computeProgress(steps, session.total_words),
  };
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
    const existing = await fetchOwnedSession(sessionId, userId);
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
