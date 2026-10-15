import { POS_VALUES, type PosValue } from './haiku/schema';

/**
 * Part-of-speech names of the sources → the 12 values already used in the database
 * (dictionary_entries.pos[] and entry_senses.pos, docs/lookup-enrichment.md §1.1).
 *
 * Wiktionary (kaikki) codes: adj, adv, intj, prep, conj, pron, det, num, art, name, phrase, prefix, suffix, contraction, ...
 * Free Dictionary names: noun, verb, adjective, adverb, interjection, preposition, conjunction, pronoun, ...
 *
 * `name` is a proper noun (not an entry), and phrase / prefix / suffix / contraction / particle / symbol... are not among
 * the 12 values: they map to null, which callers drop (nothing is guessed).
 */
const POS_ALIASES: Record<string, PosValue> = {
  noun: 'noun',
  n: 'noun',
  verb: 'verb',
  v: 'verb',
  adj: 'adjective',
  adjective: 'adjective',
  adv: 'adverb',
  adverb: 'adverb',
  prep: 'preposition',
  preposition: 'preposition',
  conj: 'conjunction',
  conjunction: 'conjunction',
  pron: 'pronoun',
  pronoun: 'pronoun',
  det: 'determiner',
  determiner: 'determiner',
  intj: 'exclamation',
  interj: 'exclamation',
  interjection: 'exclamation',
  exclamation: 'exclamation',
  num: 'number',
  number: 'number',
  numeral: 'number',
  art: 'article',
  article: 'article',
  'modal verb': 'modal verb',
  modal: 'modal verb',
};

/** The database value for a source's part-of-speech name, or null when it is not one of the 12. */
export function normalizePos(raw: unknown): PosValue | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  return POS_ALIASES[key] ?? null;
}

/** normalizePos over a list: in order of first appearance, duplicates and unknown names removed. */
export function normalizePosList(raw: readonly unknown[]): PosValue[] {
  const out: PosValue[] = [];
  for (const item of raw) {
    const pos = normalizePos(item);
    if (pos && !out.includes(pos)) out.push(pos);
  }
  return out;
}

export const isPosValue = (value: unknown): value is PosValue => typeof value === 'string' && (POS_VALUES as readonly string[]).includes(value);
