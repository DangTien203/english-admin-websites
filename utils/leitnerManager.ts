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

  const { rows } = await pool.query(
    `INSERT INTO leitner_cards
       (user_id, entry_id, box_number, due_at, source, added_from_mode)
     VALUES ($1, $2, 1, $3, 'practice', $4)
     ON CONFLICT (user_id, entry_id) DO NOTHING
     RETURNING id`,
    [userId, entryId, dueAt, mode]
  );

  if (rows.length > 0) return { added: true };

  const { rows: existing } = await pool.query(
    `SELECT box_number FROM leitner_cards WHERE user_id = $1 AND entry_id = $2`,
    [userId, entryId]
  );
  return { added: false, existingBoxNumber: existing[0]?.box_number };
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
  const dueFor = (box: number) => new Date(Date.now() + intervals[box - 1] * 24 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock existing cards first so the box we advance from can't change underneath us.
    const { rows: existing } = await client.query(
      `SELECT id, entry_id, box_number
         FROM leitner_cards
        WHERE user_id = $1 AND entry_id = ANY($2::uuid[])
        FOR UPDATE`,
      [userId, entryIds]
    );

    if (existing.length > 0) {
      const ids: string[] = [];
      const oldBoxes: number[] = [];
      const newBoxes: number[] = [];
      const dueDates: Date[] = [];

      for (const row of existing) {
        const oldBox: number = row.box_number;
        const newBox = Math.min(oldBox + 1, 5);
        ids.push(row.id);
        oldBoxes.push(oldBox);
        newBoxes.push(newBox);
        dueDates.push(dueFor(newBox));
        if (newBox === 5 && oldBox < 5) result.mastered_now++;
      }

      await client.query(
        `UPDATE leitner_cards lc
            SET box_number       = v.new_box,
                due_at           = v.due_at,
                last_reviewed_at = now(),
                correct_streak   = COALESCE(lc.correct_streak, 0) + 1,
                total_reviews    = COALESCE(lc.total_reviews, 0) + 1,
                updated_at       = now()
           FROM unnest($1::uuid[], $2::int[], $3::timestamptz[]) AS v(id, new_box, due_at)
          WHERE lc.id = v.id`,
        [ids, newBoxes, dueDates]
      );

      await client.query(
        `INSERT INTO leitner_reviews (leitner_card_id, user_id, correct, old_box, new_box)
         SELECT v.id, $1::uuid, true, v.old_box, v.new_box
           FROM unnest($2::uuid[], $3::int[], $4::int[]) AS v(id, old_box, new_box)`,
        [userId, ids, oldBoxes, newBoxes]
      );

      result.advanced = existing.length;
    }

    const existingEntryIds = new Set(existing.map((row: any) => row.entry_id as string));
    const newEntryIds = entryIds.filter((id) => !existingEntryIds.has(id));

    if (newEntryIds.length > 0) {
      const { rows: inserted } = await client.query(
        `INSERT INTO leitner_cards
           (user_id, entry_id, box_number, due_at, source, added_from_mode)
         SELECT $1, unnest($2::uuid[]), 1, $3, 'practice', $4
         ON CONFLICT (user_id, entry_id) DO NOTHING
         RETURNING id`,
        [userId, newEntryIds, dueFor(1), mode]
      );
      result.added = inserted.length;
    }

    await client.query('COMMIT');
    result.skipped = entryIds.length - result.added;
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
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

export async function moveCard(
  leitnerCardId: string,
  userId: string,
  correct: boolean,
  timeMsArg?: number,
  opts: MoveCardOptions = {}
): Promise<{ newBoxNumber: number; nextDueAt: Date; masteredNow: boolean }> {
  const db: Queryable = opts.db ?? pool;
  const intervals = await getIntervals();

  const { rows } = await db.query(
    `SELECT id, box_number, COALESCE(total_reviews, 0) AS total_reviews
       FROM leitner_cards WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
    [leitnerCardId, userId]
  );
  if (rows.length === 0) {
    const err = Object.assign(new Error('CARD_NOT_FOUND'), { statusCode: 404 });
    throw err;
  }
  if (opts.expectedTotalReviews != null && rows[0].total_reviews !== opts.expectedTotalReviews) {
    throw Object.assign(new Error('CARD_CHANGED'), { statusCode: 409 });
  }

  const oldBox: number = rows[0].box_number;
  const hold = correct && opts.hold === true;
  const newBox = hold ? oldBox : correct ? Math.min(oldBox + 1, 5) : 1;
  const nextDueAt = new Date(Date.now() + intervals[newBox - 1] * 24 * 60 * 60 * 1000);
  const masteredNow = newBox === 5 && oldBox < 5;

  await db.query(
    `UPDATE leitner_cards
     SET box_number        = $1,
         due_at            = $2,
         last_reviewed_at  = now(),
         correct_streak    = CASE WHEN $5 THEN correct_streak
                                  WHEN $3 THEN correct_streak + 1
                                  ELSE 0 END,
         total_reviews     = total_reviews + 1,
         updated_at        = now()
     WHERE id = $4`,
    [newBox, nextDueAt, correct, leitnerCardId, hold]
  );

  await db.query(
    `INSERT INTO leitner_reviews
       (leitner_card_id, user_id, correct, old_box, new_box, time_ms)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [leitnerCardId, userId, correct, oldBox, newBox, timeMsArg ?? null]
  );

  return { newBoxNumber: newBox, nextDueAt, masteredNow };
}
