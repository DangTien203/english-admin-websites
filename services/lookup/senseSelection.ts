import type { FdSense } from '../upstream/freeDictionaryClient';

/**
 * Sense selection and the "word: definition" translation technique (docs/lookup-spec.md §5 F9).
 * Pure functions: no I/O, easy to test. Experiment results: docs/lookup-multimeaning-experiment.md.
 */

/**
 * Picks up to `max` diverse senses:
 *   round 0 — the first sense of every part of speech, in order of appearance;
 *   round 1+ — further senses of the MAIN part of speech first (the one with the most senses,
 *              ties broken by appearance order), then of the others.
 * Duplicate definitions are skipped.
 */
export function selectSenses(senses: readonly FdSense[], max: number): FdSense[] {
  if (max <= 0 || senses.length === 0) return [];

  const order: string[] = [];
  const byPos = new Map<string, FdSense[]>();
  for (const sense of senses) {
    if (!byPos.has(sense.pos)) {
      byPos.set(sense.pos, []);
      order.push(sense.pos);
    }
    byPos.get(sense.pos)!.push(sense);
  }

  const main = order.reduce((best, pos) => (byPos.get(pos)!.length > byPos.get(best)!.length ? pos : best), order[0]);
  const laterRounds = [main, ...order.filter((p) => p !== main)];

  const picked: FdSense[] = [];
  const seen = new Set<string>();
  const take = (sense: FdSense | undefined): void => {
    if (!sense || picked.length >= max) return;
    const key = sense.definition.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    picked.push(sense);
  };

  for (const pos of order) take(byPos.get(pos)![0]);
  const deepest = Math.max(...[...byPos.values()].map((list) => list.length));
  for (let round = 1; round < deepest && picked.length < max; round++) {
    for (const pos of laterRounds) take(byPos.get(pos)![round]);
  }
  return picked;
}

/** Cuts text to at most `maxChars`, preferring a word boundary, with no dangling punctuation. */
export function truncateDefinition(text: string, maxChars: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= maxChars) return t;
  let cut = t.slice(0, maxChars);
  // Mid-word cut → back up to the last space, unless that would throw away most of the text.
  if (t[maxChars] !== ' ') {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > maxChars * 0.5) cut = cut.slice(0, lastSpace);
  }
  return cut.replace(/[\s,;:\-–—(]+$/u, '');
}

/** q for one Google request element: "<word>: <english definition, truncated>". */
export function buildPrefixedQuery(word: string, definition: string, maxDefinitionChars: number): string {
  return `${word}: ${truncateDefinition(definition, maxDefinitionChars)}`;
}

export interface GlossSplit {
  /** Short Vietnamese meaning that belongs to THIS sense, or null when unusable. */
  gloss_vi: string | null;
  /** Vietnamese definition (the part after the separator), or null. */
  definition_vi: string | null;
}

export const GLOSS_MAX_CHARS = 40;
export const GLOSS_MAX_WORDS = 5;

// The first separator wins. ':' is what we send. In the experiment (44 answers) Google kept it every
// time, so no fallback separator is needed; the full-width form is accepted only because it is harmless.
// A spaced dash was deliberately NOT added: definitions contain " - " and it would split them wrongly.
const SEPARATOR = /\s*[:：]\s*/u;

/**
 * Splits Google's answer for a prefixed query into gloss + definition.
 * The gloss is dropped when empty, longer than 40 chars, longer than 5 words, or identical to the
 * source word unless `keepEcho` is true. An echo means Google left the word untranslated ("bank" for
 * a verb sense of bank) — not a meaning — EXCEPT for loanwords (taxi), where the headline translation
 * is the same word too and Free Dictionary confirmed it. The caller computes that and passes keepEcho.
 */
export function splitGloss(translated: string, sourceWord: string, keepEcho: boolean): GlossSplit {
  const text = translated.trim();
  if (!text) return { gloss_vi: null, definition_vi: null };

  const match = SEPARATOR.exec(text);
  if (!match) return { gloss_vi: null, definition_vi: text };

  const rawGloss = text.slice(0, match.index);
  const definition = text.slice(match.index + match[0].length).trim();
  return { gloss_vi: cleanGloss(rawGloss, sourceWord, keepEcho), definition_vi: definition || null };
}

export function cleanGloss(raw: string, sourceWord: string, keepEcho: boolean): string | null {
  let g = raw.trim().replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/gu, '').trim();
  if (!g) return null;
  g = g.charAt(0).toLocaleLowerCase('vi') + g.slice(1);
  if (g.length > GLOSS_MAX_CHARS) return null;
  if (g.split(/\s+/).length > GLOSS_MAX_WORDS) return null;
  if (!keepEcho && g.toLocaleLowerCase('vi') === sourceWord.trim().toLocaleLowerCase('vi')) return null;
  return g;
}

// Leading classifier words that make "con dơi" and "dơi" the same meaning.
const CLASSIFIERS = new Set(['con', 'cái', 'chiếc', 'việc', 'sự', 'cuộc', 'người']);

/** Case/whitespace-insensitive key used to drop duplicate meanings; ignores a leading classifier word. */
export function meaningKey(s: string): string {
  const words = s.normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim().split(' ');
  if (words.length > 1 && CLASSIFIERS.has(words[0])) words.shift();
  return words.join(' ');
}

/** De-duplicates (first occurrence wins), drops empties, cuts to `max`. */
export function dedupeMeanings(values: ReadonlyArray<string | null | undefined>, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    const key = meaningKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}
