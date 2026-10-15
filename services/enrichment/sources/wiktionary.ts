import { isNonStandardSense, targetsOf } from '../../lookup/wiktionaryTags';
import { tagsForLemma } from '../../lookup/localLookup';
import type { Db, WiktionaryRow } from '../types';

/**
 * Local Wiktionary reference data (ref_wiktionary_en) for the enrichment job: reading the rows, deciding what
 * kind of word they describe (flags), and shrinking them into the compact JSON sent to Claude Haiku.
 *
 * Real-data facts this file relies on (docs/lookup-refdata.md §5–§6, checked on the loaded table):
 *   - ref_wiktionary_en.word is lowercase, data.word keeps the original case: "RAN" (abbreviation) and "Ran"
 *     (given name) sit next to the verb "ran" under the same key.
 *   - lemma_of is set by the loader only when EVERY standard sense of a row is form_of / alt_of, and it can be a
 *     multi-word phrase ("royal australian navy" for the abbreviation row RAN).
 *   - Misspellings carry the tag "misspelling" and an alt_of target in the sense (recieve → receive).
 */

const SINGLE_WORD = /^[a-z]+(?:['-][a-z]+)*$/;
const ABBREVIATION_TAGS = new Set(['abbreviation', 'initialism', 'acronym']);

/**
 * A word whose only non-form content is ONE stray sense (ran: "yarns coiled on a spun-yarn winch") is still
 * treated as a pure inflected form. Two or more independent senses (saw, left, bit...) make it a real word too.
 */
export const STRAY_SENSE_LIMIT = 1;

export const WIKTIONARY_ROW_LIMIT = 40;

export async function fetchWiktionaryRows(db: Db, word: string): Promise<WiktionaryRow[]> {
  const { rows } = await db.query(
    `SELECT id, word, pos, etymology_number, lemma_of, data
       FROM ref_wiktionary_en
      WHERE word = $1
      ORDER BY id
      LIMIT ${WIKTIONARY_ROW_LIMIT}`,
    [word]
  );
  return rows.map((r) => ({ ...r, etymology_number: r.etymology_number ?? null, lemma_of: r.lemma_of ?? null }));
}

// ── row classification ───────────────────────────────────────────────────────

export const sensesOf = (row: WiktionaryRow): any[] => (Array.isArray(row.data?.senses) ? row.data.senses : []);

/** Total number of senses across rows (the loader keeps at most 8 per row). */
export const countSenses = (rows: readonly WiktionaryRow[]): number => rows.reduce((n, r) => n + sensesOf(r).length, 0);

/**
 * A synonym / antonym worth looking up in the frequency list: ONE word, with no apostrophe or quotation mark.
 * Wiktionary lists phrases and proverbs next to words ("murphy's law", "perfect storm", "chance-medley").
 */
export const isPlainRelatedWord = (word: string): boolean => word.length > 0 && !/[\s'’"`]/.test(word);

/**
 * Every plain single-word synonym / antonym that the senses of these rows list, lowercase, without duplicates (at most
 * `limit`). The caller looks them up in ref_word_frequency; only the ones found there are used for new entries.
 */
export function collectRelatedWords(rows: readonly WiktionaryRow[], limit = 600): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    for (const sense of sensesOf(row)) {
      for (const key of ['synonyms', 'antonyms']) {
        for (const item of Array.isArray(sense?.[key]) ? sense[key] : []) {
          const raw = typeof item === 'string' ? item : typeof item?.word === 'string' ? item.word : '';
          const w = raw.normalize('NFC').trim().toLowerCase();
          if (isPlainRelatedWord(w)) out.add(w);
          if (out.size >= limit) return [...out];
        }
      }
    }
  }
  return [...out];
}
const senseTags = (sense: any): string[] => [...(Array.isArray(sense?.tags) ? sense.tags : []), ...(Array.isArray(sense?.raw_tags) ? sense.raw_tags : [])].filter((t) => typeof t === 'string').map((t) => t.toLowerCase());

/** The row describes exactly this word in this letter case ("ran", not "RAN" or "Ran"). */
export const isPrimaryRow = (word: string, row: WiktionaryRow): boolean => (row.data?.word ?? row.word) === word;

const isAbbreviationRow = (row: WiktionaryRow): boolean => {
  const senses = sensesOf(row);
  return senses.length > 0 && senses.every((s) => senseTags(s).some((t) => ABBREVIATION_TAGS.has(t)));
};

/** Every sense is a misspelling / obsolete / archaic / nonstandard / dialectal / rare / proscribed one. */
export const isVariantRow = (row: WiktionaryRow): boolean => {
  const senses = sensesOf(row);
  return senses.length > 0 && senses.every((s) => isNonStandardSense(s));
};

export const isNameRow = (row: WiktionaryRow): boolean => row.pos === 'name';

/** An inflected / alternative form of ONE single-word lemma (never a phrase, never a name or an abbreviation). */
export const isFormRow = (word: string, row: WiktionaryRow): boolean =>
  typeof row.lemma_of === 'string' &&
  SINGLE_WORD.test(row.lemma_of) &&
  row.lemma_of !== word &&
  !isNameRow(row) &&
  !isAbbreviationRow(row) &&
  !isVariantRow(row);

export interface RowAnalysis {
  primaryRows: WiktionaryRow[];
  formRows: WiktionaryRow[];
  variantRows: WiktionaryRow[];
  independentRows: WiktionaryRow[];
  /** Senses in independentRows. */
  independentSenseCount: number;
  /** Single-word lemmas of the form rows, in row order, deduplicated. */
  formLemmas: string[];
  onlyFormRows: boolean;
  onlyVariantRows: boolean;
  onlyProperNounRows: boolean;
  /** Independent rows tolerated by STRAY_SENSE_LIMIT (0 unless onlyFormRows by tolerance). */
  strayRows: number;
  /** Targets of alt_of / form_of in the variant rows (recieve → receive). */
  variantTargets: string[];
}

export function analyzeRows(word: string, rows: WiktionaryRow[]): RowAnalysis {
  const primaryRows = rows.filter((r) => isPrimaryRow(word, r));
  const variantRows = primaryRows.filter(isVariantRow);
  const formRows = primaryRows.filter((r) => isFormRow(word, r));
  const independentRows = primaryRows.filter((r) => !isVariantRow(r) && !isFormRow(word, r) && !isNameRow(r) && !isAbbreviationRow(r));
  const independentSenseCount = independentRows.reduce((n, r) => n + sensesOf(r).length, 0);
  const formLemmas = [...new Set(formRows.map((r) => r.lemma_of as string))];

  const onlyFormRows = formRows.length > 0 && independentSenseCount <= STRAY_SENSE_LIMIT;
  const onlyVariantRows = primaryRows.length > 0 && variantRows.length === primaryRows.length;
  const onlyProperNounRows = rows.length > 0 && rows.every(isNameRow);

  const variantTargets = onlyVariantRows
    ? [...new Set(variantRows.flatMap((r) => sensesOf(r).flatMap((s) => targetsOf(s))).filter((t) => t !== word))]
    : [];

  return {
    primaryRows,
    formRows,
    variantRows,
    independentRows,
    independentSenseCount,
    formLemmas,
    onlyFormRows,
    onlyVariantRows,
    onlyProperNounRows,
    strayRows: onlyFormRows && independentSenseCount > 0 ? independentRows.length : 0,
    variantTargets,
  };
}

/** What Wiktionary says about how `word` relates to `lemma` (for the prompt): the first standard sense pointing at it. */
export function describeFormOf(word: string, lemma: string, rows: WiktionaryRow[]): { lemma: string; gloss: string | null; tags: string[] } {
  for (const row of rows.filter((r) => isPrimaryRow(word, r) && r.lemma_of === lemma)) {
    const sense = sensesOf(row).find((s) => targetsOf(s).includes(lemma) && !isNonStandardSense(s));
    return {
      lemma,
      gloss: Array.isArray(sense?.glosses) && typeof sense.glosses[0] === 'string' ? sense.glosses[0] : null,
      tags: tagsForLemma(row.data, lemma).filter((t) => t !== 'form-of'),
    };
  }
  return { lemma, gloss: null, tags: [] };
}

// ── compact JSON for Claude Haiku ────────────────────────────────────────────

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export interface SummaryOptions {
  /** Budget for the JSON, estimated as characters / 4. Default 2500. */
  maxTokens?: number;
  /** Senses kept in total across all rows. Default 6. */
  maxSenses?: number;
}

export interface SummarySense {
  glosses: string[];
  tags?: string[];
  examples?: string[];
  synonyms?: string[];
  antonyms?: string[];
  form_of?: string[];
  alt_of?: string[];
}

export interface SummaryEntry {
  pos: string;
  /** Only when the original letter case differs from the lookup key ("London", "RAN"). */
  written?: string;
  etymology?: number;
  head?: string;
  forms?: string[];
  tags?: string[];
  synonyms?: string[];
  antonyms?: string[];
  senses: SummarySense[];
}

export interface SummaryResult {
  entries: SummaryEntry[];
  approxTokens: number;
  sensesKept: number;
  sensesDropped: number;
}

const strings = (value: unknown, max: number): string[] =>
  (Array.isArray(value) ? value : [])
    .map((v) => (typeof v === 'string' ? v : typeof v?.word === 'string' ? v.word : ''))
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max);

/** Inflected forms from data.forms ([{ form, tags }]), without the table markers and placeholders kaikki leaves in. */
const TABLE_MARKER_TAGS = new Set(['table-tags', 'inflection-template', 'class']);
const usableForms = (forms: unknown): string[] =>
  (Array.isArray(forms) ? forms : [])
    .filter((f: any) => typeof f?.form === 'string' && !(Array.isArray(f.tags) && f.tags.some((t: unknown) => typeof t === 'string' && TABLE_MARKER_TAGS.has(t))))
    .map((f: any) => String(f.form).trim())
    .filter((f) => f && f !== '-' && f !== 'no-table-tags' && f !== 'glossary');

/** Order rows for sampling: exact-case rows first; inside a group, the first row of each part of speech, then the rest. */
function orderRows(rows: WiktionaryRow[]): WiktionaryRow[] {
  const exact = (r: WiktionaryRow) => (r.data?.word ?? r.word) === r.word;
  const arrange = (group: WiktionaryRow[]) => {
    const seen = new Set<string>();
    const firstOfPos: WiktionaryRow[] = [];
    const rest: WiktionaryRow[] = [];
    for (const r of group) {
      if (!seen.has(r.pos)) {
        seen.add(r.pos);
        firstOfPos.push(r);
      } else {
        rest.push(r);
      }
    }
    return [...firstOfPos, ...rest];
  };
  return [...arrange(rows.filter(exact)), ...arrange(rows.filter((r) => !exact(r)))];
}

interface Detail {
  examples: number;
  forms: boolean;
  related: boolean;
}

function buildEntries(ordered: WiktionaryRow[], picks: Map<WiktionaryRow, number[]>, detail: Detail): SummaryEntry[] {
  const entries: SummaryEntry[] = [];
  for (const row of ordered) {
    const indices = picks.get(row);
    if (!indices || indices.length === 0) continue;
    const all = sensesOf(row);
    const entry: SummaryEntry = { pos: row.pos, senses: [] };
    if ((row.data?.word ?? row.word) !== row.word) entry.written = String(row.data.word);
    if (row.etymology_number !== null && row.etymology_number !== undefined) entry.etymology = Number(row.etymology_number);
    const head = row.data?.head_templates?.[0]?.expansion;
    if (typeof head === 'string' && head.trim()) entry.head = head.trim();
    if (detail.forms) {
      const forms = [...new Set(usableForms(row.data?.forms).filter((f) => f !== row.word))].slice(0, 8);
      if (forms.length) entry.forms = forms;
    }
    const rowTags = strings(row.data?.tags, 6);
    if (rowTags.length) entry.tags = rowTags;
    if (detail.related) {
      const syn = strings(row.data?.synonyms, 8);
      const ant = strings(row.data?.antonyms, 8);
      if (syn.length) entry.synonyms = syn;
      if (ant.length) entry.antonyms = ant;
    }

    for (const i of indices) {
      const s = all[i];
      const sense: SummarySense = { glosses: strings(s?.glosses, 2) };
      const tags = strings(s?.tags, 8);
      if (tags.length) sense.tags = tags;
      if (detail.examples > 0) {
        const ex = (Array.isArray(s?.examples) ? s.examples : [])
          .map((e: any) => (typeof e === 'string' ? e : typeof e?.text === 'string' ? e.text : ''))
          .map((t: string) => t.trim())
          .filter(Boolean)
          .slice(0, detail.examples);
        if (ex.length) sense.examples = ex;
      }
      if (detail.related) {
        const syn = strings(s?.synonyms, 8);
        const ant = strings(s?.antonyms, 8);
        if (syn.length) sense.synonyms = syn;
        if (ant.length) sense.antonyms = ant;
      }
      const formOf = strings(s?.form_of, 3);
      const altOf = strings(s?.alt_of, 3);
      if (formOf.length) sense.form_of = formOf;
      if (altOf.length) sense.alt_of = altOf;
      entry.senses.push(sense);
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Shrinks Wiktionary rows into the compact JSON placed in <data> for Claude Haiku (docs/lookup-spec.md §9.4).
 *
 * Keeps pos, head_templates expansion (it carries "countable / plural" information), glosses, tags, at most 2
 * examples per sense, synonyms / antonyms and forms. Never IPA or audio. Rows whose letter case matches the
 * lookup key come first. At most `maxSenses` senses in total, taken round-robin so every part of speech is
 * represented before any one of them gets a second sense. If the estimate (characters / 4) is over
 * `maxTokens`, detail is dropped in this order: second example → all examples → forms → synonyms / antonyms →
 * senses from the end.
 */
export function summarizeForPrompt(rows: WiktionaryRow[], options: SummaryOptions = {}): SummaryResult {
  const maxTokens = options.maxTokens ?? 2500;
  const maxSenses = options.maxSenses ?? 6;
  const ordered = orderRows(rows);
  const total = ordered.reduce((n, r) => n + sensesOf(r).length, 0);

  // Round-robin selection of sense indices.
  const picks = new Map<WiktionaryRow, number[]>();
  let kept = 0;
  for (let round = 0; kept < maxSenses; round++) {
    let progressed = false;
    for (const row of ordered) {
      if (kept >= maxSenses) break;
      if (round < sensesOf(row).length) {
        picks.set(row, [...(picks.get(row) ?? []), round]);
        kept++;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  const levels: Detail[] = [
    { examples: 2, forms: true, related: true },
    { examples: 1, forms: true, related: true },
    { examples: 0, forms: true, related: true },
    { examples: 0, forms: false, related: true },
    { examples: 0, forms: false, related: false },
  ];

  let entries: SummaryEntry[] = [];
  let tokens = 0;
  for (const detail of levels) {
    entries = buildEntries(ordered, picks, detail);
    tokens = estimateTokens(JSON.stringify(entries));
    if (tokens <= maxTokens) break;
  }

  // Still too big: drop senses from the end.
  while (tokens > maxTokens && kept > 1) {
    const last = [...ordered].reverse().find((r) => (picks.get(r)?.length ?? 0) > 0)!;
    picks.get(last)!.pop();
    kept--;
    entries = buildEntries(ordered, picks, levels[levels.length - 1]);
    tokens = estimateTokens(JSON.stringify(entries));
  }

  return { entries, approxTokens: tokens, sensesKept: kept, sensesDropped: Math.max(0, total - kept) };
}
