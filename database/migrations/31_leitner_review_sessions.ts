import type { PoolClient } from 'pg';

/**
 * Migration 31: Leitner review sessions.
 *
 * A session is an ordered list of steps. A word in box 4/5 owns two steps
 * (English meaning, then Vietnamese meaning, spaced apart); every other word
 * owns one. `total_words` is the number of distinct words — what the summary
 * shows — while `total_steps` is how many answers the learner has to give.
 *
 * The Leitner box transition is applied once per word, when its last step is
 * answered; the outcome is stored on that step in `word_outcome`.
 */
const migration = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS leitner_review_sessions (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      total_words    INT NOT NULL,
      total_steps    INT NOT NULL,
      started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at   TIMESTAMPTZ,
      time_total_ms  INT
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_leitner_review_sessions_user
      ON leitner_review_sessions(user_id, started_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS leitner_review_steps (
      id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      session_id       UUID NOT NULL REFERENCES leitner_review_sessions(id) ON DELETE CASCADE,
      step_index       INT NOT NULL,
      leitner_card_id  UUID NOT NULL REFERENCES leitner_cards(id) ON DELETE CASCADE,
      check_lang       VARCHAR(2) NOT NULL CHECK (check_lang IN ('en','vi')),
      check_number     SMALLINT NOT NULL CHECK (check_number IN (1,2)),
      checks_total     SMALLINT NOT NULL CHECK (checks_total IN (1,2)),
      start_box        SMALLINT NOT NULL CHECK (start_box BETWEEN 1 AND 5),
      answered_at      TIMESTAMPTZ,
      correct          BOOLEAN,
      user_answer      TEXT,
      time_ms          INT,
      grading          JSONB,
      word_outcome     JSONB,
      UNIQUE (session_id, step_index)
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_leitner_review_steps_card
      ON leitner_review_steps(session_id, leitner_card_id);
  `);

  console.log('  [✓] leitner_review_sessions + leitner_review_steps');
};

export = migration;
