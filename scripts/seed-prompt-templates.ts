import 'dotenv/config';
import pool from '../config/db';

const SYSTEM_PROMPT = `You are an English language evaluator for Vietnamese learners.
Evaluate each target_word–sentence pair provided.

For each pair return a JSON object with these snake_case fields:
- target_word: the target word exactly as given
- sentence: the original sentence unchanged
- used_target: true if the target word (or any valid inflected form: past tense, gerund, 3rd-person singular, participle, comparative, superlative, etc.) appears in the sentence
- grammar_ok: true if the sentence is grammatically correct AND the target word is used appropriately in context
- errors: array of error objects with fields "type" (e.g. "grammar", "usage", "spelling", "word_form"), "location" (the erroneous phrase or word), and "message" (clear description of the error); empty array if no errors
- fix: the corrected version of the full sentence, or empty string "" if no correction is needed
- explanation_vi: explanation in Vietnamese — confirm what is correct, or explain each mistake and how to fix it (2–4 sentences)

After evaluating all pairs, provide:
- overall_score: integer 0–100 based on grammar accuracy and appropriate word usage across all sentences
- overall_feedback_vi: overall feedback in Vietnamese (1–2 sentences)

Guidelines:
- Be strict but fair: wrong articles, wrong tense, wrong prepositions, and missing subjects should all be flagged
- Accept inflected forms of the target word (e.g. "organized" for "organize", "achieving" for "achieve")
- If the target word is completely absent and no valid inflected form is present, set used_target=false and grammar_ok=false
- Do not flag minor stylistic choices as errors — only flag clear grammatical mistakes
- All JSON keys must be snake_case. No camelCase.`;

const EXPECTED_SCHEMA = {
  results: [{
    target_word: 'string',
    sentence: 'string',
    used_target: 'boolean',
    grammar_ok: 'boolean',
    errors: [{ type: 'string', location: 'string', message: 'string' }],
    fix: 'string',
    explanation_vi: 'string',
  }],
  overall_score: 'integer 0-100',
  overall_feedback_vi: 'string',
};

async function seed() {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-2024-08-06';

  const { rows: existing } = await pool.query(
    `SELECT id FROM prompt_templates
     WHERE name = 'retrieval_practice_grader' AND status = 'active'
     LIMIT 1`
  );

  if (existing.length > 0) {
    console.log('[seed-prompt-templates] retrieval_practice_grader already active, skipping');
    await pool.end();
    return;
  }

  await pool.query(
    `INSERT INTO prompt_templates
       (name, description, model, system_prompt, expected_schema, version, status)
     VALUES ($1, $2, $3, $4, $5, 1, 'active')
     ON CONFLICT DO NOTHING`,
    [
      'retrieval_practice_grader',
      'Grades retrieval practice sentences using GPT-4o structured output (snake_case)',
      model,
      SYSTEM_PROMPT,
      JSON.stringify(EXPECTED_SCHEMA),
    ]
  );

  console.log('[seed-prompt-templates] Inserted: retrieval_practice_grader (active)');
  await pool.end();
}

seed().catch(err => {
  console.error('[seed-prompt-templates] Error:', err);
  process.exit(1);
});
