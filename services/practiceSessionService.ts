import pool from '../config/db';
import { PRACTICE_ADVANCE_COUNTS, getIntervals, practiceAdvanceCtes } from '../utils/leitnerManager';
import { recordActivity } from '../utils/streakCalculator';
import { VI_COALESCE } from '../utils/questionHelpers';
import { requiresEnglishMeaning } from './answerGradingService';
import { errMessage, logEvent } from './queue/log';

/**
 * Practice sessions that outlive the request: the server-side half of "leave a session and resume it later, even on another device".
 *   - the card shape of a session (shared by /session/start and the resume endpoints);
 *   - the resume payload (GET /session/active, GET /session/:id);
 *   - closing a session, ONE code path for /complete, /abandon and the hourly expiry job;
 *   - the expiry job itself (abandonExpiredPracticeSessions, scheduled by services/queue/practiceExpirySchedule.ts).
 */

/** A session untouched for this many days is no longer resumable and is abandoned by the worker. */
export const RESUMABLE_DAYS = 7;

/** practice_sessions.time_total_ms is an int4: a session that is closed very late must not overflow it. */
const MAX_INT4 = 2_147_483_647;

// ─────────────────────────────────────────────────────────────────────────────
//  Cards of a session
// ─────────────────────────────────────────────────────────────────────────────

/** What a session card needs: the card, its entry, the user's progress on the card and the Leitner box of the word ($2 = user). */
export const SESSION_CARD_SELECT = `
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

/** A row of SESSION_CARD_SELECT as the API shows it: the card object of /session/start and of the resume payload. */
export function toSessionCard(c: any) {
  return {
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Resume payload
// ─────────────────────────────────────────────────────────────────────────────

/** A session the user can pick up: open, touched within RESUMABLE_DAYS, something answered, and a card of the queue still unanswered. */
const RESUMABLE_SQL = `
  s.status = 'open' AND s.completed_at IS NULL
  AND s.last_activity_at > now() - interval '${RESUMABLE_DAYS} days'
  AND s.answered_count > 0
  AND EXISTS (SELECT 1 FROM practice_session_cards q
               WHERE q.session_id = s.id
                 AND NOT EXISTS (SELECT 1 FROM practice_answers pa WHERE pa.session_id = s.id AND pa.card_id = q.card_id))`;

/** The session row with its deck title and ALL its answers (in the order they were given) in one statement. $1 = user. */
const SESSION_HEADER_SQL = `
  SELECT s.id AS session_id, s.deck_id, d.title AS deck_title, s.mode, s.options, s.status,
         s.total_count, s.answered_count, s.correct_count, s.wrong_count,
         s.started_at, s.last_activity_at, s.completed_at,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('card_id', pa.card_id, 'correct', pa.correct,
                                                       'time_ms', pa.time_ms, 'user_answer', pa.user_answer)
                                    ORDER BY pa.created_at, pa.id)
                     FROM practice_answers pa WHERE pa.session_id = s.id), '[]'::jsonb) AS answers
    FROM practice_sessions s
    JOIN decks d ON d.id = s.deck_id
   WHERE s.user_id = $1`;

/** The stored queue of a session, in order, as session cards. $1 = session, $2 = user (progress and Leitner box). */
const SESSION_QUEUE_SQL = `${SESSION_CARD_SELECT}
  JOIN practice_session_cards q ON q.card_id = c.id
 WHERE q.session_id = $1
 ORDER BY q.position`;

function sessionPayload(header: any, cardRows: any[]) {
  const { answers, ...session } = header;
  const answered = new Set<string>(answers.map((a: any) => a.card_id));
  const cards = cardRows.map(toSessionCard);
  return {
    ...session,
    cards,
    answers,
    next_card_id: cards.find((c) => !answered.has(c.card_id))?.card_id ?? null,
  };
}

/** The resume payload of one of the user's sessions (any status), or null when there is no such session of theirs. 1 round trip. */
export async function getPracticeSession(userId: string, sessionId: string) {
  // The header (which also proves the session is the user's) and the queue are independent reads, asked together; the queue of a
  // session that is not the user's is simply not used.
  const [{ rows: headers }, { rows: cardRows }] = await Promise.all([
    pool.query(`${SESSION_HEADER_SQL} AND s.id = $2`, [userId, sessionId]),
    pool.query(SESSION_QUEUE_SQL, [sessionId, userId]),
  ]);
  return headers.length === 0 ? null : sessionPayload(headers[0], cardRows);
}

/** The user's most recently active resumable session, or null. 2 sequential statements (the second needs the id the first found). */
export async function getActivePracticeSession(userId: string) {
  const { rows: headers } = await pool.query(
    `${SESSION_HEADER_SQL} AND ${RESUMABLE_SQL} ORDER BY s.last_activity_at DESC LIMIT 1`,
    [userId]
  );
  if (headers.length === 0) return null;
  const { rows: cardRows } = await pool.query(SESSION_QUEUE_SQL, [headers[0].session_id, userId]);
  return sessionPayload(headers[0], cardRows);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Closing a session: complete / abandon / expire
// ─────────────────────────────────────────────────────────────────────────────

export type CloseKind = 'complete' | 'abandon';

/** The response body of /session/complete and /session/abandon. */
export interface CloseResponse {
  summary: { correct_count: number; wrong_count: number; accuracy: number; time_total_ms: number };
  xp_earned: number;
  leitner_added: { added: number; skipped: number };
  leitner_advanced: number;
  leitner_mastered_now: number;
  streak_updated: boolean;
  correct_card_ids: string[];
}

export type CloseOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'already_closed' }
  | { outcome: 'closed'; body: CloseResponse };

/** What the claim writes, by kind. Constants (never input). Abandoning earns no XP, so xp_earned is 0 whatever was answered. */
const CLAIM_SET: Record<CloseKind, string> = {
  complete: `status = 'completed', completed_at = NOW()`,
  abandon: `status = 'abandoned', abandoned_at = NOW()`,
};

/**
 * Closes a practice session and applies its correct answers to Leitner. The ONE code path of
 *   - POST /session/complete  (kind 'complete')  +20 bonus when something was answered, activity logged for the streak;
 *   - POST /session/abandon   (kind 'abandon')   no bonus, no activity, no streak;
 *   - the hourly expiry job   (kind 'abandon')   for sessions untouched for RESUMABLE_DAYS.
 *
 * Marking the session closed and moving its cards are ONE statement: the claim (`status = 'open'`) comes first and only the request
 * that wins it moves the cards (new words → Leitner box 1, words already in a box → next box; `correct` already means "Vietnamese AND
 * English right" for box 4/5 cards). Two closes at once — a double tap, a retry of a slow request, abandon racing complete or the
 * job — apply each card ONCE; the loser gets 'already_closed'. Atomic: a failure leaves the session open.
 * A session without a single answer is simply closed (nothing to apply).
 */
export async function closePracticeSession(args: { sessionId: string; userId: string; kind: CloseKind }): Promise<CloseOutcome> {
  const { sessionId, userId, kind } = args;

  // The session, the distinct correctly-answered cards of it (both keyed by the session id) and the box intervals are read together.
  // (The cards of a session that turns out not to be the user's are simply not used.)
  const [{ rows: sessionRows }, { rows: correctRows }, intervals] = await Promise.all([
    pool.query(
      `SELECT id, user_id, deck_id, mode, status, answered_count, correct_count, wrong_count, total_count, started_at, completed_at
         FROM practice_sessions WHERE id = $1`,
      [sessionId]
    ),
    pool.query(
      `SELECT DISTINCT pa.card_id, c.entry_id
         FROM practice_answers pa
         JOIN cards c ON c.id = pa.card_id
        WHERE pa.session_id = $1 AND pa.correct = true`,
      [sessionId]
    ),
    getIntervals(),
  ]);
  if (sessionRows.length === 0 || sessionRows[0].user_id !== userId) return { outcome: 'not_found' };
  const session = sessionRows[0];
  if (session.status !== 'open' || session.completed_at !== null) return { outcome: 'already_closed' };

  const timeTotalMs = Math.min(MAX_INT4, Math.max(0, Date.now() - new Date(session.started_at).getTime()));
  const correctCount: number = session.correct_count;
  const wrongCount: number = session.wrong_count;
  const answeredCount: number = session.answered_count ?? 0;
  // +20 completion bonus, only for a session in which something was answered; an abandoned session earns nothing at all.
  const xpEarned = kind === 'complete' && answeredCount > 0 ? correctCount * 10 + 20 : 0;

  const correctCardIds = [...new Set(correctRows.map((r: any) => r.card_id as string))];
  const correctEntryIds = [...new Set(correctRows.map((r: any) => r.entry_id as string))];

  // Beside the claim (they do not depend on each other) the activity is logged and the streak updated — for a completion that
  // answered something, never for an abandon; non-critical streak work must not fail the request.
  const [{ rows: [done] }, streakUpdated] = await Promise.all([
    pool.query(
      `WITH claim AS (
         UPDATE practice_sessions
            SET ${CLAIM_SET[kind]}, time_total_ms = $2, xp_earned = $3
          WHERE id = $1 AND user_id = $4 AND status = 'open' AND completed_at IS NULL
      RETURNING id
       ), ${practiceAdvanceCtes({
         user: '$4::uuid',
         entryIds: '$5::uuid[]',
         intervals: '$6::float8[]',
         mode: '$7::text',
         gate: 'EXISTS (SELECT 1 FROM claim)',
       })}
       SELECT (SELECT COUNT(*) FROM claim)::int AS claimed, ${PRACTICE_ADVANCE_COUNTS}`,
      [sessionId, timeTotalMs, xpEarned, userId, correctEntryIds, intervals, session.mode]
    ),
    kind === 'complete' && answeredCount > 0
      ? recordActivity(userId, 'practice_session', {
          mode: session.mode,
          deck_id: session.deck_id,
          session_id: sessionId,
          correct_count: correctCount,
          xp_earned: xpEarned,
        }).then(
          () => true,
          () => false
        )
      : Promise.resolve(false),
  ]);
  // Another request closed this session between our read and our claim.
  if (done.claimed === 0) return { outcome: 'already_closed' };

  const accuracy = correctCount + wrongCount > 0 ? Math.round((correctCount / (correctCount + wrongCount)) * 100) / 100 : 0;
  return {
    outcome: 'closed',
    body: {
      summary: { correct_count: correctCount, wrong_count: wrongCount, accuracy, time_total_ms: timeTotalMs },
      xp_earned: xpEarned,
      leitner_added: { added: done.added, skipped: correctEntryIds.length - done.added },
      leitner_advanced: done.advanced,
      leitner_mastered_now: done.mastered_now,
      streak_updated: streakUpdated,
      correct_card_ids: correctCardIds,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Expiry
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpiryOptions {
  /** Sessions closed per batch (default 50). */
  batchSize?: number;
  /** Batches per run (default 20): a backlog is worked off over several runs instead of one very long one. */
  maxBatches?: number;
  /** Default RESUMABLE_DAYS. */
  olderThanDays?: number;
  /** Maintenance on these users only, and the tests (never the real rows of the database). Default: everybody. */
  userIds?: string[];
}

export interface ExpiryResult {
  /** Sessions this run closed. */
  abandoned: number;
  /** Sessions somebody else closed (complete, abandon) between the scan and the close. */
  skipped: number;
  /** Sessions whose close threw; each is left open and tried again by the next run. */
  failed: number;
  batches: number;
}

/**
 * Abandons the open sessions whose last activity is older than RESUMABLE_DAYS, in batches, each through closePracticeSession() — the
 * path of POST /session/abandon — so the correct answers of a session the user never came back to still reach Leitner (once).
 * Safe to run twice at once or to repeat: the close is a claim. Oldest first.
 */
export async function abandonExpiredPracticeSessions(opts: ExpiryOptions = {}): Promise<ExpiryResult> {
  const batchSize = Math.max(1, opts.batchSize ?? 50);
  const maxBatches = Math.max(1, opts.maxBatches ?? 20);
  const days = opts.olderThanDays ?? RESUMABLE_DAYS;
  const result: ExpiryResult = { abandoned: 0, skipped: 0, failed: 0, batches: 0 };
  const failedIds: string[] = [];

  for (let batch = 0; batch < maxBatches; batch++) {
    const { rows } = await pool.query(
      `SELECT id, user_id FROM practice_sessions
        WHERE status = 'open' AND completed_at IS NULL
          AND last_activity_at < now() - make_interval(days => $1::int)
          AND ($2::uuid[] IS NULL OR user_id = ANY($2::uuid[]))
          AND id <> ALL($3::uuid[])
        ORDER BY last_activity_at
        LIMIT $4`,
      [days, opts.userIds ?? null, failedIds, batchSize]
    );
    if (rows.length === 0) break;
    result.batches++;

    // One session at a time: each close is its own atomic statement and a background job has no latency to hide.
    for (const row of rows) {
      try {
        const out = await closePracticeSession({ sessionId: row.id, userId: row.user_id, kind: 'abandon' });
        if (out.outcome === 'closed') result.abandoned++;
        else result.skipped++;
      } catch (err) {
        result.failed++;
        failedIds.push(row.id);
        logEvent('error', 'practice_expiry_close_failed', { session_id: row.id, error: errMessage(err) });
      }
    }
    if (rows.length < batchSize) break;
  }
  return result;
}
