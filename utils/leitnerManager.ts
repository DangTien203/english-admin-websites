import NodeCache from 'node-cache';
import pool from '../config/db';

const DEFAULT_INTERVALS = [1, 2, 4, 7, 14];
const intervalsCache = new NodeCache({ stdTTL: 300 }); // 5 min

export async function getIntervals(): Promise<number[]> {
  const cached = intervalsCache.get<number[]>('leitner_intervals_days');
  if (cached) return cached;

  const { rows } = await pool.query(
    `SELECT config_value FROM system_configs WHERE config_key = 'leitner_intervals_days'`
  );
  const val = rows[0]?.config_value;
  const intervals = Array.isArray(val) && val.length === 5
    ? (val as number[])
    : DEFAULT_INTERVALS;
  intervalsCache.set('leitner_intervals_days', intervals);
  return intervals;
}

export async function addToBox1IfNotExists(
  userId: string,
  entryId: string,
  mode: string
): Promise<{ added: boolean; existingBoxNumber?: number }> {
  const intervals = await getIntervals();
  const dueAt = new Date(Date.now() + intervals[0] * 24 * 60 * 60 * 1000);

  // One statement: the insert, and — when the card was already there — the box it is in. The read cannot see the row the insert
  // adds (same snapshot), so `existing_box` is only set when the insert did nothing. It used to be two round trips.
  const { rows } = await pool.query(
    `WITH ins AS (
       INSERT INTO leitner_cards
         (user_id, entry_id, box_number, due_at, source, added_from_mode)
       VALUES ($1, $2, 1, $3, 'practice', $4)
       ON CONFLICT (user_id, entry_id) DO NOTHING
       RETURNING id
     )
     SELECT (SELECT id FROM ins) AS inserted_id,
            (SELECT box_number FROM leitner_cards WHERE user_id = $1 AND entry_id = $2) AS existing_box`,
    [userId, entryId, dueAt, mode]
  );

  if (rows[0]?.inserted_id) return { added: true };
  return { added: false, existingBoxNumber: rows[0]?.existing_box ?? undefined };
}

export async function addBatchToBox1(
  userId: string,
  entryIds: string[],
  mode: string
): Promise<{ added: number; skipped: number }> {
  if (entryIds.length === 0) return { added: 0, skipped: 0 };

  const intervals = await getIntervals();
  const dueAt = new Date(Date.now() + intervals[0] * 24 * 60 * 60 * 1000);

  const { rows } = await pool.query(
    `INSERT INTO leitner_cards
       (user_id, entry_id, box_number, due_at, source, added_from_mode)
     SELECT $1, unnest($2::uuid[]), 1, $3, 'practice', $4
     ON CONFLICT (user_id, entry_id) DO NOTHING
     RETURNING id`,
    [userId, entryIds, dueAt, mode]
  );

  const added = rows.length;
  return { added, skipped: entryIds.length - added };
}

export interface PracticeLeitnerResult {
  /** Entries that were not in Leitner yet and were inserted into box 1. */
  added: number;
  /** Entries already in Leitner that moved up one box (box 5 stays at 5). */
  advanced: number;
  /** Entries that reached box 5 for the first time in this batch. */
  mastered_now: number;
  /** Legacy shape for `leitner_added.skipped`: entries that already existed. */
  skipped: number;
}

/** The SQL placeholders (already cast, e.g. '$2::uuid[]') a statement built from practiceAdvanceCtes() binds its parameters to. */
export interface PracticeAdvancePlaceholders {
  user: string; //      uuid
  entryIds: string; //  uuid[]
  intervals: string; // float8[]: the days of boxes 1…5
  mode: string; //      text: what the new cards record as the way they were added
  /**
   * An extra condition, as SQL text (e.g. 'EXISTS (SELECT 1 FROM claim)'). While it is false nothing is locked, moved or added, which
   * is how a larger statement switches the whole step on and off (the completion of a practice session does it with its claim).
   */
  gate?: string;
}

/**
 * The CTEs that apply the correct answers of a practice session to Leitner, for the WITH list of a statement:
 *   wanted    the distinct entries (empty while the gate is false)
 *   existing  the user's cards for these entries, locked, so the box we advance from cannot change underneath us
 *   moved     each of them one box up (box 5 stays 5, its interval is refreshed)
 *   rev       one leitner_reviews line per moved card
 *   ins       the entries that are not in Leitner yet go to box 1 (a concurrent insert of the same card is skipped, not an error)
 * Due dates are `NOW() + interval days` in whole seconds, from the same configurable intervals the application used.
 */
export function practiceAdvanceCtes(p: PracticeAdvancePlaceholders): string {
  return `wanted AS (
       SELECT DISTINCT e AS entry_id FROM unnest(${p.entryIds}) AS e${p.gate ? ` WHERE ${p.gate}` : ''}
     ), existing AS (
       SELECT lc.id, lc.entry_id, lc.box_number
         FROM leitner_cards lc
         JOIN wanted w ON w.entry_id = lc.entry_id
        WHERE lc.user_id = ${p.user}
          FOR UPDATE OF lc
     ), moved AS (
       UPDATE leitner_cards lc
          SET box_number       = LEAST(ex.box_number + 1, 5),
              due_at           = NOW() + make_interval(secs => (${p.intervals})[LEAST(ex.box_number + 1, 5)] * 86400),
              last_reviewed_at = now(),
              correct_streak   = COALESCE(lc.correct_streak, 0) + 1,
              total_reviews    = COALESCE(lc.total_reviews, 0) + 1,
              updated_at       = now()
         FROM existing ex
        WHERE lc.id = ex.id
    RETURNING lc.id, ex.box_number AS old_box, lc.box_number AS new_box
     ), rev AS (
       INSERT INTO leitner_reviews (leitner_card_id, user_id, correct, old_box, new_box)
       SELECT id, ${p.user}, true, old_box, new_box FROM moved
     ), ins AS (
       INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at, source, added_from_mode)
       SELECT ${p.user}, w.entry_id, 1, NOW() + make_interval(secs => (${p.intervals})[1] * 86400), 'practice', ${p.mode}
         FROM wanted w
        WHERE NOT EXISTS (SELECT 1 FROM existing ex WHERE ex.entry_id = w.entry_id)
       ON CONFLICT (user_id, entry_id) DO NOTHING
       RETURNING id
     )`;
}

/** The final SELECT list that goes with practiceAdvanceCtes(): how many cards moved, reached box 5, and were added. */
export const PRACTICE_ADVANCE_COUNTS = `(SELECT COUNT(*) FROM moved)::int                                  AS advanced,
            (SELECT COUNT(*) FROM moved WHERE new_box = 5 AND old_box < 5)::int AS mastered_now,
            (SELECT COUNT(*) FROM ins)::int                                    AS added`;

/**
 * Applies the correct answers of a practice session to Leitner in one transaction:
 *  - entry not in Leitner  → inserted into box 1
 *  - entry already in a box → moved up one box (box 5 stays in box 5, interval refreshed)
 * Callers must only pass entries that passed every check required for their current box
 * (box 4/5 need both the Vietnamese and the English meaning).
 */
export async function applyPracticeCorrectAnswers(
  userId: string,
  entryIds: string[],
  mode: string
): Promise<PracticeLeitnerResult> {
  const result: PracticeLeitnerResult = { added: 0, advanced: 0, mastered_now: 0, skipped: 0 };
  if (entryIds.length === 0) return result;

  const intervals = await getIntervals();

  // ONE statement, which is atomic on its own (it replaces BEGIN … COMMIT and the six statements between them, each a round trip);
  // its steps are those of practiceAdvanceCtes().
  const { rows } = await pool.query(
    `WITH ${practiceAdvanceCtes({ user: '$1::uuid', entryIds: '$2::uuid[]', intervals: '$3::float8[]', mode: '$4::text' })}
     SELECT ${PRACTICE_ADVANCE_COUNTS}`,
    [userId, entryIds, intervals, mode]
  );

  result.advanced = rows[0].advanced;
  result.mastered_now = rows[0].mastered_now;
  result.added = rows[0].added;
  result.skipped = entryIds.length - result.added;
  return result;
}

/** Anything that can run a query: the shared pool or a client inside a transaction. */
export interface Queryable {
  query(text: string, values?: any[]): Promise<{ rows: any[] }>;
}

export interface MoveCardOptions {
  /** Run inside the caller's transaction instead of the shared pool. */
  db?: Queryable;
  /**
   * Refuse (409 CARD_CHANGED) when the card's total_reviews differs from this value,
   * i.e. it was already reviewed since the caller looked at it.
   */
  expectedTotalReviews?: number | null;
  /**
   * Only with `correct = true`: the answer was good enough not to lose the box but not
   * good enough to leave it (box 4/5 word with exactly one of its two meanings right).
   * The card stays in its box, the due date is rescheduled with that box's interval and
   * the correct streak is left untouched.
   */
  hold?: boolean;
}

/** The SQL placeholders (already cast, e.g. '$3::bool') a statement built from moveCardCtes() binds the move of one card to. */
export interface MoveCardPlaceholders {
  card: string; //                 uuid
  user: string; //                 uuid
  correct: string; //              bool
  timeMs: string; //               int, may be NULL
  hold: string; //                 bool
  expectedTotalReviews: string; // int, may be NULL (no guard)
  intervals: string; //            float8[]: the days of boxes 1…5
  /**
   * An extra condition on the card that is locked, as SQL text (e.g. 'EXISTS (SELECT 1 FROM claim)'). While it is false nothing is
   * locked and nothing is moved, which is how a larger statement switches the move on and off.
   */
  gate?: string;
}

/**
 * The four CTEs of one card move — cur, calc, upd, rev — as text for the WITH list of a statement. moveCard() is exactly these plus a
 * final SELECT; the review-session answer puts them in the same statement as the update of its step, so the two cannot disagree.
 *   cur   the card, locked
 *   calc  its new box — only when the caller's expected total_reviews still matches (else no row, and no change)
 *   upd   the card moved; due date = now + the interval of the new box
 *   rev   the leitner_reviews line
 * "No such card" is told from "the card changed since the caller looked" by cur (has the card or not) and upd (moved or not).
 */
export function moveCardCtes(p: MoveCardPlaceholders): string {
  return `cur AS (
       SELECT id, box_number, COALESCE(total_reviews, 0) AS total_reviews
         FROM leitner_cards WHERE id = ${p.card} AND user_id = ${p.user}${p.gate ? ` AND ${p.gate}` : ''}
          FOR UPDATE
     ), calc AS (
       SELECT id, box_number AS old_box,
              CASE WHEN ${p.hold} THEN box_number
                   WHEN ${p.correct} THEN LEAST(box_number + 1, 5)
                   ELSE 1 END AS new_box
         FROM cur
        WHERE ${p.expectedTotalReviews} IS NULL OR total_reviews = ${p.expectedTotalReviews}
     ), upd AS (
       UPDATE leitner_cards lc
          SET box_number       = calc.new_box,
              due_at           = NOW() + make_interval(secs => (${p.intervals})[calc.new_box] * 86400),
              last_reviewed_at = now(),
              correct_streak   = CASE WHEN ${p.hold} THEN lc.correct_streak
                                      WHEN ${p.correct} THEN lc.correct_streak + 1
                                      ELSE 0 END,
              total_reviews    = lc.total_reviews + 1,
              updated_at       = now()
         FROM calc
        WHERE lc.id = calc.id
    RETURNING lc.box_number AS new_box, lc.due_at, calc.old_box
     ), rev AS (
       INSERT INTO leitner_reviews (leitner_card_id, user_id, correct, old_box, new_box, time_ms)
       SELECT ${p.card}, ${p.user}, ${p.correct}, old_box, new_box, ${p.timeMs} FROM upd
     )`;
}

export async function moveCard(
  leitnerCardId: string,
  userId: string,
  correct: boolean,
  timeMsArg?: number,
  opts: MoveCardOptions = {}
): Promise<{ newBoxNumber: number; nextDueAt: Date; masteredNow: boolean }> {
  const db: Queryable = opts.db ?? pool;
  const intervals = await getIntervals();
  const hold = correct && opts.hold === true;

  // ONE statement instead of lock-read, update and insert (three round trips). It is atomic by itself, which also closes a gap of the
  // old version: on the shared pool its "SELECT … FOR UPDATE" ended with that statement and held nothing for the UPDATE after it.
  // The CTEs are those of moveCardCtes(); `found` tells "no such card" (0) from "the card changed since the caller looked at it"
  // (1, but nothing was moved).
  const { rows } = await db.query(
    `WITH ${moveCardCtes({
      card: '$1::uuid',
      user: '$2::uuid',
      correct: '$3::bool',
      timeMs: '$4::int',
      hold: '$5::bool',
      expectedTotalReviews: '$6::int',
      intervals: '$7::float8[]',
    })}
     SELECT (SELECT COUNT(*) FROM cur)::int AS found, upd.new_box, upd.old_box, upd.due_at
       FROM (SELECT 1) one
       LEFT JOIN upd ON TRUE`,
    [leitnerCardId, userId, correct, timeMsArg ?? null, hold, opts.expectedTotalReviews ?? null, intervals]
  );

  const r = rows[0];
  if (!r || r.found === 0) {
    const err = Object.assign(new Error('CARD_NOT_FOUND'), { statusCode: 404 });
    throw err;
  }
  if (r.new_box === null || r.new_box === undefined) {
    throw Object.assign(new Error('CARD_CHANGED'), { statusCode: 409 });
  }

  const newBox: number = r.new_box;
  const oldBox: number = r.old_box;
  return { newBoxNumber: newBox, nextDueAt: r.due_at as Date, masteredNow: newBox === 5 && oldBox < 5 };
}
