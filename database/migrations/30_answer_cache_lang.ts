import type { PoolClient } from 'pg';

/**
 * Migration 30: language dimension for the semantic grading cache.
 *
 * Box 4/5 Leitner cards are graded on both the Vietnamese meaning and the
 * English meaning. Both answers are cached in answer_semantic_cache, so the
 * cache key must include the answer language ('vi' | 'en').
 */
const migration = async (client: PoolClient): Promise<void> => {
  await client.query(`
    ALTER TABLE answer_semantic_cache
      ADD COLUMN IF NOT EXISTS lang VARCHAR(5) NOT NULL DEFAULT 'vi'
        CHECK (lang IN ('vi','en'));
  `);

  await client.query(`
    ALTER TABLE answer_semantic_cache
      DROP CONSTRAINT IF EXISTS answer_semantic_cache_entry_id_normalized_answer_key;
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_answer_semantic_cache_entry_lang_answer
      ON answer_semantic_cache(entry_id, lang, normalized_answer);
  `);

  console.log('  [✓] answer_semantic_cache.lang + unique (entry_id, lang, normalized_answer)');
};

export = migration;
