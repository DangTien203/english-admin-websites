import type { PoolClient } from 'pg';

/**
 * Migration 36: a practice session can be resumed from the server (new device, reinstall, cleared storage), like a Leitner review
 * session already can (GET /api/v1/leitner/session/:id). Until now the paused session only lived on the device.
 *
 *   practice_sessions
 *     options           jsonb  what the client chose at start: {"cloze_level":1|2|3} (cloze_craft) / {"direction":"english"|"vietnamese"}
 *                              (flashcard); '{}' when nothing was chosen
 *     last_activity_at  set on start and on every accepted answer; a session untouched for 7 days is abandoned by the worker
 *     status            'open' | 'completed' | 'abandoned' (completed_at is still set by /complete only; abandoned_at by abandon / expiry)
 *     abandoned_at
 *   practice_session_cards   the ordered queue /session/start returned (the order is random, so it must be stored)
 *
 * Backfill, only on the run that adds the columns:
 *   - status = 'completed' where completed_at is set;
 *   - last_activity_at = completed_at, else the time of the latest answer, else started_at (not the migration time: a session that was
 *     left months ago must not look fresh for another 7 days);
 *   - sessions still 'open' whose last activity is older than 7 days become 'abandoned' WITHOUT touching Leitner. They were never
 *     completed, so their answers never reached Leitner; if the expiry job found them it would apply months-old answers all at once
 *     (and one word that sits in several old sessions would climb one box per session). Sessions from the last 7 days stay open and
 *     expire normally. Sessions that started before this migration have no stored queue: they cannot be resumed from the server.
 *
 * Indexes: (user_id, status, last_activity_at DESC) for "the user's resumable session"; a partial index on open sessions for the
 * hourly expiry scan; practice_session_cards(card_id) so deleting a card does not scan the queue table.
 *
 * Idempotent (IF NOT EXISTS; the backfill is skipped when the columns already exist). The runner wraps it in a transaction.
 */
const migration = async (client: PoolClient): Promise<void> => {
  const { rowCount: alreadyThere } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'practice_sessions' AND column_name = 'last_activity_at'`
  );

  await client.query(`
    ALTER TABLE practice_sessions
      ADD COLUMN IF NOT EXISTS options          jsonb       NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS status           varchar(12) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','completed','abandoned')),
      ADD COLUMN IF NOT EXISTS abandoned_at     timestamptz
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS practice_session_cards (
      session_id uuid NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
      position   int  NOT NULL,
      card_id    uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      PRIMARY KEY (session_id, position)
    )
  `);

  let completed = 0;
  let expired = 0;
  if (!alreadyThere) {
    const done = await client.query(`
      UPDATE practice_sessions s
         SET status = CASE WHEN s.completed_at IS NOT NULL THEN 'completed' ELSE 'open' END,
             last_activity_at = COALESCE(
               s.completed_at,
               (SELECT MAX(pa.created_at) FROM practice_answers pa WHERE pa.session_id = s.id),
               s.started_at,
               now())
    `);
    completed = done.rowCount ?? 0;
    const stale = await client.query(`
      UPDATE practice_sessions
         SET status = 'abandoned', abandoned_at = now()
       WHERE status = 'open' AND completed_at IS NULL AND last_activity_at < now() - interval '7 days'
    `);
    expired = stale.rowCount ?? 0;
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_practice_sessions_user_status_activity
      ON practice_sessions(user_id, status, last_activity_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_practice_sessions_open_activity
      ON practice_sessions(last_activity_at) WHERE status = 'open'
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_practice_session_cards_card
      ON practice_session_cards(card_id)
  `);

  console.log(
    `  [✓] practice_sessions resume columns + practice_session_cards + indexes` +
      (alreadyThere ? '' : ` (${completed} session(s) backfilled, ${expired} stale open session(s) marked abandoned without touching Leitner)`)
  );
};

export = migration;
