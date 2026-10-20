/**
 * Reader of the Oxford 5000 word list (docs/lookup-runbook.md §13).
 *
 * WHAT IS TAKEN: the word, its part of speech (`type`) and its CEFR level. NOTHING ELSE is kept. The definitions and examples of
 * Oxford are the property of OUP and are never read into the pipeline (the pipeline writes its own content); the IPA and the audio
 * links are only COUNTED (is there one?) to report how much of it the file covers, and are dropped at once.
 *
 * Two row shapes are accepted:
 *   - the shape of the file in use:  { id, value: { word, type, level, phonetics: { us, uk }, us: { mp3, ogg }, uk: { mp3, ogg }, ... } }
 *   - the flat shape described by docs/reference/import-oxford.mjs:  { word, type, cefr, phon_br, phon_n_am, uk, us, ... }
 *
 * Words are lower-cased and rows of the same word are merged into ONE word with the set of its parts of speech and its LOWEST CEFR
 * level. Pure: no database, no network.
 */
import fs from 'node:fs';
import { normalizeWord } from '../../wordTranslationService';

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type Cefr = (typeof CEFR_LEVELS)[number];

/** 0 for A1 … 5 for C2; 6 for "no level" (sorts last). */
export function cefrRank(level: string | null | undefined): number {
  const i = (CEFR_LEVELS as readonly string[]).indexOf(String(level ?? '').toUpperCase());
  return i < 0 ? CEFR_LEVELS.length : i;
}

export function toCefr(value: unknown): Cefr | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase();
  return (CEFR_LEVELS as readonly string[]).includes(v) ? (v as Cefr) : null;
}

export interface OxfordWord {
  /** lower case, as the lookup cleaner writes it */
  word: string;
  /** parts of speech of every row of the word, in order of first appearance, without repeats */
  pos: string[];
  /** the part of speech of the row that gave the lowest level (the first row when no row has a level): used to mix the sample */
  primaryPos: string | null;
  /** LOWEST level of the word; null when no row has a valid level */
  cefr: Cefr | null;
  /** every distinct valid level seen for the word, lowest first */
  levels: Cefr[];
  rows: number;
  /** the file has an IPA / an audio link for the word (the values themselves are NOT kept) */
  hasIpa: boolean;
  hasAudioUs: boolean;
  hasAudioUk: boolean;
}

export interface InvalidWord {
  word: string;
  /** several words, or something else the cleaner refuses */
  category: 'multi_word' | 'other';
  /** the cleaner's own reason */
  reason: string;
  rows: number;
}

export interface ParsedOxford {
  /** rows in the file */
  rows: number;
  /** rows that have no usable word at all (skipped) */
  rowsWithoutWord: number;
  /** rows whose level is blank or not A1…C2 */
  rowsWithoutLevel: number;
  /** distinct words (lower case) before the cleaner */
  distinctWords: number;
  /** words that appear on more than one row, and the rows beyond the first that were merged into them */
  mergedWords: number;
  mergedExtraRows: number;
  /** words with more than one distinct level (the lowest wins) */
  multiLevelWords: number;
  /** words the lookup cleaner accepts, in order of first appearance */
  words: OxfordWord[];
  /** words the cleaner refuses (several words, odd characters) */
  invalid: InvalidWord[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Something that says there is an audio link: a non-empty string, or an object with a non-empty mp3 / ogg. */
function hasAudio(v: unknown): boolean {
  if (typeof v === 'string') return v.trim() !== '';
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some((x) => typeof x === 'string' && x.trim() !== '');
  return false;
}

function hasIpaIn(item: any, accent: 'us' | 'uk'): boolean {
  const p = item.phonetics;
  if (p && typeof p === 'object' && str(p[accent]) !== '') return true;
  return str(accent === 'us' ? item.phon_n_am : item.phon_br) !== '';
}

interface RawRow {
  word: string;
  type: string | null;
  level: Cefr | null;
  ipa: boolean;
  audioUs: boolean;
  audioUk: boolean;
}

/** Reads ONLY word, type, level and the presence of IPA / audio from one element of the file. */
export function readRow(element: unknown): RawRow | null {
  if (!element || typeof element !== 'object') return null;
  const outer = element as any;
  const item = outer.value && typeof outer.value === 'object' ? outer.value : outer;
  const word = str(item.word).toLowerCase();
  if (!word) return null;
  return {
    word,
    type: str(item.type ?? item.pos) || null,
    level: toCefr(item.level ?? item.cefr),
    ipa: hasIpaIn(item, 'us') || hasIpaIn(item, 'uk'),
    audioUs: hasAudio(item.us),
    audioUk: hasAudio(item.uk),
  };
}

export function parseOxford(json: unknown): ParsedOxford {
  if (!Array.isArray(json)) throw new Error('The Oxford file must contain a JSON array of rows');

  const byWord = new Map<string, RawRow[]>();
  let rowsWithoutWord = 0;
  let rowsWithoutLevel = 0;
  for (const element of json) {
    const row = readRow(element);
    if (!row) {
      rowsWithoutWord++;
      continue;
    }
    if (!row.level) rowsWithoutLevel++;
    const list = byWord.get(row.word);
    if (list) list.push(row);
    else byWord.set(row.word, [row]);
  }

  const words: OxfordWord[] = [];
  const invalid: InvalidWord[] = [];
  let mergedWords = 0;
  let mergedExtraRows = 0;
  let multiLevelWords = 0;

  for (const [word, rows] of byWord) {
    if (rows.length > 1) {
      mergedWords++;
      mergedExtraRows += rows.length - 1;
    }
    const clean = normalizeWord(word);
    if (!clean.isValid || clean.normalized !== word) {
      invalid.push({ word, category: /\s/.test(word) ? 'multi_word' : 'other', reason: clean.reason ?? 'the cleaner changed the word', rows: rows.length });
      continue;
    }

    const levels = [...new Set(rows.map((r) => r.level).filter((l): l is Cefr => l !== null))].sort((a, b) => cefrRank(a) - cefrRank(b));
    if (levels.length > 1) multiLevelWords++;
    const cefr = levels[0] ?? null;
    const lowestRow = rows.find((r) => r.level === cefr) ?? rows[0];
    words.push({
      word,
      pos: [...new Set(rows.map((r) => r.type).filter((t): t is string => t !== null))],
      primaryPos: lowestRow.type,
      cefr,
      levels,
      rows: rows.length,
      hasIpa: rows.some((r) => r.ipa),
      hasAudioUs: rows.some((r) => r.audioUs),
      hasAudioUk: rows.some((r) => r.audioUk),
    });
  }

  return {
    rows: json.length,
    rowsWithoutWord,
    rowsWithoutLevel,
    distinctWords: byWord.size,
    mergedWords,
    mergedExtraRows,
    multiLevelWords,
    words,
    invalid,
  };
}

export function readOxfordFile(file: string): ParsedOxford {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseOxford(json);
}

/** How much of a set of words the file covers with IPA and audio (counts, not content). */
export function coverageOf(words: readonly OxfordWord[]): { words: number; ipa: number; audioUs: number; audioUk: number } {
  return {
    words: words.length,
    ipa: words.filter((w) => w.hasIpa).length,
    audioUs: words.filter((w) => w.hasAudioUs).length,
    audioUk: words.filter((w) => w.hasAudioUk).length,
  };
}
