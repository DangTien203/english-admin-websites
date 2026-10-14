import type { Db, FrequencyInfo } from '../types';

/** zipf frequency and rank (1 = most common) from ref_word_frequency, or null when the word is not in the list. */
export async function fetchFrequency(db: Db, word: string): Promise<FrequencyInfo | null> {
  const { rows } = await db.query('SELECT zipf, rank FROM ref_word_frequency WHERE word = $1 LIMIT 1', [word]);
  if (rows.length === 0) return null;
  return { zipf: Number(rows[0].zipf), rank: Number(rows[0].rank) };
}
