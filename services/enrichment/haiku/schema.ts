import { z } from 'zod';
import { TOPIC_NAMES } from '../topics';

/**
 * Output contract of the Claude Haiku call (docs/lookup-spec.md §9.2, §9.5; final key names in docs/lookup-enrichment.md).
 *
 * Two descriptions of the SAME shape live here and must stay in step:
 *   - DraftSchema        zod: the checks the API cannot do (limits, cross-field rules run in validators.ts)
 *   - DRAFT_JSON_SCHEMA  JSON Schema sent as output_config.format; only keywords the API supports (§9.2):
 *                        no recursion; no minimum / maximum / minLength / maxLength; arrays only minItems 0 or 1;
 *                        additionalProperties false; every property required; enum values are strings or null.
 * tests/enrichment/schema.test.ts proves they list the same keys at every level and that the JSON Schema
 * contains no forbidden keyword.
 */

/** dictionary_entries.pos / entry_senses.pos values already in the database (docs/lookup-enrichment.md §1). */
export const POS_VALUES = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'preposition',
  'conjunction',
  'pronoun',
  'determiner',
  'exclamation',
  'modal verb',
  'number',
  'article',
] as const;

/** CHECK constraint of dictionary_entries.register and entry_senses.register (migration 01). */
export const REGISTER_VALUES = ['formal', 'informal', 'slang', 'literary', 'technical', 'dated', 'humorous'] as const;

/** CHECK constraint of dictionary_entries.cefr_level. */
export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

export const LIMITS = {
  /** senses per entry */
  senses: 6,
  /** Vietnamese meanings per sense: the hard limit. The TARGET (2 to 4) is in the system prompt. */
  meaningsPerSense: 4,
  examplesPerSense: 2,
  topics: 3,
  /** synonyms / antonyms per sense */
  related: 8,
  /** idioms, phrasal verbs, collocations */
  phrases: 5,
  notes: 10,
} as const;

export type PosValue = (typeof POS_VALUES)[number];
export type RegisterValue = (typeof REGISTER_VALUES)[number];
export type CefrLevel = (typeof CEFR_LEVELS)[number];

// ── zod ──────────────────────────────────────────────────────────────────────

const text = z.string();
const nullableText = z.string().nullable();

export const ExampleSchema = z.strictObject({
  example_en: text,
  example_vi: text,
});

export const SenseSchema = z.strictObject({
  pos: z.enum(POS_VALUES),
  definition_en: text,
  meanings_vi: z.array(text).min(1).max(LIMITS.meaningsPerSense),
  register: z.enum(REGISTER_VALUES).nullable(),
  domain: nullableText,
  region: nullableText,
  grammar_note: nullableText,
  usage_note: nullableText,
  examples: z.array(ExampleSchema).min(1).max(LIMITS.examplesPerSense),
  synonyms: z.array(text),
  antonyms: z.array(text),
});

/** entry_idioms columns: idiom_text, definition_en, definition_vi, example_en, example_vi (register left to admins). */
export const IdiomSchema = z.strictObject({
  idiom_text: text,
  definition_en: text,
  definition_vi: text,
  example_en: text,
  example_vi: text,
});

/** phrasal_verbs columns: phrasal_verb, particle, is_separable, definition_en, definition_vi, example_en, example_vi. */
export const PhrasalVerbSchema = z.strictObject({
  phrasal_verb: text,
  particle: text,
  is_separable: z.boolean(),
  definition_en: text,
  definition_vi: text,
  example_en: text,
  example_vi: text,
});

/** collocations columns: collocation, pattern, example_en, example_vi (sense_id / frequency are not guessed). */
export const CollocationSchema = z.strictObject({
  collocation: text,
  pattern: text,
  example_en: text,
  example_vi: text,
});

export const DraftSchema = z.strictObject({
  is_english_word: z.boolean(),
  is_proper_noun: z.boolean(),
  variant_of: nullableText,
  headword: text,
  lemma: text,
  pos: z.array(z.enum(POS_VALUES)),
  cefr_level: z.enum(CEFR_LEVELS).nullable(),
  is_countable: z.boolean().nullable(),
  is_transitive: z.boolean().nullable(),
  // Plain strings here: the API enforces the enum, and validators.ts DROPS an unknown name (never replaced by academic_formal).
  topics: z.array(text),
  senses: z.array(SenseSchema).max(LIMITS.senses),
  idioms: z.array(IdiomSchema),
  phrasal_verbs: z.array(PhrasalVerbSchema),
  collocations: z.array(CollocationSchema),
  notes_for_review: z.array(text),
});

export type Example = z.infer<typeof ExampleSchema>;
export type Sense = z.infer<typeof SenseSchema>;
export type Idiom = z.infer<typeof IdiomSchema>;
export type PhrasalVerb = z.infer<typeof PhrasalVerbSchema>;
export type Collocation = z.infer<typeof CollocationSchema>;
export type Draft = z.infer<typeof DraftSchema>;

// ── JSON Schema (output_config.format) ───────────────────────────────────────

type JsonSchema = Record<string, unknown>;

const str: JsonSchema = { type: 'string' };
const nullableStr: JsonSchema = { type: ['string', 'null'] };

const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const arr = (items: JsonSchema, minItems?: 0 | 1): JsonSchema => ({ type: 'array', items, ...(minItems === undefined ? {} : { minItems }) });

export const DRAFT_JSON_SCHEMA: JsonSchema = obj({
  is_english_word: { type: 'boolean' },
  is_proper_noun: { type: 'boolean' },
  variant_of: nullableStr,
  headword: str,
  lemma: str,
  pos: arr({ type: 'string', enum: [...POS_VALUES] }),
  cefr_level: { enum: [...CEFR_LEVELS, null] },
  is_countable: { type: ['boolean', 'null'] },
  is_transitive: { type: ['boolean', 'null'] },
  topics: arr({ type: 'string', enum: [...TOPIC_NAMES] }),
  senses: arr(
    obj({
      pos: { type: 'string', enum: [...POS_VALUES] },
      definition_en: str,
      meanings_vi: arr(str, 1),
      register: { enum: [...REGISTER_VALUES, null] },
      domain: nullableStr,
      region: nullableStr,
      grammar_note: nullableStr,
      usage_note: nullableStr,
      examples: arr(obj({ example_en: str, example_vi: str }), 1),
      synonyms: arr(str),
      antonyms: arr(str),
    })
  ),
  idioms: arr(obj({ idiom_text: str, definition_en: str, definition_vi: str, example_en: str, example_vi: str })),
  phrasal_verbs: arr(
    obj({
      phrasal_verb: str,
      particle: str,
      is_separable: { type: 'boolean' },
      definition_en: str,
      definition_vi: str,
      example_en: str,
      example_vi: str,
    })
  ),
  collocations: arr(obj({ collocation: str, pattern: str, example_en: str, example_vi: str })),
  notes_for_review: arr(str),
});

/** Keywords the structured-output API does not support (spec §9.2), plus recursion. Used by tests. */
export const FORBIDDEN_SCHEMA_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'maxItems', 'multipleOf', '$ref', '$defs', 'definitions'] as const;

/** Returns "path: keyword" for every unsupported keyword found anywhere in a JSON Schema document. */
export function findForbiddenKeywords(schema: unknown, path = '$'): string[] {
  const found: string[] = [];
  if (Array.isArray(schema)) {
    schema.forEach((item, i) => found.push(...findForbiddenKeywords(item, `${path}[${i}]`)));
  } else if (schema && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if ((FORBIDDEN_SCHEMA_KEYWORDS as readonly string[]).includes(key)) found.push(`${path}: ${key}`);
      if (key === 'minItems' && value !== 0 && value !== 1) found.push(`${path}: minItems ${String(value)}`);
      if (key === 'additionalProperties' && value !== false) found.push(`${path}: additionalProperties must be false`);
      found.push(...findForbiddenKeywords(value, `${path}.${key}`));
    }
  }
  return found;
}
