/**
 * Shared SQL fragments + question generation helpers.
 * Used by both /api/v1/practice/* (deck-scoped, lookup via cards.id) and
 * /api/v1/leitner/* (SRS, lookup via leitner_cards.id) so the question
 * shapes stay identical across both surfaces.
 *
 * IMPORTANT: tables/columns these helpers query expect the alias `de` for
 * `dictionary_entries`. Callers must SELECT/JOIN that alias in their lookup.
 */
import pool from '../config/db';

export const VI_COALESCE = `COALESCE(
  (SELECT es.definition_vi FROM entry_senses es
   WHERE es.entry_id = de.id AND es.definition_vi IS NOT NULL
   ORDER BY es.sense_order ASC LIMIT 1),
  de.meaning_vi
)`;

export const HAS_VI = `(de.meaning_vi IS NOT NULL OR EXISTS (
  SELECT 1 FROM entry_senses es
  WHERE es.entry_id = de.id AND es.definition_vi IS NOT NULL
))`;

export function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function maskWord(sentence: string, word: string): string {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sentence.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '___');
}

export function findWordInSentence(
  sentence: string,
  candidates: string[]
): { form: string } | null {
  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = sentence.match(new RegExp(`\\b${escaped}\\b`, 'i'));
    if (match) return { form: match[0] };
  }
  return null;
}

export class InsufficientDistractorsError extends Error {
  constructor() {
    super('INSUFFICIENT_DISTRACTORS');
    this.name = 'InsufficientDistractorsError';
  }
}

export class NoExamplesError extends Error {
  /** 'none': the word has no example sentence at all; 'no_match': it has some, but none contains the word (or a form of it) */
  constructor(public readonly reason: 'none' | 'no_match' = 'none') {
    super('NO_EXAMPLES');
    this.name = 'NoExamplesError';
  }
}

// ── SwiftChoice ────────────────────────────────────────────────────────────────

export interface SwiftChoiceEntry {
  entry_id: string;
  headword: string;
  ipa_us: string | null;
  pos: string[] | null;
  cefr_level: string | null;
  correct_vi: string | null;
}

export interface SwiftChoiceQuestion {
  question_type: 'meaning_from_word';
  prompt: { word: string; ipa_us: string | null; pos: string | null };
  hint_example: string | null;
  options: { index: number; text: string }[];
  correct_index: number;
}

export interface SwiftChoiceData {
  distractors: Array<{ display_vi: string | null }>;
  examples: Array<{ example_en: string }>;
}

/**
 * Generate a SwiftChoice multi-choice question for the given entry.
 * Distractors are drawn from a cross-deck pool: same cefr_level + overlapping
 * pos preferred; falls back to any pos in the level if not enough.
 *
 * Throws InsufficientDistractorsError when fewer than 3 distractors can be found.
 */
/**
 * Three random wrong answers, in ONE statement. The preferred set is same CEFR level (+ overlapping pos when the word has one);
 * only when it does not yield three is the fallback set drawn instead (any level / same pos), exactly the old two-step logic —
 * the second query used to be a second round trip. PostgreSQL skips the fallback altogether when the preferred set is complete
 * (its branch sits behind a one-time filter).
 */
async function fetchDistractors(entry: SwiftChoiceEntry, posArray: string[] | null): Promise<Array<{ display_vi: string | null }>> {
  const preferred = posArray
    ? `SELECT ${VI_COALESCE} AS display_vi FROM dictionary_entries de
        WHERE de.cefr_level = $1 AND de.id != $2 AND de.pos && $3::varchar[] AND ${HAS_VI}
        ORDER BY RANDOM() LIMIT 3`
    : `SELECT ${VI_COALESCE} AS display_vi FROM dictionary_entries de
        WHERE de.cefr_level = $1 AND de.id != $2 AND ${HAS_VI}
        ORDER BY RANDOM() LIMIT 3`;
  const fallback = posArray
    ? `SELECT ${VI_COALESCE} AS display_vi FROM dictionary_entries de
        WHERE de.id != $2 AND de.pos && $3::varchar[] AND ${HAS_VI}
        ORDER BY RANDOM() LIMIT 3`
    : `SELECT ${VI_COALESCE} AS display_vi FROM dictionary_entries de
        WHERE de.id != $2 AND ${HAS_VI}
        ORDER BY RANDOM() LIMIT 3`;

  const { rows } = await pool.query(
    `WITH preferred AS (${preferred}), fallback AS (${fallback})
     SELECT display_vi FROM preferred WHERE (SELECT COUNT(*) FROM preferred) = 3
     UNION ALL
     SELECT display_vi FROM fallback  WHERE (SELECT COUNT(*) FROM preferred) < 3`,
    posArray ? [entry.cefr_level, entry.entry_id, posArray] : [entry.cefr_level, entry.entry_id]
  );
  return rows;
}

export async function buildSwiftChoiceQuestion(
  entry: SwiftChoiceEntry,
  data?: SwiftChoiceData
): Promise<SwiftChoiceQuestion> {
  const posArray =
    Array.isArray(entry.pos) && entry.pos.length > 0 ? entry.pos : null;

  // The distractors and the hint example do not depend on each other: one round trip for both (they were up to four in a row).
  const [distractors, { rows: exRows }] = data
    ? [data.distractors, { rows: data.examples }]
    : await Promise.all([
        fetchDistractors(entry, posArray),
        pool.query(
          `SELECT se.example_en
           FROM sense_examples se
           JOIN entry_senses es ON es.id = se.sense_id
           WHERE es.entry_id = $1 AND se.example_en IS NOT NULL
           ORDER BY es.sense_order ASC, se.sort_order ASC LIMIT 1`,
          [entry.entry_id]
        ),
      ]);

  if (distractors.length < 3) throw new InsufficientDistractorsError();

  const hintExample = exRows.length > 0
    ? `e.g., ${maskWord(exRows[0].example_en, entry.headword)}`
    : null;

  const optionItems = shuffleArray([
    { text: entry.correct_vi || '', correct: true },
    { text: distractors[0].display_vi || '', correct: false },
    { text: distractors[1].display_vi || '', correct: false },
    { text: distractors[2].display_vi || '', correct: false },
  ]);
  const options = optionItems.map((opt, idx) => ({ index: idx, text: opt.text }));
  const correct_index = optionItems.findIndex((opt) => opt.correct);

  return {
    question_type: 'meaning_from_word',
    prompt: {
      word: entry.headword,
      ipa_us: entry.ipa_us || null,
      pos: posArray?.[0] ?? null,
    },
    hint_example: hintExample,
    options,
    correct_index,
  };
}

// ── Cloze ─────────────────────────────────────────────────────────────────────

export interface ClozeEntry {
  entry_id: string;
  headword: string;
  pos: string[] | null;
}

export interface ClozeQuestion {
  level: 1 | 2 | 3;
  target_word: string;
  sentence_masked: string;
  sentence_full: string;
  hint_pos: string | null;
  hint_tense: string | null;
  word_choices: string[] | null;
  scrambled_letters: string[] | null;
}

export interface ClozeData {
  wordForms: Array<{ form_value: string; form_type: string }>;
  examples: Array<{ example_en: string }>;
  wrongWords: Array<{ headword: string }> | null;
}

/**
 * Generate a Cloze question. Searches the entry's sense_examples first, then
 * falls back to legacy `dictionary_entries.example_en` (newline-split).
 * Throws NoExamplesError when no usable example sentence is found.
 */
/** Three random other headwords, the ones sharing the part of speech first. */
async function fetchWrongWords(entryId: string, hintPos: string | null): Promise<Array<{ headword: string }>> {
  const { rows } = hintPos
    ? await pool.query(
        `SELECT de.headword FROM dictionary_entries de
         WHERE de.id != $1
         ORDER BY CASE WHEN $2 = ANY(de.pos) THEN 0 ELSE 1 END, RANDOM() LIMIT 3`,
        [entryId, hintPos]
      )
    : await pool.query(
        `SELECT de.headword FROM dictionary_entries de
         WHERE de.id != $1 ORDER BY RANDOM() LIMIT 3`,
        [entryId]
      );
  return rows;
}

export async function buildClozeQuestion(
  entry: ClozeEntry,
  level: 1 | 2 | 3,
  data?: ClozeData
): Promise<ClozeQuestion> {
  const hintPosForChoices = Array.isArray(entry.pos) && entry.pos.length > 0 ? entry.pos[0] : null;

  // The wrong words of level 1 only need the entry, so they are read with the word forms and the examples (one round trip, not two).
  const [{ rows: wfRows }, { rows: examples }, wrongWordRows] = data
    ? [{ rows: data.wordForms }, { rows: data.examples }, data.wrongWords]
    : await Promise.all([
        pool.query(`SELECT form_value, form_type FROM word_forms WHERE entry_id = $1`, [entry.entry_id]),
        pool.query(
          `SELECT example_en FROM (
             SELECT se.example_en, 0 AS priority, es.sense_order, se.sort_order
             FROM sense_examples se
             JOIN entry_senses es ON es.id = se.sense_id
             WHERE es.entry_id = $1 AND se.example_en IS NOT NULL
             UNION ALL
             SELECT TRIM(unnest) AS example_en, 1 AS priority, 0 AS sense_order, ordinality::int AS sort_order
             FROM dictionary_entries de,
                  LATERAL unnest(string_to_array(de.example_en, E'\\n')) WITH ORDINALITY AS unnest
             WHERE de.id = $1 AND de.example_en IS NOT NULL AND TRIM(unnest) != ''
           ) AS combined
           ORDER BY priority ASC, sense_order ASC, sort_order ASC`,
          [entry.entry_id]
        ),
        level === 1 ? fetchWrongWords(entry.entry_id, hintPosForChoices) : Promise.resolve(null),
      ]);

  if (examples.length === 0) throw new NoExamplesError();

  const wordForms = wfRows.map((r: any) => ({ value: r.form_value, type: r.form_type }));
  const candidates = [
    entry.headword,
    ...wordForms.sort((a, b) => b.value.length - a.value.length).map((wf) => wf.value),
  ];

  let targetWord: string | null = null;
  let targetExample: string | null = null;
  let matchedFormType: string | null = null;

  for (const ex of shuffleArray(examples)) {
    const found = findWordInSentence(ex.example_en, candidates);
    if (found) {
      targetWord = found.form;
      targetExample = ex.example_en;
      const lowerForm = found.form.toLowerCase();
      const matchedWF = wordForms.find((wf) => wf.value.toLowerCase() === lowerForm);
      matchedFormType = matchedWF ? matchedWF.type : null;
      break;
    }
  }

  if (!targetWord || !targetExample) throw new NoExamplesError('no_match');

  const sentenceMasked = maskWord(targetExample, targetWord);
  const hintPos = Array.isArray(entry.pos) && entry.pos.length > 0 ? entry.pos[0] : null;

  let wordChoices: string[] | null = null;
  let scrambledLetters: string[] | null = null;

  if (level === 1) {
    wordChoices = shuffleArray([
      targetWord,
      ...(wrongWordRows ?? []).map((r: any) => r.headword as string),
    ]);
  } else if (level === 2) {
    const CONSONANTS = 'bcdfghjklmnpqrstvwxyz';
    const letters = targetWord.split('');
    const decoyCount = letters.length <= 4 ? 1 : 2;
    for (let i = 0; i < decoyCount; i++) {
      letters.push(CONSONANTS[Math.floor(Math.random() * CONSONANTS.length)]);
    }
    scrambledLetters = shuffleArray(letters);
  }

  return {
    level,
    target_word: targetWord,
    sentence_masked: sentenceMasked,
    sentence_full: targetExample,
    hint_pos: hintPos,
    hint_tense: matchedFormType,
    word_choices: wordChoices,
    scrambled_letters: scrambledLetters,
  };
}
