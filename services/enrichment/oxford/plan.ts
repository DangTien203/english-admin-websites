/**
 * The plan of a seeding run (docs/lookup-runbook.md §13): which Oxford words are NOT sent, why, and what sending the rest costs.
 *
 * Reads the database (dictionary_entries, word_forms, word_enrichment_jobs, ref_word_frequency, api_usage_counters); writes nothing.
 */
import { MODEL_PRICES } from '../pricing';
import type { OxfordWord, ParsedOxford } from './list';
import { bySendOrder, selectWords, type SeedWord, type SelectionOptions } from './selection';

export interface Queryable {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

/** Why a valid Oxford word is not in the list to send. */
export type ExclusionReason = 'in_dictionary' | 'in_word_forms' | 'in_queue' | 'done_before';

export interface Exclusion {
  word: string;
  reason: ExclusionReason;
  /** for done_before: the latest job's "status / reason" */
  detail?: string;
}

export interface Classified {
  eligible: OxfordWord[];
  excluded: Exclusion[];
}

/**
 * A job row that closes the matter: sending the word again would spend tokens to get the same answer. Only outcomes that do not leave an
 * entry behind can close it: the word was refused (rejected: unknown word, proper noun, not English), is a variant of another word
 * (skipped: variant_form, lemma_mismatch), or its draft stayed invalid after the correction (failed: invalid_output).
 *
 * A job that SUCCEEDED, or was skipped as "exists", is not final: the entry it made (or found) is checked directly, and if it has been
 * deleted since (for example by scripts/dev/cleanup-auto-entries.ts) the word is eligible again. Rows that failed for a reason that
 * may pass (upstream error, budget, daily cap, stale, dead letter, queue error, config error) do not close it either.
 */
export function isFinalOutcome(status: string, reason: string | null): boolean {
  if (status === 'rejected') return true;
  if (status === 'skipped') return ['variant_form', 'lemma_mismatch'].includes(reason ?? '');
  if (status === 'failed') return reason === 'invalid_output';
  return false;
}

const BATCH = 2000;
const chunks = <T>(list: readonly T[], size = BATCH): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Splits the words into those to send and those to leave, with the reason. An entry counts whether it is published or not; a word
 * form counts; so does a queued / running job. A word whose latest job already ended for good (isFinalOutcome) is left too, so a
 * rerun after a stop continues where it stopped and spends nothing twice.
 */
export async function classifyWords(db: Queryable, words: readonly OxfordWord[]): Promise<Classified> {
  const names = words.map((w) => w.word);
  const inDictionary = new Set<string>();
  const inForms = new Set<string>();
  const inQueue = new Set<string>();
  const doneBefore = new Map<string, string>();

  for (const part of chunks(names)) {
    const entries = await db.query(
      `SELECT LOWER(headword) AS w FROM dictionary_entries WHERE LOWER(headword) = ANY($1::text[])
       UNION SELECT LOWER(lemma) FROM dictionary_entries WHERE LOWER(lemma) = ANY($1::text[])`,
      [part]
    );
    for (const r of entries.rows) inDictionary.add(r.w);

    const forms = await db.query(`SELECT DISTINCT LOWER(form_value) AS w FROM word_forms WHERE LOWER(form_value) = ANY($1::text[])`, [part]);
    for (const r of forms.rows) inForms.add(r.w);

    const active = await db.query(`SELECT DISTINCT word AS w FROM word_enrichment_jobs WHERE status IN ('queued', 'running') AND word = ANY($1::text[])`, [part]);
    for (const r of active.rows) inQueue.add(r.w);

    const latest = await db.query(
      `SELECT DISTINCT ON (word) word AS w, status, reason FROM word_enrichment_jobs
        WHERE word = ANY($1::text[]) AND status NOT IN ('queued', 'running')
        ORDER BY word, created_at DESC`,
      [part]
    );
    for (const r of latest.rows) if (isFinalOutcome(r.status, r.reason)) doneBefore.set(r.w, `${r.status} / ${r.reason ?? '-'}`);
  }

  const eligible: OxfordWord[] = [];
  const excluded: Exclusion[] = [];
  for (const w of words) {
    if (inDictionary.has(w.word)) excluded.push({ word: w.word, reason: 'in_dictionary' });
    else if (inForms.has(w.word)) excluded.push({ word: w.word, reason: 'in_word_forms' });
    else if (inQueue.has(w.word)) excluded.push({ word: w.word, reason: 'in_queue' });
    else if (doneBefore.has(w.word)) excluded.push({ word: w.word, reason: 'done_before', detail: doneBefore.get(w.word) });
    else eligible.push(w);
  }
  return { eligible, excluded };
}

/** ref_word_frequency.rank of each word (rank 1 = most common); words that are not in the table are absent from the map. */
export async function loadRanks(refDb: Queryable, words: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunks(words)) {
    const { rows } = await refDb.query(`SELECT word, rank FROM ref_word_frequency WHERE word = ANY($1::text[])`, [part]);
    for (const r of rows) out.set(r.word, Number(r.rank));
  }
  return out;
}

export function withRanks(words: readonly OxfordWord[], ranks: ReadonlyMap<string, number>): SeedWord[] {
  return words.map((w) => ({ ...w, rank: ranks.get(w.word) ?? null }));
}

export interface SeedPlan {
  parsed: ParsedOxford;
  /** valid words not sent, with the reason */
  excluded: Exclusion[];
  /** valid words that could be sent, in sending order, with their frequency rank */
  eligible: SeedWord[];
  /** what this run sends (selection options applied), in sending order */
  selected: SeedWord[];
}

/** Everything the dry run prints, and the words a confirmed run sends. Reads the database; writes nothing. */
export async function buildSeedPlan(db: Queryable, refDb: Queryable, parsed: ParsedOxford, options: SelectionOptions = {}): Promise<SeedPlan> {
  const { eligible, excluded } = await classifyWords(db, parsed.words);
  const ranks = await loadRanks(refDb, eligible.map((w) => w.word));
  const ranked = withRanks(eligible, ranks).sort(bySendOrder);
  return { parsed, excluded, eligible: ranked, selected: selectWords(ranked, options) };
}

// ── estimates ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Estimated USD per word when there is no history yet (docs/lookup-runbook.md §10.3: $0.0007 to $0.0015 a word). */
export const DEFAULT_COST_PER_WORD_USD = 0.00085;
/** Seconds of work per word when there is no history yet (docs/lookup-runbook.md §10.4: "mỗi job ~10 s"). */
export const DEFAULT_SECONDS_PER_WORD = 10;
/** The system prompt that every job reads from the cache (docs/lookup-acceptance-report.md; the job row stores only the total). */
export const ASSUMED_CACHED_PROMPT_TOKENS = 7859;

export interface HistoryStats {
  /** job rows that reached Haiku (input_tokens > 0) */
  jobsWithTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** median seconds between created_at and finished_at of succeeded jobs that ended within 5 minutes; null if none */
  medianSeconds: number | null;
  avgAttempts: number | null;
}

export async function loadHistory(db: Queryable): Promise<HistoryStats> {
  const tokens = await db.query(
    `SELECT count(*)::int AS n, COALESCE(sum(input_tokens), 0)::bigint AS inp, COALESCE(sum(output_tokens), 0)::bigint AS outp,
            avg(attempts)::float AS attempts
       FROM word_enrichment_jobs WHERE input_tokens > 0`
  );
  const time = await db.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - created_at)))::float AS median
       FROM word_enrichment_jobs
      WHERE status = 'succeeded' AND finished_at IS NOT NULL AND finished_at - created_at < interval '5 minutes'`
  );
  const t = tokens.rows[0];
  return {
    jobsWithTokens: Number(t.n),
    inputTokens: Number(t.inp),
    outputTokens: Number(t.outp),
    medianSeconds: time.rows[0]?.median === null || time.rows[0]?.median === undefined ? null : Number(time.rows[0].median),
    avgAttempts: t.attempts === null || t.attempts === undefined ? null : Number(t.attempts),
  };
}

/** Cost of `n` jobs that read `cachedPerJob` prompt tokens from the cache: the formula of docs/lookup-runbook.md §11.4. */
export function costFromTotals(model: string, jobs: number, inputTokens: number, outputTokens: number): number | null {
  const price = MODEL_PRICES[model];
  if (!price || jobs <= 0) return null;
  // Totals of many jobs: the long-prompt rate of one request must not be applied to a sum, so the base rates are used.
  const cached = Math.min(ASSUMED_CACHED_PROMPT_TOKENS * jobs, inputTokens);
  return ((inputTokens - cached) * price.inputPerMTok + outputTokens * price.outputPerMTok + cached * price.cacheReadPerMTok) / 1_000_000;
}

export interface Estimate {
  words: number;
  /** USD for all the words */
  costUsd: number;
  costPerWordUsd: number;
  /** "history" = average of the job rows in the database; "default" = the figure of the runbook, an estimate */
  costSource: 'history' | 'default';
  historyJobs: number;
  secondsPerWord: number;
  timeSource: 'history' | 'default';
  concurrency: number;
  /** wall-clock seconds of the worker for all the words at `concurrency` */
  workerSeconds: number;
  /** days needed with the daily cap, counting what today's counter already used */
  days: number;
  usedToday: number;
  dailyCap: number;
}

export function estimateRun(o: { words: number; model: string; history: HistoryStats; concurrency: number; dailyCap: number; usedToday: number }): Estimate {
  const perHistory = costFromTotals(o.model, o.history.jobsWithTokens, o.history.inputTokens, o.history.outputTokens);
  const costSource = perHistory !== null && o.history.jobsWithTokens >= 5 ? 'history' : 'default';
  const costPerWordUsd = costSource === 'history' ? (perHistory as number) / o.history.jobsWithTokens : DEFAULT_COST_PER_WORD_USD;
  const timeSource = o.history.medianSeconds !== null && o.history.medianSeconds > 0 ? 'history' : 'default';
  const secondsPerWord = timeSource === 'history' ? (o.history.medianSeconds as number) : DEFAULT_SECONDS_PER_WORD;
  const remainingToday = Math.max(0, o.dailyCap - o.usedToday);
  let days = 0;
  if (o.words > 0) days = o.words <= remainingToday ? 1 : o.dailyCap > 0 ? 1 + Math.ceil((o.words - remainingToday) / o.dailyCap) : Infinity;
  return {
    words: o.words,
    costUsd: costPerWordUsd * o.words,
    costPerWordUsd,
    costSource,
    historyJobs: o.history.jobsWithTokens,
    secondsPerWord,
    timeSource,
    concurrency: o.concurrency,
    workerSeconds: Math.ceil((o.words * secondsPerWord) / Math.max(1, o.concurrency)),
    days,
    usedToday: o.usedToday,
    dailyCap: o.dailyCap,
  };
}

export async function jobsUsedToday(db: Queryable, now: Date = new Date()): Promise<number> {
  const { rows } = await db.query(`SELECT used FROM api_usage_counters WHERE provider = 'enrichment' AND unit = 'jobs' AND period = $1`, [now.toISOString().slice(0, 10)]);
  return rows[0] ? Number(rows[0].used) : 0;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'không xác định';
  if (seconds < 90) return `${Math.round(seconds)} giây`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} phút`;
  return `${(minutes / 60).toFixed(1)} giờ`;
}

export const usd = (value: number): string => `$${value.toFixed(value < 0.1 ? 4 : 2)}`;
