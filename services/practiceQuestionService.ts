import pool from '../config/db';
import {
  buildClozeQuestion,
  buildSwiftChoiceQuestion,
  ClozeQuestion,
  HAS_VI,
  InsufficientDistractorsError,
  NoExamplesError,
  SwiftChoiceEntry,
  SwiftChoiceQuestion,
  VI_COALESCE,
} from '../utils/questionHelpers';

interface LoadedCard extends SwiftChoiceEntry {
  card_id: string;
  examples: Array<{ example_en: string }>;
  word_forms: Array<{ form_value: string; form_type: string }>;
  distractors: Array<{ display_vi: string | null }>;
  wrong_words: Array<{ headword: string }>;
}

type QuestionResult = { card_id: string } & (
  SwiftChoiceQuestion | ClozeQuestion | { error: { code: string; message: string } }
);

// Materialize each accessible entry once, even when cards from several decks
// reference it. Every value from the request is a bound parameter.
const BATCH_QUESTION_SQL = `
  WITH requested AS MATERIALIZED (
    SELECT c.id AS card_id, de.id AS entry_id, de.headword, de.ipa_us,
           NULLIF(de.pos, '{}') AS pos, de.cefr_level, de.example_en,
           ${VI_COALESCE} AS correct_vi
    FROM cards c
    JOIN dictionary_entries de ON de.id = c.entry_id
    JOIN decks d ON d.id = c.deck_id
    WHERE c.id = ANY($1::uuid[])
      AND (d.user_id = $2 OR (d.deck_type IN ('premade', 'system_generated') AND d.status = 'published'))
  ), targets AS MATERIALIZED (
    SELECT DISTINCT entry_id, headword, ipa_us, pos, cefr_level, example_en, correct_vi FROM requested
  ), example_rows AS (
    SELECT es.entry_id, se.example_en, 0 AS priority, es.sense_order, se.sort_order
    FROM targets t
    JOIN entry_senses es ON es.entry_id = t.entry_id
    JOIN sense_examples se ON se.sense_id = es.id
    WHERE se.example_en IS NOT NULL
    UNION ALL
    SELECT t.entry_id, TRIM(legacy.example_en), 1, 0, legacy.ordinality::int
    FROM targets t
    CROSS JOIN LATERAL unnest(string_to_array(t.example_en, E'\\n'))
      WITH ORDINALITY AS legacy(example_en, ordinality)
    WHERE $3::text = 'cloze' AND TRIM(legacy.example_en) != ''
  ), examples AS (
    SELECT entry_id, jsonb_agg(jsonb_build_object('example_en', example_en)
      ORDER BY priority, sense_order, sort_order) AS items
    FROM example_rows GROUP BY entry_id
  ), forms AS (
    SELECT wf.entry_id, jsonb_agg(jsonb_build_object('form_value', wf.form_value, 'form_type', wf.form_type)) AS items
    FROM word_forms wf JOIN targets t ON t.entry_id = wf.entry_id
    WHERE $3::text = 'cloze' GROUP BY wf.entry_id
  ), loaded AS MATERIALIZED (
    SELECT t.*, COALESCE(examples.items, '[]'::jsonb) AS examples,
           COALESCE(forms.items, '[]'::jsonb) AS word_forms,
           distractors.items AS distractors, wrong_words.items AS wrong_words
    FROM targets t
    LEFT JOIN examples ON examples.entry_id = t.entry_id
    LEFT JOIN forms ON forms.entry_id = t.entry_id
    CROSS JOIN LATERAL (
      WITH preferred AS MATERIALIZED (
        SELECT ${VI_COALESCE} AS display_vi FROM dictionary_entries de
        WHERE $3::text = 'swift_choice' AND de.id != t.entry_id
          AND de.cefr_level = t.cefr_level AND (t.pos IS NULL OR de.pos && t.pos) AND ${HAS_VI}
        ORDER BY RANDOM() LIMIT 3
      ), fallback AS (
        SELECT ${VI_COALESCE} AS display_vi FROM dictionary_entries de
        WHERE $3::text = 'swift_choice' AND de.id != t.entry_id
          AND (t.pos IS NULL OR de.pos && t.pos) AND ${HAS_VI}
        ORDER BY RANDOM() LIMIT 3
      )
      SELECT COALESCE(jsonb_agg(candidates), '[]'::jsonb) AS items FROM (
        SELECT display_vi FROM preferred WHERE (SELECT COUNT(*) FROM preferred) = 3
        UNION ALL
        SELECT display_vi FROM fallback WHERE (SELECT COUNT(*) FROM preferred) < 3
      ) candidates
    ) distractors
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(candidates), '[]'::jsonb) AS items FROM (
        SELECT de.headword FROM dictionary_entries de
        WHERE $3::text = 'cloze' AND $4::int = 1 AND de.id != t.entry_id
        ORDER BY CASE WHEN t.pos[1] = ANY(de.pos) THEN 0 ELSE 1 END, RANDOM() LIMIT 3
      ) candidates
    ) wrong_words
  )
  SELECT requested.card_id, loaded.* FROM requested JOIN loaded USING (entry_id)
`;

export async function buildPracticeQuestions(
  userId: string,
  cardIds: string[],
  type: 'swift_choice' | 'cloze',
  level: 1 | 2 | 3 = 1
): Promise<QuestionResult[]> {
  const { rows } = await pool.query<LoadedCard>(BATCH_QUESTION_SQL, [cardIds, userId, type, level]);
  const cards = new Map(rows.map((row) => [row.card_id, row]));
  return Promise.all(cardIds.map(async (cardId): Promise<QuestionResult> => {
    const card = cards.get(cardId.toLowerCase());
    if (!card) {
      return { card_id: cardId, error: { code: 'CARD_NOT_FOUND', message: 'Card not found.' } };
    }
    try {
      const question = type === 'swift_choice'
        ? await buildSwiftChoiceQuestion(card, { distractors: card.distractors, examples: card.examples })
        : await buildClozeQuestion(card, level, {
            wordForms: card.word_forms, examples: card.examples, wrongWords: card.wrong_words,
          });
      return { card_id: cardId, ...question };
    } catch (error) {
      if (error instanceof InsufficientDistractorsError) {
        return { card_id: cardId, error: { code: 'INSUFFICIENT_DISTRACTORS', message: 'Not enough distractors.' } };
      }
      if (error instanceof NoExamplesError) {
        return { card_id: cardId, error: {
          code: 'NO_EXAMPLES',
          message: error.reason === 'none' ? 'No example sentences.' : 'No example contains this word or its forms.',
        } };
      }
      throw error;
    }
  }));
}
