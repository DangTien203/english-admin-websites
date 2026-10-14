import type { DatamuseClient } from '../../upstream/datamuseClient';
import type { FreeDictionaryClient } from '../../upstream/freeDictionaryClient';
import type { Db, FreeDictionaryOutcome, FrequencyInfo, SourceBundle, WiktionaryRow } from '../types';
import { fetchFrequency } from './frequency';
import { analyzeRows, fetchWiktionaryRows, isNameRow } from './wiktionary';

/**
 * S1 — collect the sources for one word (docs/lookup-spec.md §8).
 *
 * Wiktionary (and the rows of its lemma), the frequency list and Datamuse run in parallel
 * (Promise.allSettled); each may be missing, none is allowed to fail the job. Free Dictionary is asked ONLY when
 * Wiktionary has no row for the word: a 404 is a normal answer (found = false), a transient failure is
 * rethrown as UpstreamUnavailable so pg-boss retries — unless the caller tolerates it (the draft CLI).
 */

export const SOURCE_TIMEOUT_MS = 8000;

export interface SourceDeps {
  /** Holds ref_wiktionary_en and ref_word_frequency (the main pool, or REFDATA_DATABASE_URL's). */
  refDb: Db;
  freeDictionary: Pick<FreeDictionaryClient, 'lookup'>;
  datamuse: Pick<DatamuseClient, 'relations'>;
  /** Timeout of each database read. */
  timeoutMs?: number;
  /** Keep a transient Free Dictionary failure in the bundle instead of throwing (CLI only). */
  tolerateFreeDictionaryError?: boolean;
  signal?: AbortSignal;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const reason = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 160);

export async function collectSources(word: string, deps: SourceDeps): Promise<SourceBundle> {
  const timeoutMs = deps.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - t;
    }
  };
  const sourceErrors: Record<string, string> = {};

  const [wikt, freq, muse] = await Promise.allSettled([
    timed('wiktionary', () => withTimeout(fetchWiktionaryRows(deps.refDb, word), timeoutMs, 'wiktionary')),
    timed('frequency', () => withTimeout(fetchFrequency(deps.refDb, word), timeoutMs, 'frequency')),
    timed('datamuse', () => deps.datamuse.relations(word, { signal: deps.signal })),
  ]);

  let wiktionaryRows: WiktionaryRow[] = [];
  if (wikt.status === 'fulfilled') wiktionaryRows = wikt.value;
  else sourceErrors.wiktionary = reason(wikt.reason);

  let frequency: FrequencyInfo | null = null;
  if (freq.status === 'fulfilled') frequency = freq.value;
  else sourceErrors.frequency = reason(freq.reason);

  const datamuse = muse.status === 'fulfilled' ? muse.value : null;
  if (muse.status === 'rejected') sourceErrors.datamuse = reason(muse.reason);

  // ── what kind of word do the rows describe? ──
  const analysis = analyzeRows(word, wiktionaryRows);
  let onlyFormRows = analysis.onlyFormRows;
  let expectedLemma: string | null = null;
  let lemmaRows: WiktionaryRow[] = [];

  if (onlyFormRows) {
    // The lemma must be a real word of the right kind: try each candidate until one has non-name rows (or no rows at all).
    for (const candidate of analysis.formLemmas) {
      try {
        const rows = await timed('lemma_rows', () => withTimeout(fetchWiktionaryRows(deps.refDb, candidate), timeoutMs, 'wiktionary lemma'));
        if (rows.length > 0 && rows.every(isNameRow)) continue;
        expectedLemma = candidate;
        lemmaRows = rows;
        break;
      } catch (err) {
        sourceErrors.lemma_rows = reason(err);
        expectedLemma = candidate; // cannot verify; the lemma still comes from Wiktionary's own data
        break;
      }
    }
    if (!expectedLemma) onlyFormRows = false;
  }
  if (!expectedLemma && !onlyFormRows && analysis.independentRows.length > 0) expectedLemma = word;

  // ── Free Dictionary: only when Wiktionary has nothing ──
  let freeDictionary: FreeDictionaryOutcome = { status: 'skipped' };
  if (wiktionaryRows.length === 0) {
    const t = Date.now();
    try {
      const result = await deps.freeDictionary.lookup(word, { signal: deps.signal });
      freeDictionary = result.found ? { status: 'found', entry: result.entry } : { status: 'not_found' };
    } catch (err) {
      if (!deps.tolerateFreeDictionaryError) throw err; // UpstreamUnavailable: pg-boss retries the job
      freeDictionary = { status: 'error', error: err };
      sourceErrors.free_dictionary = reason(err);
    } finally {
      timings.free_dictionary = Date.now() - t;
    }
  }

  const noSourceFailed = Object.keys(sourceErrors).length === 0;
  const noSourceRecognizesWord = wiktionaryRows.length === 0 && freeDictionary.status === 'not_found' && frequency === null && noSourceFailed;

  return {
    word,
    expectedLemma,
    formLemmas: analysis.formLemmas,
    variantTargets: analysis.variantTargets,
    wiktionaryRows,
    lemmaRows,
    freeDictionary,
    frequency,
    datamuse,
    flags: {
      onlyFormRows,
      onlyVariantRows: analysis.onlyVariantRows,
      onlyProperNounRows: analysis.onlyProperNounRows,
      noSourceRecognizesWord,
    },
    strayRows: onlyFormRows ? analysis.strayRows : 0,
    sourceErrors,
    timingsMs: timings,
  };
}

export type HaikuSkipReason = 'unknown_word' | 'variant_form';

/**
 * Cases where the spec (§8, S2) says Haiku is NOT called: no source knows the word (rejected / unknown_word) or every
 * Wiktionary row is a misspelling or obsolete form (skipped / variant_form). The draft CLI honours this unless --force.
 */
export function haikuSkipReason(bundle: SourceBundle): HaikuSkipReason | null {
  if (bundle.flags.noSourceRecognizesWord) return 'unknown_word';
  if (bundle.flags.onlyVariantRows) return 'variant_form';
  return null;
}
