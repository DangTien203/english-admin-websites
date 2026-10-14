/**
 * Pure helpers for loading the Wiktionary (wiktextract) dump into ref_wiktionary_en
 * (docs/lookup-spec.md §2, §8.1; field names verified against the real dump in docs/lookup-refdata.md).
 *
 * Nothing here touches the file system or the database, so every rule is unit-tested on real sample rows
 * (tests/fixtures/refdata/wiktionary-sample.jsonl).
 */

// ── cheap pre-filter ─────────────────────────────────────────────────────────

/**
 * The exact serialization of the language code in the dump: a SPACE after the colon. Using it as a plain
 * substring test lets the loader skip ~86% of the lines (everything that is not English) without JSON.parse.
 * It never misses an English row. It also matches nested objects of other languages (descendants, ~3% of
 * the passes), so the real decision is `row.lang_code === 'en'` after parsing.
 */
export const EN_MARKER = '"lang_code": "en"';

export const isEnglishCandidate = (line: string): boolean => line.includes(EN_MARKER);

export type ParsedLine = { kind: 'skip' } | { kind: 'bad' } | { kind: 'english'; raw: any };

/** One dump line → skip (not English), bad (broken JSON, counted and ignored) or an English row. */
export function parseDumpLine(line: string): ParsedLine {
  if (!isEnglishCandidate(line)) return { kind: 'skip' };
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: 'bad' };
  }
  return raw && raw.lang_code === 'en' ? { kind: 'english', raw } : { kind: 'skip' };
}

// ── limits (docs/lookup-refdata.md explains why each one exists) ─────────────

export const LIMITS = {
  etymologyText: 1000,
  senses: 8,
  glossesPerSense: 4,
  string: 250,
  examplesPerSense: 2,
  tagsPerList: 20,
  wordsPerSense: 8, // sense synonyms / antonyms
  topicsPerSense: 10,
  formOfPerSense: 3,
  forms: 20,
  sounds: 8,
  soundsPerKind: 4, // at most this many ipa-bearing and this many audio-bearing items before filling up
  headTemplates: 2,
  expansion: 200,
  derived: 20,
  related: 20,
  synonyms: 8,
  antonyms: 8,
  word: 100,
} as const;

// Sense tags that mark a form which must not be auto-linked into word_forms live in services/ (shared with
// resolveViaForms): NON_STANDARD_TAGS, isNonStandardSense, targetsOf.
export { NON_STANDARD_TAGS, isNonStandardSense };

/** Entries of forms[] that only describe the inflection table, not a word form. */
const FORM_TABLE_MARKERS = new Set(['table-tags', 'inflection-template', 'class']);

import { isNonStandardSense, NON_STANDARD_TAGS } from '../../../services/lookup/wiktionaryTags';

// ── small helpers ────────────────────────────────────────────────────────────

/** Cuts to at most `max` UTF-16 units without leaving half a surrogate pair behind. */
export function cut(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= max) return value;
  let out = value.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

const stringList = (value: unknown, max: number, maxLen: number = LIMITS.string): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = cut(v, maxLen);
    if (s !== undefined && s !== '') out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

/** [{word:'x'}, 'y', …] → ['x', 'y', …] without duplicates, at most `max`. */
export function wordList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const w = cut(typeof item === 'string' ? item : item?.word, LIMITS.word);
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

const wordRefs = (value: unknown, max: number): Array<{ word: string }> => wordList(value, max).map((word) => ({ word }));

// ── reduced shapes ───────────────────────────────────────────────────────────

export interface ReducedSense {
  glosses?: string[];
  tags?: string[];
  raw_tags?: string[];
  examples?: Array<{ text: string; translation?: string }>;
  synonyms?: string[];
  antonyms?: string[];
  form_of?: Array<{ word: string }>;
  alt_of?: Array<{ word: string }>;
  topics?: string[];
}

export interface ReducedSound {
  ipa?: string;
  tags?: string[];
  mp3_url?: string;
  ogg_url?: string;
  audio?: string;
  enpr?: string;
}

export interface ReducedData {
  word: string;
  pos: string;
  etymology_number?: number;
  etymology_text?: string;
  senses: ReducedSense[];
  forms?: Array<{ form: string; tags: string[] }>;
  sounds?: ReducedSound[];
  head_templates?: Array<{ name: string; expansion?: string }>;
  tags?: string[];
  derived?: string[];
  related?: string[];
  synonyms?: string[];
  antonyms?: string[];
}

export interface ReducedRow {
  /** lowercase of the original word (the lookup key) */
  word: string;
  pos: string;
  etymology_number: number | null;
  lemma_of: string | null;
  data: ReducedData;
}

// ── sense / forms / sounds ───────────────────────────────────────────────────

export function reduceSense(s: any): ReducedSense | null {
  if (!s || typeof s !== 'object') return null;
  const out: ReducedSense = {};

  const glosses = stringList(s.glosses, LIMITS.glossesPerSense);
  if (glosses.length > 0) out.glosses = glosses;

  const tags = stringList(s.tags, LIMITS.tagsPerList, 60);
  if (tags.length > 0) out.tags = tags;
  const rawTags = stringList(s.raw_tags, LIMITS.tagsPerList, 60);
  if (rawTags.length > 0) out.raw_tags = rawTags;

  if (Array.isArray(s.examples)) {
    const examples: Array<{ text: string; translation?: string }> = [];
    for (const ex of s.examples) {
      const text = cut(ex?.text, LIMITS.string);
      if (!text) continue;
      const translation = cut(ex?.translation, LIMITS.string);
      examples.push(translation ? { text, translation } : { text });
      if (examples.length >= LIMITS.examplesPerSense) break;
    }
    if (examples.length > 0) out.examples = examples;
  }

  const synonyms = wordList(s.synonyms, LIMITS.wordsPerSense);
  if (synonyms.length > 0) out.synonyms = synonyms;
  const antonyms = wordList(s.antonyms, LIMITS.wordsPerSense);
  if (antonyms.length > 0) out.antonyms = antonyms;

  const formOf = wordRefs(s.form_of, LIMITS.formOfPerSense);
  if (formOf.length > 0) out.form_of = formOf;
  const altOf = wordRefs(s.alt_of, LIMITS.formOfPerSense);
  if (altOf.length > 0) out.alt_of = altOf;

  const topics = stringList(s.topics, LIMITS.topicsPerSense, 60);
  if (topics.length > 0) out.topics = topics;

  // A sense that says nothing we keep is not worth a slot.
  return out.glosses || out.form_of || out.alt_of ? out : null;
}

export function reduceForms(forms: unknown): Array<{ form: string; tags: string[] }> {
  if (!Array.isArray(forms)) return [];
  const out: Array<{ form: string; tags: string[] }> = [];
  const seen = new Set<string>();
  for (const f of forms) {
    const form = cut(f?.form, LIMITS.word)?.trim();
    const tags = stringList(f?.tags, LIMITS.tagsPerList, 60);
    if (!form || form === '-') continue; // "-" is a placeholder for "no such form"
    if (tags.some((t) => FORM_TABLE_MARKERS.has(t))) continue; // table-tags / inflection-template / class
    const key = `${form}|${[...tags].sort().join(',')}`; // the conjugation table repeats the same forms
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ form, tags });
    if (out.length >= LIMITS.forms) break;
  }
  return out;
}

function reduceSound(s: any): ReducedSound | null {
  if (!s || typeof s !== 'object') return null;
  const out: ReducedSound = {};
  const ipa = cut(s.ipa, 200);
  if (ipa) out.ipa = ipa;
  const tags = stringList(s.tags, LIMITS.tagsPerList, 60);
  if (tags.length > 0) out.tags = tags;
  const mp3 = cut(s.mp3_url, 500);
  if (mp3) out.mp3_url = mp3;
  const ogg = cut(s.ogg_url, 500);
  if (ogg) out.ogg_url = ogg;
  const audio = cut(s.audio, 200);
  if (audio) out.audio = audio;
  const enpr = cut(s.enpr, 100);
  if (enpr) out.enpr = enpr;
  // rhymes / homophone / note-only entries carry nothing the enrichment can use
  return out.ipa || out.mp3_url || out.ogg_url || out.audio || out.enpr ? out : null;
}

/**
 * At most LIMITS.sounds entries. In the dump ipa and audio live in SEPARATE array elements and an
 * element with 20 pronunciations would push the recordings out, so the first 4 ipa entries and the first
 * 4 audio entries are reserved before the remaining slots are filled in original order.
 */
export function reduceSounds(sounds: unknown): ReducedSound[] {
  if (!Array.isArray(sounds)) return [];
  const items = sounds.map(reduceSound).filter((x): x is ReducedSound => x !== null);
  if (items.length <= LIMITS.sounds) return items;

  const chosen = new Set<number>();
  let ipaCount = 0;
  let audioCount = 0;
  items.forEach((item, i) => {
    if (item.ipa && ipaCount < LIMITS.soundsPerKind) {
      chosen.add(i);
      ipaCount++;
    }
    if ((item.mp3_url || item.ogg_url) && audioCount < LIMITS.soundsPerKind) {
      chosen.add(i);
      audioCount++;
    }
  });
  for (let i = 0; i < items.length && chosen.size < LIMITS.sounds; i++) chosen.add(i);
  return items.filter((_, i) => chosen.has(i));
}

// ── lemma_of ─────────────────────────────────────────────────────────────────

export type NonStandardRule =
  /** default: lemma_of stays NULL only when EVERY sense is non-standard (see the note on deriveLemmaOf) */
  | 'all'
  /** literal reading of the task: lemma_of is NULL as soon as ANY sense is non-standard */
  | 'any';

const firstTarget = (s: any): string | undefined => {
  for (const key of ['form_of', 'alt_of']) {
    const list = s?.[key];
    if (Array.isArray(list) && list.length > 0) {
      const w = typeof list[0] === 'string' ? list[0] : list[0]?.word;
      if (typeof w === 'string' && w.trim()) return w.trim().toLowerCase();
    }
  }
  return undefined;
};

/**
 * The lemma this row is a form of, or null.
 *  1. EVERY sense must carry form_of or alt_of (a row with a real definition is its own lemma).
 *  2. Non-standard senses (misspelling, obsolete, archaic, nonstandard, dialectal, rare, proscribed) never
 *     provide the lemma: such forms must not be auto-linked into word_forms.
 *     - rule 'all' (default): the row is skipped only if there is NO standard sense. Real example from the dump:
 *       "ran" (verb) has three senses — past of "run", past of "rin", and a colloquial NONSTANDARD past
 *       participle of "run". The literal rule would drop the very word the feature exists for (ran → run).
 *     - rule 'any': NULL as soon as any sense is non-standard.
 *  3. The lemma is the first word of the first standard sense, lowercase, and never the word itself.
 * Computed on ALL senses of the raw row, before the 8-sense cut.
 */
export function deriveLemmaOf(senses: any[], word: string, rule: NonStandardRule = 'all'): string | null {
  if (!Array.isArray(senses) || senses.length === 0) return null;
  if (!senses.every((s) => firstTarget(s) !== undefined)) return null;

  const standard = senses.filter((s) => !isNonStandardSense(s));
  if (rule === 'any' ? standard.length !== senses.length : standard.length === 0) return null;

  const lemma = firstTarget(standard[0]);
  return lemma && lemma !== word.toLowerCase() ? lemma : null;
}

/**
 * etymology_number as an integer. The dump stores it as a STRING ("1", "2"), so Number.isInteger on the raw
 * value would silently drop it from all 44,836 rows that have one.
 */
export function parseEtymologyNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

// ── the whole row ────────────────────────────────────────────────────────────

export interface ReduceOptions {
  nonStandardRule?: NonStandardRule;
}

/** Raw English row → ref_wiktionary_en row, or null when word or pos is missing. */
export function reduceEntry(raw: any, opts: ReduceOptions = {}): ReducedRow | null {
  const word = typeof raw?.word === 'string' ? raw.word.trim() : '';
  const pos = typeof raw?.pos === 'string' ? raw.pos.trim() : '';
  if (!word || !pos) return null;

  const rawSenses: any[] = Array.isArray(raw.senses) ? raw.senses : [];
  const senses = rawSenses.map(reduceSense).filter((x): x is ReducedSense => x !== null).slice(0, LIMITS.senses);

  const data: ReducedData = { word, pos, senses };
  const etymologyNumber = parseEtymologyNumber(raw.etymology_number);
  if (etymologyNumber !== undefined) data.etymology_number = etymologyNumber;
  const etymologyText = cut(raw.etymology_text, LIMITS.etymologyText);
  if (etymologyText) data.etymology_text = etymologyText;

  const forms = reduceForms(raw.forms);
  if (forms.length > 0) data.forms = forms;
  const sounds = reduceSounds(raw.sounds);
  if (sounds.length > 0) data.sounds = sounds;

  if (Array.isArray(raw.head_templates)) {
    const heads = raw.head_templates
      .filter((h: any) => typeof h?.name === 'string')
      .slice(0, LIMITS.headTemplates)
      .map((h: any) => {
        const expansion = cut(h.expansion, LIMITS.expansion);
        return expansion ? { name: h.name as string, expansion } : { name: h.name as string };
      });
    if (heads.length > 0) data.head_templates = heads;
  }

  // The dump has no top-level `tags` key today; kept for dumps that do.
  const topTags = stringList(raw.tags, LIMITS.tagsPerList, 60);
  if (topTags.length > 0) data.tags = topTags;
  const derived = wordList(raw.derived, LIMITS.derived);
  if (derived.length > 0) data.derived = derived;
  const related = wordList(raw.related, LIMITS.related);
  if (related.length > 0) data.related = related;
  const synonyms = wordList(raw.synonyms, LIMITS.synonyms);
  if (synonyms.length > 0) data.synonyms = synonyms;
  const antonyms = wordList(raw.antonyms, LIMITS.antonyms);
  if (antonyms.length > 0) data.antonyms = antonyms;

  return {
    word: word.toLowerCase(),
    pos,
    etymology_number: etymologyNumber ?? null,
    lemma_of: deriveLemmaOf(rawSenses, word, opts.nonStandardRule ?? 'all'),
    data,
  };
}
