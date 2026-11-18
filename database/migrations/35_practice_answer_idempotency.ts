import type { PoolClient } from 'pg';

/**
 * Migration 35: a practice session answers a card ONCE (POST /api/v1/practice/session/answer is idempotent per session + card).
 *
 * The mobile app can now leave and resume a session, and re-sends an answer after a timeout or a crash; until now every re-send added
 * another practice_answers row and bumped the session counters and the card progress again.
 *
 *   1. dedupe: of the rows that share (session_id, card_id) the EARLIEST one is kept (created_at, then id), the rest are deleted;
 *   2. the counters of the sessions that lost rows (answered_count, correct_count, wrong_count) are recomputed from the rows that remain.
 *      Only those sessions are touched: a session without duplicates keeps whatever it has (e.g. a card deleted later removed its answer
 *      row by cascade, and the "x/y" the user saw in the history stays what it was);
 *   3. UNIQUE INDEX idx_practice_answers_session_card ON practice_answers(session_id, card_id), the arbiter of the route's
 *      INSERT … ON CONFLICT (session_id, card_id) DO NOTHING.
 *
 * Idempotent: a second run finds nothing to delete and the index exists. The runner wraps it in a transaction. practice_answers is
 * locked against writes for the (short) duration, so an answer that arrives from a server still running the old code cannot slip a
 * duplicate in between the dedupe and the index build (it waits, then fails on the unique index instead).
 * user_card_progress is NOT rewound: times_seen / times_correct of cards that were counted twice stay as they are, because that table
 * is per user and card across sessions and cannot tell which of its counts came from the deleted rows.
 */
const migration = async (client: PoolClient): Promise<void> => {
  // Reads stay possible; writers (answers) wait until this transaction ends.
  await client.query('LOCK TABLE practice_answers IN SHARE ROW EXCLUSIVE MODE');

  const { rows } = await client.query<{ sessions: string[] | null; removed: number }>(
    `WITH ranked AS (
       SELECT id, session_id,
              ROW_NUMBER() OVER (PARTITION BY session_id, card_id ORDER BY created_at ASC NULLS LAST, id ASC) AS rn
         FROM practice_answers
     ), del AS (
       DELETE FROM practice_answers pa
        USING ranked r
        WHERE pa.id = r.id AND r.rn > 1
    RETURNING pa.session_id
     )
     SELECT ARRAY(SELECT DISTINCT session_id FROM del) AS sessions, (SELECT COUNT(*) FROM del)::int AS removed`
  );
  const affected = rows[0].sessions ?? [];
  const removed = rows[0].removed;

  if (affected.length > 0) {
    // The remaining rows are a different snapshot from the DELETE above (a separate statement), so this counts what is left.
    await client.query(
      `UPDATE practice_sessions s
          SET answered_count = c.answered,
              correct_count  = c.correct,
              wrong_count    = c.answered - c.correct
         FROM (
           SELECT a.id AS session_id,
                  COUNT(pa.id)::int                             AS answered,
                  COUNT(pa.id) FILTER (WHERE pa.correct)::int   AS correct
             FROM unnest($1::uuid[]) AS a(id)
             LEFT JOIN practice_answers pa ON pa.session_id = a.id
            GROUP BY a.id
         ) c
        WHERE s.id = c.session_id`,
      [affected]
    );
  }

  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_practice_answers_session_card
       ON practice_answers(session_id, card_id)`
  );

  console.log(`  [✓] practice_answers unique (session_id, card_id): ${removed} duplicate row(s) removed, ${affected.length} session counter(s) recomputed`);
};

export = migration;
