/**
 * Queries behind the review pages of the entries that the enrichment job created (P8): dictionary_entries whose admin_note
 * starts with '[auto]' (docs/lookup-spec.md §10.2). Thin SQL wrappers; the rules are in services/lookup/adminRules.ts.
 *
 * Every function that changes data takes the connection to use, so the caller can run several of them in ONE transaction
 * (publishing and its entry_edit_history line commit together).
 */
import pool from '../config/db';
import { paginate, type PaginateResult } from '../helpers/pagination';
import { likePattern } from './EnrichmentJobAdmin';
import type { TierAFacts } from '../services/lookup/adminRules';

export interface Queryable {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export type AutoEntryStatus = 'pending' | 'published' | 'all';

export interface AutoEntryListRow {
  id: string;
  headword: string;
  lemma: string;
  pos: string[];
  meaning_vi: string | null;
  cefr_level: string | null;
  published: boolean;
  admin_note: string | null;
  created_at: Date;
  sense_count: number;
}

/** Count of children that tier A needs, computed for a set of entries in one query. */
const TIER_A_FACTS_SQL = `
  SELECT e.id, e.headword, e.lemma, e.pos, e.meaning_vi,
         (SELECT COUNT(*)::int FROM entry_senses s
           WHERE s.entry_id = e.id AND BTRIM(COALESCE(s.definition_en, '')) <> '' AND BTRIM(COALESCE(s.definition_vi, '')) <> '') AS complete_senses,
         (SELECT COUNT(*)::int FROM sense_examples x JOIN entry_senses s ON s.id = x.sense_id
           WHERE s.entry_id = e.id AND BTRIM(COALESCE(x.example_en, '')) <> '' AND BTRIM(COALESCE(x.example_vi, '')) <> '') AS complete_examples
    FROM dictionary_entries e
   WHERE e.id = ANY($1::uuid[])`;

export async function tierAFactsFor(db: Queryable, ids: string[]): Promise<Map<string, TierAFacts>> {
  const out = new Map<string, TierAFacts>();
  if (ids.length === 0) return out;
  const { rows } = await db.query(TIER_A_FACTS_SQL, [ids]);
  for (const r of rows) {
    out.set(r.id, {
      headword: r.headword,
      lemma: r.lemma,
      pos: r.pos,
      meaning_vi: r.meaning_vi,
      complete_senses: r.complete_senses,
      complete_examples: r.complete_examples,
    });
  }
  return out;
}

export async function listAutoEntries(
  filters: { status: AutoEntryStatus; q?: string },
  page: number,
  limit: number
): Promise<PaginateResult<AutoEntryListRow>> {
  const conditions: string[] = [`e.admin_note LIKE '[auto]%'`];
  const params: any[] = [];
  if (filters.status === 'pending') conditions.push('e.published = FALSE');
  else if (filters.status === 'published') conditions.push('e.published = TRUE');
  if (filters.q) {
    params.push(likePattern(filters.q.toLowerCase()));
    conditions.push(`(LOWER(e.headword) LIKE $${params.length} ESCAPE '\\' OR LOWER(e.lemma) LIKE $${params.length} ESCAPE '\\')`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const n = params.length;
  const query = `
    SELECT e.id, e.headword, e.lemma, e.pos, e.meaning_vi, e.cefr_level, e.published, e.admin_note, e.created_at,
           (SELECT COUNT(*)::int FROM entry_senses s WHERE s.entry_id = e.id) AS sense_count
      FROM dictionary_entries e
      ${where}
     ORDER BY e.created_at DESC, e.headword
     LIMIT $${n + 1} OFFSET $${n + 2}`;
  const countQuery = `SELECT COUNT(*)::int AS count FROM dictionary_entries e ${where}`;
  return paginate<AutoEntryListRow>(query, countQuery, params, params, page, limit);
}

// ── detail ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AutoEntryParts {
  entry: any;
  senses: any[];
  examples: any[];
  senseSynonyms: any[];
  senseAntonyms: any[];
  tags: any[];
  entrySynonyms: any[];
  entryAntonyms: any[];
  forms: any[];
  idioms: any[];
  phrasalVerbs: any[];
  collocations: any[];
  history: any[];
  latestJob: any | null;
}

/** The entry with every child table, or null when the id is not an '[auto]' entry. Read-only; independent queries run together. */
export async function loadAutoEntry(id: string): Promise<AutoEntryParts | null> {
  const found = await pool.query(`SELECT * FROM dictionary_entries WHERE id = $1 AND admin_note LIKE '[auto]%'`, [id]);
  const entry = found.rows[0];
  if (!entry) return null;

  const q = (sql: string) => pool.query(sql, [id]).then((r) => r.rows);
  const [senses, examples, senseSynonyms, senseAntonyms, tags, entrySynonyms, entryAntonyms, forms, idioms, phrasalVerbs, collocations, history, jobs] =
    await Promise.all([
      q(`SELECT * FROM entry_senses WHERE entry_id = $1 ORDER BY sense_order, created_at, id`),
      q(`SELECT x.* FROM sense_examples x JOIN entry_senses s ON s.id = x.sense_id WHERE s.entry_id = $1 ORDER BY x.sort_order, x.id`),
      q(`SELECT ss.sense_id, ss.synonym_text FROM sense_synonyms ss JOIN entry_senses s ON s.id = ss.sense_id WHERE s.entry_id = $1 ORDER BY ss.synonym_text`),
      q(`SELECT sa.sense_id, sa.antonym_text FROM sense_antonyms sa JOIN entry_senses s ON s.id = sa.sense_id WHERE s.entry_id = $1 ORDER BY sa.antonym_text`),
      q(`SELECT t.id, t.name FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = $1 ORDER BY t.name`),
      q(`SELECT d.id, d.headword, d.published FROM entry_synonyms es JOIN dictionary_entries d ON d.id = es.synonym_id WHERE es.entry_id = $1 ORDER BY d.headword`),
      q(`SELECT d.id, d.headword, d.published FROM entry_antonyms ea JOIN dictionary_entries d ON d.id = ea.antonym_id WHERE ea.entry_id = $1 ORDER BY d.headword`),
      q(`SELECT form_type, form_value, ipa, sort_order FROM word_forms WHERE entry_id = $1 ORDER BY sort_order, form_value`),
      q(`SELECT idiom_text, definition_en, definition_vi, example_en, example_vi, register FROM entry_idioms WHERE entry_id = $1 ORDER BY created_at, id`),
      q(`SELECT phrasal_verb, particle, is_separable, definition_en, definition_vi, example_en, example_vi FROM phrasal_verbs WHERE entry_id = $1 ORDER BY created_at, id`),
      q(`SELECT collocation, pattern, example_en, example_vi FROM collocations WHERE entry_id = $1 ORDER BY collocation`),
      q(`SELECT h.field_name, h.old_value, h.new_value, h.created_at, a.full_name AS admin_name
           FROM entry_edit_history h LEFT JOIN admin_accounts a ON a.id = h.admin_id
          WHERE h.entry_id = $1 ORDER BY h.created_at DESC, h.id DESC LIMIT 10`),
      q(`SELECT id, status, reason, attempts, model, input_tokens, output_tokens, created_at, finished_at
           FROM word_enrichment_jobs WHERE entry_id = $1 ORDER BY created_at DESC LIMIT 1`),
    ]);

  return {
    entry,
    senses,
    examples,
    senseSynonyms,
    senseAntonyms,
    tags,
    entrySynonyms,
    entryAntonyms,
    forms,
    idioms,
    phrasalVerbs,
    collocations,
    history,
    latestJob: jobs[0] ?? null,
  };
}

// ── publishing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LockedEntry {
  id: string;
  headword: string;
  published: boolean;
  admin_note: string | null;
}

/**
 * Locks the rows (FOR UPDATE) so two admins cannot publish / hide the same entry at once, and returns the ones that exist.
 * Must run inside a transaction. Ordered by id, the same order for everybody, so concurrent batches cannot deadlock.
 */
export async function lockEntries(db: Queryable, ids: string[]): Promise<LockedEntry[]> {
  const { rows } = await db.query(
    `SELECT id, headword, published, admin_note FROM dictionary_entries WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [ids]
  );
  return rows;
}

/** Sets published for entries that currently have the opposite value, and writes one entry_edit_history line each. */
export async function setPublished(db: Queryable, ids: string[], published: boolean, adminId: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query(
    `UPDATE dictionary_entries SET published = $2 WHERE id = ANY($1::uuid[]) AND published IS DISTINCT FROM $2 RETURNING id`,
    [ids, published]
  );
  const changed: string[] = rows.map((r) => r.id);
  if (changed.length > 0) {
    await db.query(
      `INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value)
       SELECT t.id, $2::uuid, 'published', $3, $4 FROM UNNEST($1::uuid[]) AS t(id)`,
      [changed, adminId, String(!published), String(published)]
    );
  }
  return changed;
}
