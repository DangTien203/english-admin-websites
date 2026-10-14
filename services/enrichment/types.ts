import type { FdEntry } from '../upstream/freeDictionaryClient';

/** Minimal database surface (pg.Pool satisfies it) so tests can inject a fake. */
export interface Db {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

/** One row of ref_wiktionary_en (docs/lookup-refdata.md §6.2). */
export interface WiktionaryRow {
  id: number | string;
  /** lowercase */
  word: string;
  pos: string;
  etymology_number: number | null;
  /** single lowercase lemma when EVERY standard sense of the row is a form_of / alt_of, else null */
  lemma_of: string | null;
  /** reduced kaikki row; data.word keeps the original case ("London", "RAN") */
  data: any;
}

export type FreeDictionaryOutcome =
  | { status: 'skipped' } // Wiktionary already knows the word: Free Dictionary is not asked
  | { status: 'not_found' }
  | { status: 'found'; entry: FdEntry }
  | { status: 'error'; error: unknown }; // transient failure; only kept in the bundle when the caller tolerates it

export interface FrequencyInfo {
  zipf: number;
  /** 1 = most common */
  rank: number;
}

export interface DatamuseCandidates {
  synonyms: string[];
  antonyms: string[];
  degraded?: true;
}

export interface SourceFlags {
  /** Every (meaningful) Wiktionary row of the word is an inflected / alternative form of one lemma. */
  onlyFormRows: boolean;
  /** Every Wiktionary row of the word has only misspelling / obsolete / archaic / nonstandard / dialectal / rare / proscribed senses. */
  onlyVariantRows: boolean;
  /** Every Wiktionary row of the word (any letter case) has pos "name". */
  onlyProperNounRows: boolean;
  /** No Wiktionary row, Free Dictionary says 404, no frequency row — and no source failed, so this is a real "unknown". */
  noSourceRecognizesWord: boolean;
}

export interface SourceBundle {
  /** normalized (lowercase) word that was looked up */
  word: string;
  /**
   * Lemma the draft must have, or null when nothing is known.
   *   onlyFormRows       → the lemma Wiktionary names (ran → run)
   *   independent rows   → the word itself
   *   otherwise          → null
   */
  expectedLemma: string | null;
  /** Every single-word lemma that a form row of the word points to (informational; mixed words like "saw" have some). */
  formLemmas: string[];
  /** Standard spelling a misspelling / non-standard form points to (recieve → receive). */
  variantTargets: string[];
  /** Rows of ref_wiktionary_en for the word. */
  wiktionaryRows: WiktionaryRow[];
  /** Rows for expectedLemma, fetched only when onlyFormRows. */
  lemmaRows: WiktionaryRow[];
  freeDictionary: FreeDictionaryOutcome;
  frequency: FrequencyInfo | null;
  /** Candidates only: Haiku chooses, nothing here is written to the database as is. */
  datamuse: DatamuseCandidates | null;
  flags: SourceFlags;
  /** Rows kept out of onlyFormRows because they are a lone stray sense (see wiktionary.ts STRAY_SENSE_LIMIT). */
  strayRows: number;
  /** Sources that failed and were tolerated, e.g. { wiktionary: "timeout" }. */
  sourceErrors: Record<string, string>;
  timingsMs: Record<string, number>;
}
