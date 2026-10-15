import { normalizeVietnameseAnswer } from '../../utils/answerNormalizer';
import { inferFormType, type FormType } from '../lookup/localLookup';
import { NON_STANDARD_TAGS } from '../lookup/wiktionaryTags';
import { REGISTER_VALUES, type Draft, type PosValue } from './haiku/schema';
import { normalizePos, normalizePosList } from './pos';
import { isFormRow, isNameRow, isVariantRow, sensesOf } from './sources/wiktionary';
import type { FrequencyInfo, SourceBundle, WiktionaryRow } from './types';

/**
 * S5 — merge the collected sources and the validated Haiku draft into the rows of one dictionary entry
 * (docs/lookup-spec.md §8.1 source priority, §9.8 meaning_vi, §10.6 and §10.7). PURE: no database, no network, no clock.
 * services/enrichment/persist.ts writes the result.
 *
 * Who supplies what (docs/lookup-enrichment.md §10):
 *   Wiktionary  headword letter case, IPA and audio by accent, word forms, etymology, is_countable / is_transitive,
 *               per-sense synonyms and antonyms (listed first)
 *   Free Dictionary  IPA and audio when Wiktionary has none
 *   Haiku       senses (definition_en, Vietnamese meanings, register, domain, region, notes, examples), cefr_level, topics,
 *               idioms, phrasal verbs, collocations. Its sense list is NOT aligned 1:1 with Wiktionary's (it rewrites and
 *               reorders), so per-sense fields come from the draft; only synonyms / antonyms are matched to a Wiktionary sense,
 *               by the overlap of the English definitions.
 *   ref_word_frequency  frequency_rank
 *   Datamuse    nothing directly: it is a candidate list that Haiku has already seen (a candidate Haiku did not pick is not written).
 */

// ── column sizes (information_schema, 15/10/2026; docs/lookup-schema-notes.md §3) ─────────────────────────────────────

export const COLUMN_LIMITS = {
  headword: 255,
  lemma: 255,
  ipa: 255,
  audioUrl: 500,
  posElement: 50,
  cefrLevel: 2,
  source: 20,
  sensePos: 30,
  senseRegister: 30,
  senseDomain: 100,
  senseRegion: 30,
  formType: 30,
  formValue: 255,
  synonymText: 255,
  idiomText: 500,
  phrasalVerb: 255,
  particle: 30,
  collocation: 255,
  collocationPattern: 50,
  familyRoot: 255,
  fieldName: 100,
} as const;

/** Round-robin meaning_vi: at most this many meanings, and at most this many characters (spec §9.8). */
export const MEANING_VI_MAX_PARTS = 6;
export const MEANING_VI_MAX_CHARS = 200;
/** definition_vi of a sense: at most this many meanings. */
export const SENSE_MEANINGS_MAX = 4;
export const ETYMOLOGY_MAX_CHARS = 1000;
export const RELATED_MAX = 8;
export const PHRASES_MAX = 5;
export const TOPICS_MAX = 3;
export const FORMS_MAX = 20;
export const ADMIN_NOTE_MAX_CHARS = 4000;
const FAMILY_CANDIDATES_MAX = 30;
const SYNONYM_MAX_CHARS = 60;

/** source of sense_examples rows written by the enrichment job (the column is free text, VARCHAR(50)). */
export const EXAMPLE_SOURCE = 'ai_enrichment';

export type PublishPolicy = 'review' | 'auto';

export interface AssembleContext {
  /** word_enrichment_jobs.id (or an identifier of a command-line run) */
  jobId: string;
  /** model that wrote the draft (for admin_note) */
  model: string;
  publishPolicy: PublishPolicy;
  /** tags.id of each of the 30 topics (loadTopicIds) */
  topicIds: ReadonlyMap<string, string>;
}

export interface AssembledExample {
  exampleEn: string;
  exampleVi: string;
  sortOrder: number;
}

export interface AssembledSense {
  /** 0-based position in the whole entry, in Haiku's order (most common first) */
  senseOrder: number;
  pos: PosValue;
  definitionEn: string;
  definitionVi: string;
  register: string | null;
  domain: string | null;
  region: string | null;
  grammarNote: string | null;
  usageNote: string | null;
  examples: AssembledExample[];
  synonyms: string[];
  antonyms: string[];
}

export interface AssembledForm {
  formType: FormType;
  formValue: string;
  sortOrder: number;
}

export interface AssembledIdiom {
  idiomText: string;
  definitionEn: string;
  definitionVi: string;
  exampleEn: string;
  exampleVi: string;
}

export interface AssembledPhrasalVerb {
  phrasalVerb: string;
  particle: string;
  isSeparable: boolean;
  definitionEn: string;
  definitionVi: string;
  exampleEn: string;
  exampleVi: string;
}

export interface AssembledCollocation {
  collocation: string;
  pattern: string | null;
  exampleEn: string;
  exampleVi: string;
}

export interface AssemblyReport {
  /** Tier A fields that are missing: the entry is then NOT published whatever the policy says. */
  tierAMissing: string[];
  /** Tier B fields that are missing: the entry is still published, admin_note says what is missing. */
  tierBMissing: string[];
  /** Fields that are estimates (cefr_level). */
  estimated: string[];
  /** Sources that contributed, for admin_note. */
  sources: string[];
}

export interface AssembledEntry {
  headword: string;
  lemma: string;
  pos: PosValue[];
  ipaUs: string | null;
  ipaUk: string | null;
  audioUsUrl: string | null;
  audioUkUrl: string | null;
  meaningVi: string;
  meaningEn: string | null;
  exampleEn: string | null;
  exampleVi: string | null;
  cefrLevel: string | null;
  frequencyRank: number | null;
  register: string | null;
  isCountable: boolean | null;
  isTransitive: boolean | null;
  etymology: string | null;
  source: 'wiktionary';
  published: boolean;
  adminNote: string;
  senses: AssembledSense[];
  forms: AssembledForm[];
  /** lemmas of existing PUBLISHED entries to link as entry_synonyms / entry_antonyms (persist resolves them; nothing is created) */
  entrySynonymLemmas: string[];
  entryAntonymLemmas: string[];
  tagIds: string[];
  tagNames: string[];
  aliases: Array<{ answerText: string; normalizedAnswer: string }>;
  idioms: AssembledIdiom[];
  phrasalVerbs: AssembledPhrasalVerb[];
  collocations: AssembledCollocation[];
  /** derived / related words of Wiktionary: persist keeps those that already are published entries (word_families) */
  familyWords: string[];
  report: AssemblyReport;
}

export type AssembleResult = { status: 'ok'; entry: AssembledEntry } | { status: 'invalid_output'; details: string[] };

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────

/** Cuts to `max` characters without splitting a surrogate pair (Postgres counts characters, JS counts UTF-16 units). */
export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = value.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trimEnd();
}

const tidy = (value: unknown): string => (typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '');
const orNull = (value: string): string | null => (value ? value : null);
const lower = (value: string): string => value.toLowerCase();

/** `{ word }` objects or plain strings → trimmed strings. */
function wordList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const word = typeof item === 'string' ? item : typeof item?.word === 'string' ? item.word : '';
    const t = tidy(word);
    if (t) out.push(t);
  }
  return out;
}

const tagsOf = (item: any): string[] =>
  [...(Array.isArray(item?.tags) ? item.tags : []), ...(Array.isArray(item?.raw_tags) ? item.raw_tags : [])].filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());

// ── meaning_vi (spec §9.8) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Round-robin: the first meaning of every sense (in sense order), then the second of every sense, and so on; a meaning
 * that repeats an earlier one is skipped. Stops at 6 meanings, or when one more would pass 200 characters
 * ('; ' between meanings counts). So a word with a single sense still shows several meanings in the fallback column.
 */
export function buildMeaningVi(senseMeanings: ReadonlyArray<readonly string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  const rounds = Math.max(0, ...senseMeanings.map((m) => m.length));
  outer: for (let round = 0; round < rounds; round++) {
    for (const meanings of senseMeanings) {
      const meaning = tidy(meanings[round]);
      if (!meaning) continue;
      const key = normalizeVietnameseAnswer(meaning);
      if (!key || seen.has(key)) continue;
      if (out.length >= MEANING_VI_MAX_PARTS) break outer;
      const next = length + (out.length > 0 ? 2 : 0) + meaning.length;
      if (next > MEANING_VI_MAX_CHARS) {
        if (out.length === 0) {
          out.push(cut(meaning, MEANING_VI_MAX_CHARS)); // cannot happen with validated meanings (<= 40 characters); never leave the column empty
          seen.add(key);
        }
        break outer;
      }
      out.push(meaning);
      seen.add(key);
      length = next;
    }
  }
  if (out.length === 0) {
    // Nothing usable by the rule above: the first meaning of the first sense, as is.
    const first = tidy(senseMeanings[0]?.[0]);
    if (first) out.push(cut(first, MEANING_VI_MAX_CHARS));
  }
  return out;
}

// ── rows of Wiktionary that describe this entry ──────────────────────────────────────────────────────────────────

/**
 * Rows of the lemma: same word in any letter case (data.word keeps it: "April"), not a misspelling / obsolete row and not
 * an inflected form of another word. Falls back to every row of the word when that leaves nothing.
 */
export function entryRows(bundle: SourceBundle, lemma: string): WiktionaryRow[] {
  const base = bundle.flags.onlyFormRows && bundle.lemmaRows.length > 0 ? bundle.lemmaRows : bundle.wiktionaryRows;
  const same = base.filter((r) => lower(String(r.data?.word ?? r.word)) === lemma);
  const standard = same.filter((r) => !isVariantRow(r) && !isFormRow(lemma, r));
  return standard.length > 0 ? standard : same;
}

/** Letter case of the headword: the lowercase form when a normal (non-name) row has it, else what Wiktionary writes, else Haiku's. */
export function chooseHeadword(rows: readonly WiktionaryRow[], lemma: string, fallback: string): string {
  const written = rows.map((r) => ({ text: tidy(r.data?.word ?? r.word), name: isNameRow(r) })).filter((w) => w.text && lower(w.text) === lemma);
  if (written.some((w) => !w.name && w.text === lemma)) return lemma;
  const candidate = written.find((w) => !w.name) ?? written[0];
  if (candidate) return candidate.text;
  return lower(fallback) === lemma ? fallback : lemma;
}

// ── IPA and audio ────────────────────────────────────────────────────────────────────────────────────────────────

/** Accent tags that really occur in the dump (docs/lookup-refdata.md §5, lowercase). */
const US_TAGS = new Set(['us', 'general-american']);
const UK_TAGS = new Set(['uk', 'received-pronunciation', 'southern-england']);

/** "/ˈbʊlɪt/": slashes, no partial pronunciation ("/-ˌkæst/"), no narrow transcription in square brackets. */
export function cleanIpa(raw: unknown): string | null {
  const t = tidy(raw);
  if (!/^\/[^/[\]]+\/$/.test(t)) return null;
  if (t.startsWith('/-') || t.endsWith('-/')) return null;
  return t.length <= COLUMN_LIMITS.ipa ? t : null;
}

/** Free Dictionary writes IPA with or without slashes; square brackets (narrow transcription) are not used. */
export function cleanFreeDictionaryIpa(raw: unknown): string | null {
  const t = tidy(raw);
  if (!t || /[[\]]/.test(t)) return null;
  const wrapped = t.startsWith('/') && t.endsWith('/') ? t : `/${t.replace(/^\/|\/$/g, '')}/`;
  return cleanIpa(wrapped);
}

function accentOfSound(sound: any): 'us' | 'uk' | null {
  const tags = tagsOf(sound);
  const us = tags.some((t) => US_TAGS.has(t));
  const uk = tags.some((t) => UK_TAGS.has(t));
  if (us && !uk) return 'us';
  if (uk && !us) return 'uk';
  if (us && uk) return null;
  // No usable tag: the accent is only in the name of the file (en-us-ran.ogg, En-uk-London.ogg). Lingua Libre files have none.
  const file = tidy(sound?.audio) || tidy(sound?.mp3_url).split('/').pop() || '';
  if (/^en-us-/i.test(file)) return 'us';
  if (/^en-(uk|gb)-/i.test(file)) return 'uk';
  return null;
}

function soundsOf(rows: readonly WiktionaryRow[]): any[] {
  return rows.flatMap((r) => (Array.isArray(r.data?.sounds) ? r.data.sounds : []));
}

export function pickWiktionaryIpa(rows: readonly WiktionaryRow[], accent: 'us' | 'uk'): string | null {
  const wanted = accent === 'us' ? US_TAGS : UK_TAGS;
  for (const sound of soundsOf(rows)) {
    if (!tagsOf(sound).some((t) => wanted.has(t))) continue;
    const ipa = cleanIpa(sound?.ipa);
    if (ipa) return ipa;
  }
  return null;
}

/** mp3_url first (ogg_url only when there is none); the URL is kept whole or dropped, never cut. */
export function pickWiktionaryAudio(rows: readonly WiktionaryRow[], accent: 'us' | 'uk'): string | null {
  for (const sound of soundsOf(rows)) {
    if (accentOfSound(sound) !== accent) continue;
    for (const url of [sound?.mp3_url, sound?.ogg_url]) {
      const u = tidy(url);
      if (/^https?:\/\//i.test(u) && u.length <= COLUMN_LIMITS.audioUrl) return u;
    }
  }
  return null;
}

function freeDictionaryAudio(url: string | null | undefined): string | null {
  const u = tidy(url);
  return /^https?:\/\//i.test(u) && u.length <= COLUMN_LIMITS.audioUrl ? u : null;
}

// ── etymology, countable / transitive, forms ─────────────────────────────────────────────────────────────────────

/**
 * etymology_text starts with "Etymology tree" and one line per ancestor ("Proto-Indo-European *h₁én", "Latin inter") on many
 * rows; the prose follows. The prose starts at the first line of 6 words or more; a text that is only a tree (or was cut inside
 * it by the 1000-character limit of the loader) has no prose and gives null.
 */
export function cleanEtymology(raw: unknown): string | null {
  let text = typeof raw === 'string' ? raw.normalize('NFC') : '';
  if (/^\s*etymology tree\b/i.test(text)) {
    const lines = text.split('\n').slice(1);
    const start = lines.findIndex((line) => line.trim().split(/\s+/).length >= 6);
    if (start < 0) return null;
    text = lines.slice(start).join(' ');
  }
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? cut(t, ETYMOLOGY_MAX_CHARS) : null;
}

function pickEtymology(rows: readonly WiktionaryRow[]): string | null {
  for (const row of rows) {
    if (isNameRow(row)) continue;
    const e = cleanEtymology(row.data?.etymology_text);
    if (e) return e;
  }
  return null;
}

/** true when a noun row says countable (head template or sense tag), false when it only says uncountable, else null. */
export function wiktionaryCountable(rows: readonly WiktionaryRow[]): boolean | null {
  let countable = false;
  let uncountable = false;
  const read = (text: string) => {
    if (/\buncountable\b/.test(text)) uncountable = true;
    if (/\bcountable\b/.test(text)) countable = true; // \b does not match inside "uncountable"
  };
  for (const row of rows) {
    if (normalizePos(row.pos) !== 'noun') continue;
    for (const h of Array.isArray(row.data?.head_templates) ? row.data.head_templates : []) read(tidy(h?.expansion).toLowerCase());
    for (const sense of sensesOf(row)) tagsOf(sense).forEach(read);
  }
  return countable ? true : uncountable ? false : null;
}

/** true when a verb sense is transitive or ambitransitive, false when they are all intransitive, else null. */
export function wiktionaryTransitive(rows: readonly WiktionaryRow[]): boolean | null {
  let transitive = false;
  let intransitive = false;
  for (const row of rows) {
    const pos = normalizePos(row.pos);
    if (pos !== 'verb' && pos !== 'modal verb') continue;
    for (const sense of sensesOf(row)) {
      for (const tag of tagsOf(sense)) {
        if (/\bintransitive\b/.test(tag)) intransitive = true;
        else if (/\bambitransitive\b/.test(tag) || /\btransitive\b/.test(tag)) transitive = true;
      }
    }
  }
  return transitive ? true : intransitive ? false : null;
}

const NON_STANDARD = new Set<string>(NON_STANDARD_TAGS);
const TABLE_MARKERS = new Set(['table-tags', 'inflection-template', 'class']);

/**
 * word_forms from the `forms` of Wiktionary. A form is kept when its tags map to one of the 9 form_type values (inferFormType);
 * otherwise it is dropped, as is a form tagged misspelling / obsolete / archaic / nonstandard / dialectal / rare / proscribed,
 * a multi-word form ("more careful": the lookup matches single words), and a form equal to the headword or the lemma.
 */
export function buildForms(rows: readonly WiktionaryRow[], headword: string, lemma: string): AssembledForm[] {
  const out: AssembledForm[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const f of Array.isArray(row.data?.forms) ? row.data.forms : []) {
      const value = tidy(f?.form);
      if (!value || value === '-' || value.includes(' ') || value.length > COLUMN_LIMITS.formValue) continue;
      if (lower(value) === lemma || lower(value) === lower(headword)) continue;
      const tags = tagsOf(f);
      if (tags.some((t) => TABLE_MARKERS.has(t) || NON_STANDARD.has(t))) continue;
      const type = inferFormType(tags);
      if (!type) continue;
      const key = `${type}|${lower(value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ formType: type, formValue: value, sortOrder: out.length });
      if (out.length >= FORMS_MAX) return out;
    }
  }
  return out;
}

// ── synonyms and antonyms ────────────────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set(
  'the and for with that this from are was were has have had not but who which their its into out one any used use something someone often usually being such than when where also very more most other some can may'.split(' ')
);

const contentWords = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t)));

/** Dice coefficient of the content words of two English definitions. */
export function glossOverlap(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const t of x) if (y.has(t)) common++;
  return (2 * common) / (x.size + y.size);
}

export const SENSE_ALIGN_THRESHOLD = 0.25;

interface WiktionarySenseRef {
  pos: PosValue;
  gloss: string;
  synonyms: string[];
  antonyms: string[];
}

function wiktionarySenses(rows: readonly WiktionaryRow[]): WiktionarySenseRef[] {
  const out: WiktionarySenseRef[] = [];
  for (const row of rows) {
    const pos = normalizePos(row.pos);
    if (!pos) continue;
    for (const sense of sensesOf(row)) {
      out.push({
        pos,
        gloss: wordList(sense?.glosses).join(' '),
        synonyms: wordList(sense?.synonyms),
        antonyms: wordList(sense?.antonyms),
      });
    }
  }
  return out;
}

/** The Wiktionary sense of the same part of speech whose gloss best overlaps the (rewritten) definition, if it is close enough. */
export function alignSense(definitionEn: string, pos: PosValue, candidates: readonly WiktionarySenseRef[]): WiktionarySenseRef | null {
  let best: WiktionarySenseRef | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c.pos !== pos) continue;
    const score = glossOverlap(definitionEn, c.gloss);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return bestScore >= SENSE_ALIGN_THRESHOLD ? best : null;
}

/** Wiktionary's list first, then Haiku's choice; lowercase, no duplicates, never the headword or the lemma, at most 8. */
export function mergeRelated(wiktionary: readonly string[], haiku: readonly string[], exclude: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const raw of [...wiktionary, ...haiku]) {
    const w = lower(tidy(raw));
    if (!w || w.length > SYNONYM_MAX_CHARS || exclude.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= RELATED_MAX) break;
  }
  return out;
}

// ── word families ────────────────────────────────────────────────────────────────────────────────────────────────

const SINGLE_WORD = /^[a-z]+(?:['-][a-z]+)*$/;

function familyWordsOf(rows: readonly WiktionaryRow[], lemma: string): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const key of ['derived', 'related']) {
      for (const w of wordList(row.data?.[key])) {
        const word = lower(w);
        if (SINGLE_WORD.test(word) && word !== lemma && !out.includes(word)) out.push(word);
        if (out.length >= FAMILY_CANDIDATES_MAX) return out;
      }
    }
  }
  return out;
}

// ── the entry ────────────────────────────────────────────────────────────────────────────────────────────────────

const REGISTERS = new Set<string>(REGISTER_VALUES);

function frequencyRankOf(frequency: FrequencyInfo | null): number | null {
  const rank = frequency?.rank;
  return Number.isInteger(rank) && rank > 0 && rank <= 2_147_483_647 ? rank : null;
}

export function assembleEntry(bundle: SourceBundle, draft: Draft, ctx: AssembleContext): AssembleResult {
  const lemma = cut(lower(tidy(draft.lemma)), COLUMN_LIMITS.lemma);
  const rows = entryRows(bundle, lemma);
  const headword = cut(chooseHeadword(rows, lemma, tidy(draft.headword)), COLUMN_LIMITS.headword);
  const exclude = new Set([lemma, lower(headword)]);
  const wiktSenses = wiktionarySenses(rows);

  // ── senses ──
  const senses: AssembledSense[] = [];
  const senseMeanings: string[][] = [];
  const seenExamples = new Set<string>();
  for (const s of draft.senses) {
    const pos = normalizePos(s.pos);
    const meanings = s.meanings_vi.map(tidy).filter(Boolean).slice(0, SENSE_MEANINGS_MAX);
    const definitionEn = tidy(s.definition_en);
    if (!pos || (!definitionEn && meanings.length === 0)) continue;
    const aligned = alignSense(definitionEn, pos, wiktSenses);
    const examples: AssembledExample[] = [];
    for (const e of s.examples) {
      const exampleEn = tidy(e.example_en);
      const exampleVi = tidy(e.example_vi);
      const key = `${senses.length}|${lower(exampleEn)}`;
      if (!exampleEn || !exampleVi || seenExamples.has(key)) continue;
      seenExamples.add(key);
      examples.push({ exampleEn, exampleVi, sortOrder: examples.length });
    }
    const register = s.register && REGISTERS.has(s.register) ? s.register : null;
    senses.push({
      senseOrder: senses.length,
      pos,
      definitionEn,
      definitionVi: meanings.join('; '),
      register: register ? cut(register, COLUMN_LIMITS.senseRegister) : null,
      domain: orNull(cut(lower(tidy(s.domain)), COLUMN_LIMITS.senseDomain)),
      region: orNull(cut(tidy(s.region), COLUMN_LIMITS.senseRegion)),
      grammarNote: orNull(tidy(s.grammar_note)),
      usageNote: orNull(tidy(s.usage_note)),
      examples,
      synonyms: mergeRelated(aligned?.synonyms ?? [], s.synonyms, exclude).map((w) => cut(w, COLUMN_LIMITS.synonymText)),
      antonyms: mergeRelated(aligned?.antonyms ?? [], s.antonyms, exclude).map((w) => cut(w, COLUMN_LIMITS.synonymText)),
    });
    senseMeanings.push(meanings);
  }

  // ── meaning_vi and the entry fields taken from the first sense (spec §9.8, §10.6, §10.7) ──
  const parts = buildMeaningVi(senseMeanings);
  if (parts.length === 0) {
    return { status: 'invalid_output', details: ['meaning_vi would be empty: no sense has a usable Vietnamese meaning'] };
  }
  const meaningVi = parts.join('; ');
  const usedKeys = new Set(parts.map((p) => normalizeVietnameseAnswer(p)));
  const aliases: AssembledEntry['aliases'] = [];
  for (const meanings of senseMeanings) {
    for (const meaning of meanings) {
      const normalizedAnswer = normalizeVietnameseAnswer(meaning);
      if (!normalizedAnswer || usedKeys.has(normalizedAnswer)) continue;
      usedKeys.add(normalizedAnswer);
      aliases.push({ answerText: meaning, normalizedAnswer });
    }
  }

  const first = senses[0];
  const firstExample = first?.examples[0] ?? senses.find((s) => s.examples.length > 0)?.examples[0];
  const meaningEn = first?.definitionEn || null;

  // ── part of speech: the parts of speech of the senses, in order (they must agree with entry_senses.pos) ──
  let pos = normalizePosList(senses.map((s) => s.pos)).map((p) => cut(p, COLUMN_LIMITS.posElement)) as PosValue[];
  if (pos.length === 0) pos = normalizePosList(rows.map((r) => r.pos));
  if (pos.length === 0 && bundle.freeDictionary.status === 'found') pos = normalizePosList(bundle.freeDictionary.entry.pos);

  // ── pronunciation ──
  const fd = bundle.freeDictionary.status === 'found' ? bundle.freeDictionary.entry : null;
  let ipaUs = pickWiktionaryIpa(rows, 'us') ?? cleanFreeDictionaryIpa(fd?.ipa.us);
  const ipaUk = pickWiktionaryIpa(rows, 'uk') ?? cleanFreeDictionaryIpa(fd?.ipa.uk);
  let ipaFromUnknownAccent = false;
  if (!ipaUs && !ipaUk) {
    // Free Dictionary often cannot tell the accent: better an IPA of unknown accent in ipa_us than none (noted in admin_note).
    ipaUs = cleanFreeDictionaryIpa(fd?.ipa.any);
    ipaFromUnknownAccent = ipaUs !== null;
  }
  const audioUsUrl = pickWiktionaryAudio(rows, 'us') ?? freeDictionaryAudio(fd?.audio.us);
  const audioUkUrl = pickWiktionaryAudio(rows, 'uk') ?? freeDictionaryAudio(fd?.audio.uk);

  // ── flags that depend on the part of speech: Wiktionary first, then Haiku ──
  const hasNoun = pos.includes('noun');
  const hasVerb = pos.includes('verb') || pos.includes('modal verb');
  const isCountable = hasNoun ? (wiktionaryCountable(rows) ?? draft.is_countable ?? null) : null;
  const isTransitive = hasVerb ? (wiktionaryTransitive(rows) ?? draft.is_transitive ?? null) : null;

  // ── topics ──
  const tagNames: string[] = [];
  const tagIds: string[] = [];
  for (const name of draft.topics) {
    const id = ctx.topicIds.get(name);
    if (id && !tagIds.includes(id)) {
      tagNames.push(name);
      tagIds.push(id);
    }
    if (tagIds.length >= TOPICS_MAX) break;
  }

  // ── fixed-size fields ──
  const cefrLevel = draft.cefr_level ? cut(draft.cefr_level, COLUMN_LIMITS.cefrLevel) : null;
  const frequencyRank = frequencyRankOf(bundle.frequency);
  const etymology = pickEtymology(rows);
  const entryRegister = first?.register ?? null;
  const forms = buildForms(rows, headword, lemma);

  // ── lists from the draft ──
  const idioms: AssembledIdiom[] = draft.idioms.slice(0, PHRASES_MAX).map((i) => ({
    idiomText: cut(tidy(i.idiom_text), COLUMN_LIMITS.idiomText),
    definitionEn: tidy(i.definition_en),
    definitionVi: tidy(i.definition_vi),
    exampleEn: tidy(i.example_en),
    exampleVi: tidy(i.example_vi),
  }));
  const phrasalVerbs: AssembledPhrasalVerb[] = draft.phrasal_verbs.slice(0, PHRASES_MAX).map((p) => ({
    phrasalVerb: cut(tidy(p.phrasal_verb), COLUMN_LIMITS.phrasalVerb),
    particle: cut(tidy(p.particle), COLUMN_LIMITS.particle),
    isSeparable: Boolean(p.is_separable),
    definitionEn: tidy(p.definition_en),
    definitionVi: tidy(p.definition_vi),
    exampleEn: tidy(p.example_en),
    exampleVi: tidy(p.example_vi),
  }));
  const collocations: AssembledCollocation[] = draft.collocations.slice(0, PHRASES_MAX).map((c) => ({
    collocation: cut(tidy(c.collocation), COLUMN_LIMITS.collocation),
    pattern: orNull(cut(tidy(c.pattern), COLUMN_LIMITS.collocationPattern)),
    exampleEn: tidy(c.example_en),
    exampleVi: tidy(c.example_vi),
  }));

  // ── tiers (spec §3) and publication (§10.3) ──
  const hasExample = senses.some((s) => s.examples.length > 0);
  const tierAMissing: string[] = [];
  if (!headword) tierAMissing.push('headword');
  if (!lemma) tierAMissing.push('lemma');
  if (pos.length === 0) tierAMissing.push('pos');
  if (!meaningVi) tierAMissing.push('meaning_vi');
  if (!senses.some((s) => s.definitionEn && s.definitionVi)) tierAMissing.push('sense (definition_en và definition_vi)');
  if (!hasExample) tierAMissing.push('ví dụ (example_en và example_vi)');

  const tierBMissing: string[] = [];
  if (!ipaUs && !ipaUk) tierBMissing.push('ipa');
  if (!cefrLevel) tierBMissing.push('cefr_level');
  if (frequencyRank === null) tierBMissing.push('frequency_rank');
  if (hasNoun && isCountable === null) tierBMissing.push('is_countable');
  if (hasVerb && isTransitive === null) tierBMissing.push('is_transitive');
  if (tagIds.length === 0) tierBMissing.push('tag (chủ đề)');
  if (!etymology) tierBMissing.push('etymology');

  const published = ctx.publishPolicy === 'auto' && tierAMissing.length === 0;

  // ── relations that need the database (persist resolves them against existing published entries) ──
  const entrySynonymLemmas = [...new Set(senses.flatMap((s) => s.synonyms))];
  const entryAntonymLemmas = [...new Set(senses.flatMap((s) => s.antonyms))];

  const sources: string[] = [];
  if (rows.length > 0) sources.push('wiktionary');
  if (fd) sources.push('free_dictionary');
  if (frequencyRank !== null) sources.push('ref_word_frequency');
  if (bundle.datamuse && (bundle.datamuse.synonyms.length > 0 || bundle.datamuse.antonyms.length > 0)) sources.push('datamuse (chỉ là ứng viên của Haiku)');
  sources.push('haiku');

  const report: AssemblyReport = { tierAMissing, tierBMissing, estimated: cefrLevel ? [`cefr_level=${cefrLevel}`] : [], sources };

  // Wiktionary's parts of speech that the senses do not have: only informative.
  const wiktionaryPos = normalizePosList(rows.map((r) => r.pos));
  const missingPos = wiktionaryPos.filter((p) => !pos.includes(p));

  const noteParts: string[] = [
    `nguồn: ${sources.join(', ')}`,
    `model: ${ctx.model}`,
    `job: ${ctx.jobId}`,
    ctx.publishPolicy === 'review'
      ? 'published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review)'
      : tierAMissing.length > 0
        ? 'published=false: thiếu tầng A'
        : 'published=true (ENRICHMENT_PUBLISH_POLICY=auto)',
  ];
  if (tierAMissing.length > 0) noteParts.push(`thiếu tầng A: ${tierAMissing.join(', ')}`);
  if (tierBMissing.length > 0) noteParts.push(`thiếu tầng B: ${tierBMissing.join(', ')}`);
  if (report.estimated.length > 0) noteParts.push(`ước tính: ${report.estimated.join(', ')}`);
  if (ipaFromUnknownAccent) noteParts.push('ipa_us lấy từ Free Dictionary, không rõ giọng');
  if (missingPos.length > 0) noteParts.push(`loại từ của Wiktionary không có trong mục: ${missingPos.join(', ')}`);
  const reviewNotes = draft.notes_for_review.map(tidy).filter(Boolean);
  if (reviewNotes.length > 0) noteParts.push(`ghi chú của Haiku: ${reviewNotes.join(' | ')}`);
  const adminNote = cut(`[auto] ${noteParts.join(' · ')}`, ADMIN_NOTE_MAX_CHARS);

  return {
    status: 'ok',
    entry: {
      headword,
      lemma,
      pos,
      ipaUs,
      ipaUk,
      audioUsUrl,
      audioUkUrl,
      meaningVi,
      meaningEn,
      exampleEn: firstExample?.exampleEn ?? null,
      exampleVi: firstExample?.exampleVi ?? null,
      cefrLevel,
      frequencyRank,
      register: entryRegister,
      isCountable,
      isTransitive,
      etymology,
      source: 'wiktionary',
      published,
      adminNote,
      senses,
      forms,
      entrySynonymLemmas,
      entryAntonymLemmas,
      tagIds,
      tagNames,
      aliases,
      idioms,
      phrasalVerbs,
      collocations,
      familyWords: familyWordsOf(rows, lemma),
      report,
    },
  };
}

/** Rows each table would receive (for the dry run and the tests). word_families depend on the database and are not counted. */
export function countRows(entry: AssembledEntry): Record<string, number> {
  return {
    dictionary_entries: 1,
    entry_senses: entry.senses.length,
    sense_examples: entry.senses.reduce((n, s) => n + s.examples.length, 0),
    word_forms: entry.forms.length,
    sense_synonyms: entry.senses.reduce((n, s) => n + s.synonyms.length, 0),
    sense_antonyms: entry.senses.reduce((n, s) => n + s.antonyms.length, 0),
    entry_tags: entry.tagIds.length,
    entry_answer_aliases: entry.aliases.length,
    entry_idioms: entry.idioms.length,
    phrasal_verbs: entry.phrasalVerbs.length,
    collocations: entry.collocations.length,
    entry_edit_history: 1,
  };
}
