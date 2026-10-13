import type { PoolClient } from 'pg';

/**
 * Migration 32: review a specific Leitner box.
 *
 * - leitner_review_sessions.box_number: NULL → "review due now" session,
 *   1–5 → session built from the cards of that box (due or not).
 * - leitner_review_steps.start_total_reviews: the card's total_reviews when the
 *   session started. A word's box only moves if the card was not reviewed
 *   elsewhere in the meantime (cards of a box session may not be due, so
 *   "still due" can no longer be the guard).
 */
const migration = async (client: PoolClient): Promise<void> => {
  await client.query(`
    ALTER TABLE leitner_review_sessions
      ADD COLUMN IF NOT EXISTS box_number SMALLINT
        CHECK (box_number IS NULL OR box_number BETWEEN 1 AND 5);
  `);

  await client.query(`
    ALTER TABLE leitner_review_steps
      ADD COLUMN IF NOT EXISTS start_total_reviews INT;
  `);

  console.log('  [✓] leitner_review_sessions.box_number + leitner_review_steps.start_total_reviews');
};

export = migration;
