import type { PoolClient } from 'pg';
import { createRefTables } from '../refdata/schema';

/**
 * Migration 33: foundation for fast word lookup + dictionary self-enrichment
 * (docs/lookup-spec.md §2).
 *
 * Adds (idempotent, no existing table is altered):
 *   - ref_wiktionary_en, ref_word_frequency   → main DB, unless REFDATA_DATABASE_URL is set
 *                                               (then run `npm run db:migrate-refdata` against that DB)
 *   - word_enrichment_jobs                     → job ledger (+ updated_at trigger)
 *   - api_usage_counters                       → monthly/daily quota counters
 *   - lower() lookup indexes on dictionary_entries and word_forms
 *
 * word_translation_cache (migration 26) is DEPRECATED by this feature: it is no longer
 * read or written once the new lookup path ships, but the table is kept for rollback.
 */
const migration = async (client: PoolClient): Promise<void> => {
  // 1. Reference data (read-only lookup tables)
  if (process.env.REFDATA_DATABASE_URL && process.env.REFDATA_DATABASE_URL.trim() !== '') {
    console.log('  [i] REFDATA_DATABASE_URL set → ref_* tables skipped here; run: npm run db:migrate-refdata');
  } else {
    await createRefTables(client);
    console.log('  [✓] ref_wiktionary_en + ref_word_frequency');
  }

  // 2. Enrichment job ledger
  await client.query(`
    CREATE TABLE IF NOT EXISTS word_enrichment_jobs (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      word          TEXT NOT NULL,
      status        VARCHAR(20) NOT NULL
                    CHECK (status IN ('queued','running','succeeded','rejected','failed','skipped')),
      reason        TEXT,
      attempts      INT NOT NULL DEFAULT 0,
      entry_id      UUID REFERENCES dictionary_entries(id) ON DELETE SET NULL,
      requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      model         TEXT,
      input_tokens  INT,
      output_tokens INT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      finished_at   TIMESTAMPTZ
    );
  `);

  // At most one active job per word.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_word_enrichment_jobs_active_word
      ON word_enrichment_jobs(word) WHERE status IN ('queued','running');
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_word_enrichment_jobs_status_created
      ON word_enrichment_jobs(status, created_at);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_word_enrichment_jobs_entry
      ON word_enrichment_jobs(entry_id) WHERE entry_id IS NOT NULL;
  `);

  // update_updated_at() is created by migration 01; same trigger pattern as other tables.
  await client.query(`
    DROP TRIGGER IF EXISTS trg_word_enrichment_jobs_updated_at ON word_enrichment_jobs;
    CREATE TRIGGER trg_word_enrichment_jobs_updated_at
      BEFORE UPDATE ON word_enrichment_jobs
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  `);
  console.log('  [✓] word_enrichment_jobs (+ trigger, 3 indexes)');

  // 3. Usage counters. Increment atomically with
  //    INSERT ... ON CONFLICT (provider, period, unit) DO UPDATE SET used = api_usage_counters.used + EXCLUDED.used
  await client.query(`
    CREATE TABLE IF NOT EXISTS api_usage_counters (
      provider    TEXT NOT NULL,
      period      TEXT NOT NULL,
      unit        TEXT NOT NULL,
      used        BIGINT NOT NULL DEFAULT 0,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (provider, period, unit)
    );
  `);
  console.log('  [✓] api_usage_counters');

  // 4. Case-insensitive lookup indexes (existing idx_dict_headword / idx_dict_lemma are plain btree)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_dict_headword_lower ON dictionary_entries (lower(headword));
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_dict_lemma_lower ON dictionary_entries (lower(lemma));
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_word_forms_value_lower ON word_forms (lower(form_value));
  `);
  console.log('  [✓] lower() lookup indexes (dictionary_entries.headword/lemma, word_forms.form_value)');
};

export = migration;
