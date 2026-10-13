import type { PoolClient } from 'pg';

/**
 * Reference-data tables for word lookup / enrichment (docs/lookup-spec.md §2).
 *
 * Kept separate from migration 33 so the same DDL can run either
 *   - inside the main database (default, via migration 33), or
 *   - inside a dedicated database when REFDATA_DATABASE_URL is set
 *     (via `npm run db:migrate-refdata`, see docs/lookup-refdata.md).
 *
 * Idempotent (IF NOT EXISTS). Must not reference any main-database table,
 * because it can run on a database that has none of them.
 */
export async function createRefTables(client: PoolClient): Promise<void> {
  // Reduced rows of the kaikki.org English Wiktionary dump (loaded in P4).
  await client.query(`
    CREATE TABLE IF NOT EXISTS ref_wiktionary_en (
      id                BIGSERIAL PRIMARY KEY,
      word              TEXT NOT NULL,
      pos               TEXT NOT NULL,
      etymology_number  INT,
      lemma_of          TEXT,
      data              JSONB NOT NULL
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_ref_wikt_en_word
      ON ref_wiktionary_en(word);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_ref_wikt_en_lemma_of
      ON ref_wiktionary_en(lemma_of) WHERE lemma_of IS NOT NULL;
  `);

  // Word frequency list. rank 1 = most common.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ref_word_frequency (
      word  TEXT PRIMARY KEY,
      zipf  REAL NOT NULL,
      rank  INT NOT NULL
    );
  `);
}
