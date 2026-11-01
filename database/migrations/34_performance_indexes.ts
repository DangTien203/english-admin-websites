import type { PoolClient } from 'pg';

/**
 * Migration 34: indexes for queries that scan more as the data grows (performance pass).
 *
 * Every statement is idempotent (IF NOT EXISTS) and nothing existing is altered or dropped.
 *   - idx_dict_headword_trgm / idx_dict_lemma_trgm   trigram GIN indexes: the search box of the mobile app
 *       (GET /api/v1/dictionary/search: headword ILIKE '%q%' OR lemma ILIKE '%q%') could only read every entry; with the indexes it reads
 *       the entries that contain the text. They need the pg_trgm extension, created here under a SAVEPOINT: a database that does not
 *       offer it (or a role that may not create it) skips the two indexes with a warning and the migration still succeeds.
 *   - idx_cards_entry                  cards(entry_id): the unique key of cards starts with deck_id, so "which decks use this entry"
 *       and the foreign-key check when a dictionary entry is deleted had no index to use.
 *   - idx_game_runs_type_created       completed runs by game type and time: the weekly / monthly leaderboards and the player's rank on
 *       the home dashboard filter on exactly that.
 *   - idx_approval_requests_pending, idx_transactions_pending   the sidebar badges count the PENDING rows only; a partial index keeps
 *       that count the size of the queue instead of the size of the whole history. (approval_requests had no index but its key.)
 */
const migration = async (client: PoolClient): Promise<void> => {
  let trigram = false;
  const { rows } = await client.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm'`);
  if (rows.length > 0) {
    await client.query('SAVEPOINT pg_trgm_extension');
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await client.query('RELEASE SAVEPOINT pg_trgm_extension');
      trigram = true;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT pg_trgm_extension');
      console.warn(`  [!] pg_trgm could not be created (${(err as Error).message}); the trigram search indexes are skipped`);
    }
  } else {
    console.warn('  [!] pg_trgm is not available on this server; the trigram search indexes are skipped');
  }

  if (trigram) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_dict_headword_trgm ON dictionary_entries USING gin (headword gin_trgm_ops)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_dict_lemma_trgm ON dictionary_entries USING gin (lemma gin_trgm_ops)');
  }

  const indexes: string[] = [
    'CREATE INDEX IF NOT EXISTS idx_cards_entry ON cards(entry_id)',
    'CREATE INDEX IF NOT EXISTS idx_game_runs_type_created ON game_runs(game_type, created_at DESC) WHERE completed = TRUE',
    "CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON approval_requests(created_at) WHERE status = 'pending'",
    "CREATE INDEX IF NOT EXISTS idx_transactions_pending ON transactions(created_at) WHERE status = 'pending'",
  ];
  for (const sql of indexes) {
    await client.query(sql);
  }

  console.log(`  [✓] performance indexes (${indexes.length}${trigram ? ' + 2 trigram' : ''})`);
};

export = migration;
