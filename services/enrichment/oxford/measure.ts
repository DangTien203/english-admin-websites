/**
 * Numbers read from the database before and after a seeding run (size, token counters). Read only.
 */
import type { Queryable } from './plan';

/** The tables a seeding run writes to: their total size (with indexes and TOAST) is the growth that is reported. */
export const SEED_TABLES = [
  'dictionary_entries',
  'entry_senses',
  'sense_examples',
  'word_forms',
  'sense_synonyms',
  'sense_antonyms',
  'entry_synonyms',
  'entry_antonyms',
  'entry_tags',
  'entry_answer_aliases',
  'entry_idioms',
  'phrasal_verbs',
  'collocations',
  'entry_edit_history',
  'word_families',
  'word_family_members',
  'word_enrichment_jobs',
] as const;

export interface DbMeasure {
  dbBytes: number;
  tableBytes: number;
  perTable: Record<string, number>;
  /** api_usage_counters, provider 'anthropic', current UTC month */
  anthropicInputTokens: number;
  anthropicOutputTokens: number;
}

export async function measureDb(db: Queryable, now: Date = new Date()): Promise<DbMeasure> {
  const size = await db.query(`SELECT pg_database_size(current_database())::bigint AS bytes`);
  const perTable: Record<string, number> = {};
  const { rows } = await db.query(
    `SELECT t.name, COALESCE(pg_total_relation_size(to_regclass(t.name)), 0)::bigint AS bytes FROM UNNEST($1::text[]) AS t(name)`,
    [[...SEED_TABLES]]
  );
  for (const r of rows) perTable[r.name] = Number(r.bytes);
  const period = now.toISOString().slice(0, 7);
  const usage = await db.query(`SELECT unit, used FROM api_usage_counters WHERE provider = 'anthropic' AND period = $1`, [period]);
  const used = (unit: string) => Number(usage.rows.find((r) => r.unit === unit)?.used ?? 0);
  return {
    dbBytes: Number(size.rows[0].bytes),
    tableBytes: Object.values(perTable).reduce((s, v) => s + v, 0),
    perTable,
    anthropicInputTokens: used('input_tokens'),
    anthropicOutputTokens: used('output_tokens'),
  };
}

export const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/**
 * One statement per table, written out in full: the SQL audit (tests/security/sqlParameterization.test.ts) allows no spliced text, and
 * a table name is the kind of thing that must not be built from anything.
 */
const PAYLOAD_SQL: string[] = [
  "SELECT 'dictionary_entries' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM dictionary_entries x WHERE x.id = ANY($1::uuid[])",
  "SELECT 'entry_senses' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM entry_senses x WHERE x.entry_id = ANY($1::uuid[])",
  "SELECT 'sense_examples' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM sense_examples x JOIN entry_senses s ON s.id = x.sense_id WHERE s.entry_id = ANY($1::uuid[])",
  "SELECT 'sense_synonyms' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM sense_synonyms x JOIN entry_senses s ON s.id = x.sense_id WHERE s.entry_id = ANY($1::uuid[])",
  "SELECT 'sense_antonyms' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM sense_antonyms x JOIN entry_senses s ON s.id = x.sense_id WHERE s.entry_id = ANY($1::uuid[])",
  "SELECT 'word_forms' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM word_forms x WHERE x.entry_id = ANY($1::uuid[])",
  "SELECT 'entry_tags' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM entry_tags x WHERE x.entry_id = ANY($1::uuid[])",
  "SELECT 'entry_answer_aliases' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM entry_answer_aliases x WHERE x.entry_id = ANY($1::uuid[])",
  "SELECT 'entry_idioms' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM entry_idioms x WHERE x.entry_id = ANY($1::uuid[])",
  "SELECT 'phrasal_verbs' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM phrasal_verbs x WHERE x.entry_id = ANY($1::uuid[])",
  "SELECT 'collocations' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM collocations x WHERE x.entry_id = ANY($1::uuid[])",
  "SELECT 'entry_synonyms' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM entry_synonyms x WHERE x.entry_id = ANY($1::uuid[])",
  "SELECT 'entry_antonyms' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM entry_antonyms x WHERE x.entry_id = ANY($1::uuid[])",
  "SELECT 'entry_edit_history' AS t, COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS bytes FROM entry_edit_history x WHERE x.entry_id = ANY($1::uuid[])",
];

/**
 * The size of the DATA of some entries and of everything that hangs on them (sum of the row sizes, indexes NOT included). The size of the
 * tables on disk barely moves when new rows reuse space freed by deleted ones (the database was cleaned of 38 entries a day earlier), so
 * this is the figure that scales: it is what N more entries add once the free space is used up.
 */
export async function payloadBytes(db: Queryable, entryIds: readonly string[]): Promise<{ total: number; perTable: Record<string, number> }> {
  if (entryIds.length === 0) return { total: 0, perTable: {} };
  const { rows } = await db.query(PAYLOAD_SQL.join('\nUNION ALL\n'), [[...entryIds]]);
  const perTable: Record<string, number> = {};
  for (const r of rows) perTable[r.t] = Number(r.bytes);
  return { total: Object.values(perTable).reduce((s, v) => s + v, 0), perTable };
}
