/**
 * Queries behind the admin pages of the enrichment queue (P8). Read-only: the ledger is written by the enqueuer and the worker
 * (models/EnrichmentJob.ts), never by the admin pages directly. Thin SQL wrappers, no rules (those live in services/lookup/adminRules.ts).
 */
import pool from '../config/db';
import { paginate, type PaginateResult } from '../helpers/pagination';

export interface JobFilters {
  status?: string;
  /** exact reason code; the word 'none' selects jobs without a reason */
  reason?: string;
  /** part of the word */
  q?: string;
  /** UTC dates, inclusive: created_at from the start of `from` to the end of `to` */
  from?: string;
  to?: string;
}

export interface JobListRow {
  id: string;
  word: string;
  status: string;
  reason: string | null;
  attempts: number;
  entry_id: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
  finished_at: Date | null;
  entry_headword: string | null;
  entry_published: boolean | null;
  entry_is_auto: boolean | null;
  /** a queued / running row exists for the same word (a retry would collide with it) */
  word_active: boolean;
}

/** Escapes % _ \ so that user text is matched literally by ILIKE. */
export const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const DAY_MS = 24 * 60 * 60 * 1000;

function dayStart(date: string): string {
  return `${date}T00:00:00.000Z`;
}
function nextDayStart(date: string): string {
  return new Date(Date.parse(dayStart(date)) + DAY_MS).toISOString();
}

function jobWhere(f: JobFilters): { where: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (f.status) add('j.status = ?', f.status);
  if (f.reason === 'none') conditions.push('j.reason IS NULL');
  else if (f.reason) add('j.reason = ?', f.reason);
  if (f.q) add(`j.word ILIKE ? ESCAPE '\\'`, likePattern(f.q));
  if (f.from) add('j.created_at >= ?::timestamptz', dayStart(f.from));
  if (f.to) add('j.created_at < ?::timestamptz', nextDayStart(f.to));
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function listJobs(filters: JobFilters, page: number, limit: number): Promise<PaginateResult<JobListRow>> {
  const { where, params } = jobWhere(filters);
  const n = params.length;
  const query = `
    SELECT j.id, j.word, j.status, j.reason, j.attempts, j.entry_id, j.model, j.input_tokens, j.output_tokens,
           j.created_at, j.finished_at,
           e.headword AS entry_headword, e.published AS entry_published,
           COALESCE(e.admin_note LIKE '[auto]%', FALSE) AS entry_is_auto,
           EXISTS (SELECT 1 FROM word_enrichment_jobs a WHERE a.word = j.word AND a.status IN ('queued', 'running')) AS word_active
      FROM word_enrichment_jobs j
      LEFT JOIN dictionary_entries e ON e.id = j.entry_id
      ${where}
     ORDER BY j.created_at DESC, j.id
     LIMIT $${n + 1} OFFSET $${n + 2}`;
  const countQuery = `SELECT COUNT(*)::int AS count FROM word_enrichment_jobs j ${where}`;
  return paginate<JobListRow>(query, countQuery, params, params, page, limit);
}

/** The ledger row with the same joins as the list (one job). */
export async function findJob(id: string): Promise<JobListRow | null> {
  const { rows } = await pool.query(
    `SELECT j.id, j.word, j.status, j.reason, j.attempts, j.entry_id, j.model, j.input_tokens, j.output_tokens,
            j.created_at, j.finished_at,
            e.headword AS entry_headword, e.published AS entry_published,
            COALESCE(e.admin_note LIKE '[auto]%', FALSE) AS entry_is_auto,
            EXISTS (SELECT 1 FROM word_enrichment_jobs a WHERE a.word = j.word AND a.status IN ('queued', 'running')) AS word_active
       FROM word_enrichment_jobs j
       LEFT JOIN dictionary_entries e ON e.id = j.entry_id
      WHERE j.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export interface MissingWordRow {
  word: string;
  lookups: number;
  last_lookup_at: Date;
  job_status: string | null;
  job_reason: string | null;
  /** an entry already exists for the word (published or not) */
  entry_id: string | null;
  entry_published: boolean | null;
  entry_is_auto: boolean | null;
}

/**
 * Words that readers looked up and the dictionary could not serve (word_lookups.lookup_result 'translation' = temporary answer,
 * 'not_found'), most looked-up first. Rows from before word_text existed have it empty and are skipped. A word that has since
 * got a PUBLISHED entry (by headword, lemma or word form) is no longer missing; one with an unpublished entry still is, and
 * comes with the entry so the page can say "waiting for review".
 */
/** Most looked-up words examined before the "already published" filter; those words are missing by construction, so this is generous. */
const CANDIDATE_WORDS = 400;

export async function topMissingWords(days: number, limit: number): Promise<MissingWordRow[]> {
  const { rows } = await pool.query(
    `WITH looked AS (
       SELECT LOWER(BTRIM(word_text)) AS word, COUNT(*)::int AS lookups, MAX(created_at) AS last_lookup_at
         FROM word_lookups
        WHERE lookup_result IN ('translation', 'not_found')
          AND word_text IS NOT NULL AND BTRIM(word_text) <> ''
          AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY 1
        ORDER BY lookups DESC, word
        LIMIT ${CANDIDATE_WORDS}
     )
     SELECT l.word, l.lookups, l.last_lookup_at,
            j.status AS job_status, j.reason AS job_reason,
            en.id AS entry_id, en.published AS entry_published,
            COALESCE(en.admin_note LIKE '[auto]%', FALSE) AS entry_is_auto
       FROM looked l
       LEFT JOIN LATERAL (
         SELECT id, published, admin_note FROM dictionary_entries d
          WHERE LOWER(d.headword) = l.word OR LOWER(d.lemma) = l.word
             OR d.id IN (SELECT wf.entry_id FROM word_forms wf WHERE LOWER(wf.form_value) = l.word)
          ORDER BY d.published DESC, d.created_at LIMIT 1
       ) en ON TRUE
       LEFT JOIN LATERAL (
         SELECT status, reason FROM word_enrichment_jobs w WHERE w.word = l.word ORDER BY w.created_at DESC LIMIT 1
       ) j ON TRUE
      WHERE en.id IS NULL OR en.published = FALSE
      ORDER BY l.lookups DESC, l.word
      LIMIT $2`,
    [days, limit]
  );
  return rows;
}
