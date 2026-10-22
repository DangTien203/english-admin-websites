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
  /** eligible words whose latest earlier job did not make an entry and may be tried again: "failed / invalid_output (1 lượt)", … */
  retries: Map<string, string>;
}

/** A draft that stays invalid after its own repair is tried again ONCE (Haiku is not deterministic); after this many such runs it is final. */
export const MAX_INVALID_OUTPUT_RUNS = 2;

/**
 * A job row that closes the matter: sending the word again would spend tokens to get the same answer. Only outcomes that do not leave an
 * entry behind can close it: the word was refused (rejected: unknown word, proper noun, not English), is a variant of another word
 * (skipped: variant_form, lemma_mismatch), or its draft stayed invalid (failed: invalid_output) in `invalidRuns` runs, at least
 * MAX_INVALID_OUTPUT_RUNS. The first invalid_output is NOT final: the word is sent once more.
 *
 * A job that SUCCEEDED, or was skipped as "exists", is not final: the entry it made (or found) is checked directly, and if it has been
 * deleted since (for example by scripts/dev/cleanup-auto-entries.ts) the word is eligible again. Rows that failed for a reason that
 * may pass (upstream error, budget, daily cap, stale, dead letter, queue error, config error) do not close it either.
 */
export function isFinalOutcome(status: string, reason: string | null, invalidRuns = 1): boolean {
  if (status === 'rejected') return true;
  if (status === 'skipped') return ['variant_form', 'lemma_mismatch'].includes(reason ?? '');
  if (status === 'failed') return reason === 'invalid_output' && invalidRuns >= MAX_INVALID_OUTPUT_RUNS;
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
  const earlier = new Map<string, string>();

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
      `SELECT DISTINCT ON (j.word) j.word AS w, j.status, j.reason,
              (SELECT count(*)::int FROM word_enrichment_jobs k WHERE k.word = j.word AND k.status = 'failed' AND k.reason = 'invalid_output') AS invalid_runs
         FROM word_enrichment_jobs j
        WHERE j.word = ANY($1::text[]) AND j.status NOT IN ('queued', 'running')
        ORDER BY j.word, j.created_at DESC`,
      [part]
    );
    for (const r of latest.rows) {
      const label = r.reason === 'invalid_output' ? `${r.status} / invalid_output (${r.invalid_runs} lượt)` : `${r.status} / ${r.reason ?? '-'}`;
      if (isFinalOutcome(r.status, r.reason, Number(r.invalid_runs))) doneBefore.set(r.w, label);
      else earlier.set(r.w, label);
    }
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
  const retries = new Map<string, string>();
  for (const w of eligible) if (earlier.has(w.word)) retries.set(w.word, earlier.get(w.word) as string);
  return { eligible, excluded, retries };
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
  /** of `selected`: the words that are SENT AGAIN because an earlier job did not make an entry, with that job's "status / reason" */
  retries: Array<{ word: string; detail: string }>;
}

/** Everything the dry run prints, and the words a confirmed run sends. Reads the database; writes nothing. */
export async function buildSeedPlan(db: Queryable, refDb: Queryable, parsed: ParsedOxford, options: SelectionOptions = {}, only?: ReadonlySet<string>): Promise<SeedPlan> {
  // `only` (--retry-last-run): look at these words and no others
  const words = only ? parsed.words.filter((w) => only.has(w.word)) : parsed.words;
  const { eligible, excluded, retries } = await classifyWords(db, words);
  const ranks = await loadRanks(refDb, eligible.map((w) => w.word));
  const ranked = withRanks(eligible, ranks).sort(bySendOrder);
  const selected = selectWords(ranked, options);
  return { parsed, excluded, eligible: ranked, selected, retries: selected.filter((w) => retries.has(w.word)).map((w) => ({ word: w.word, detail: retries.get(w.word) as string })) };
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
  /**
   * WALL-CLOCK seconds per word while the worker was busy: the median gap between two succeeded jobs finishing one after the other
   * (gaps over a minute are idle time and left out), last 30 days; null if there is none. It is what the worker really achieved at the
   * concurrency it ran with; the time from created_at to finished_at is NOT used (it includes the wait in the queue: a batch of 50
   * queued at once made it look like 130 seconds per word).
   */
  wallSecondsPerWord: number | null;
  avgAttempts: number | null;
}

export async function loadHistory(db: Queryable): Promise<HistoryStats> {
  const tokens = await db.query(
    `SELECT count(*)::int AS n, COALESCE(sum(input_tokens), 0)::bigint AS inp, COALESCE(sum(output_tokens), 0)::bigint AS outp,
            avg(attempts)::float AS attempts
       FROM word_enrichment_jobs WHERE input_tokens > 0`
  );
  const time = await db.query(
    `WITH f AS (
        SELECT finished_at, lag(finished_at) OVER (ORDER BY finished_at) AS prev
          FROM word_enrichment_jobs
         WHERE status = 'succeeded' AND finished_at IS NOT NULL AND finished_at > now() - interval '30 days')
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - prev)))::float AS median
        FROM f WHERE prev IS NOT NULL AND finished_at - prev < interval '60 seconds' AND finished_at > prev`
  );
  const t = tokens.rows[0];
  return {
    jobsWithTokens: Number(t.n),
    inputTokens: Number(t.inp),
    outputTokens: Number(t.outp),
    wallSecondsPerWord: time.rows[0]?.median === null || time.rows[0]?.median === undefined ? null : Number(time.rows[0].median),
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
  /** WALL-CLOCK seconds per word (not per job): see HistoryStats.wallSecondsPerWord */
  secondsPerWord: number;
  timeSource: 'history' | 'default';
  concurrency: number;
  /** wall-clock seconds of the worker for all the words */
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
  const timeSource = o.history.wallSecondsPerWord !== null && o.history.wallSecondsPerWord > 0 ? 'history' : 'default';
  // wall-clock seconds per word: measured (at the concurrency of the earlier batches), or 10 seconds of work shared by the workers
  const secondsPerWord = timeSource === 'history' ? (o.history.wallSecondsPerWord as number) : DEFAULT_SECONDS_PER_WORD / Math.max(1, o.concurrency);
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
    workerSeconds: Math.ceil(o.words * secondsPerWord),
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
