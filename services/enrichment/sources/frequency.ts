import type { Db, FrequencyInfo } from '../types';

/** zipf frequency and rank (1 = most common) from ref_word_frequency, or null when the word is not in the list. */
export async function fetchFrequency(db: Db, word: string): Promise<FrequencyInfo | null> {
  const { rows } = await db.query('SELECT zipf, rank FROM ref_word_frequency WHERE word = $1 LIMIT 1', [word]);
  if (rows.length === 0) return null;
  return { zipf: Number(rows[0].zipf), rank: Number(rows[0].rank) };
}

/**
 * rank (1 = most common) of each word that is in ref_word_frequency; words that are not in the list are absent from the
 * result. One query for the whole list. Used to decide which Wiktionary synonyms / antonyms are worth keeping.
 */
export async function fetchRanks(db: Db, words: readonly string[]): Promise<Record<string, number>> {
  const unique = [...new Set(words)];
  if (unique.length === 0) return {};
  const { rows } = await db.query('SELECT word, rank FROM ref_word_frequency WHERE word = ANY($1::text[])', [unique]);
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.word)] = Number(r.rank);
  return out;
}
