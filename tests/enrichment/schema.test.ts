import { z } from 'zod';
import {
  CEFR_LEVELS,
  DRAFT_JSON_SCHEMA,
  DraftSchema,
  FORBIDDEN_SCHEMA_KEYWORDS,
  POS_VALUES,
  REGISTER_VALUES,
  findForbiddenKeywords,
} from '../../services/enrichment/haiku/schema';
import { TOPIC_NAMES } from '../../services/enrichment/topics';
import { makeDraft } from './fixtures';

/** All object paths with their sorted property names, for a zod schema. */
function zodShapes(schema: z.ZodType, path = '$'): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const def: any = (schema as any)._zod?.def ?? (schema as any).def;
  if (def.type === 'object') {
    out[path] = Object.keys(def.shape).sort();
    for (const [key, child] of Object.entries<any>(def.shape)) Object.assign(out, zodShapes(child, `${path}.${key}`));
  } else if (def.type === 'array') {
    Object.assign(out, zodShapes(def.element, `${path}[]`));
  } else if (def.type === 'nullable' || def.type === 'optional') {
    Object.assign(out, zodShapes(def.innerType, path));
  }
  return out;
}

/** The same walk over the JSON Schema. */
function jsonShapes(schema: any, path = '$'): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (schema?.type === 'object') {
    out[path] = Object.keys(schema.properties).sort();
    for (const [key, child] of Object.entries<any>(schema.properties)) Object.assign(out, jsonShapes(child, `${path}.${key}`));
  } else if (schema?.type === 'array') {
    Object.assign(out, jsonShapes(schema.items, `${path}[]`));
  }
  return out;
}

describe('JSON Schema and zod describe the same shape', () => {
  it('list the same property names at every object level', () => {
    expect(jsonShapes(DRAFT_JSON_SCHEMA)).toEqual(zodShapes(DraftSchema));
  });

  it('cover all the expected levels (root, sense, example, idiom, phrasal verb, collocation)', () => {
    expect(Object.keys(jsonShapes(DRAFT_JSON_SCHEMA)).sort()).toEqual(
      ['$', '$.senses[]', '$.senses[].examples[]', '$.idioms[]', '$.phrasal_verbs[]', '$.collocations[]'].sort()
    );
  });

  it('final root keys', () => {
    expect(jsonShapes(DRAFT_JSON_SCHEMA)['$']).toEqual(
      [
        'is_english_word', 'is_proper_noun', 'variant_of', 'headword', 'lemma', 'pos', 'cefr_level', 'is_countable',
        'is_transitive', 'topics', 'senses', 'idioms', 'phrasal_verbs', 'collocations', 'notes_for_review',
      ].sort()
    );
  });

  it('marks every property required (no optional parameters) and forbids extra properties, at every level', () => {
    const check = (node: any) => {
      if (node?.type === 'object') {
        expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
        expect(node.additionalProperties).toBe(false);
        Object.values<any>(node.properties).forEach(check);
      } else if (node?.type === 'array') check(node.items);
    };
    check(DRAFT_JSON_SCHEMA);
  });

  it('enum values equal the shared constants (and the 30 topics)', () => {
    const props: any = (DRAFT_JSON_SCHEMA as any).properties;
    expect(props.pos.items.enum).toEqual([...POS_VALUES]);
    expect(props.topics.items.enum).toEqual([...TOPIC_NAMES]);
    expect(props.topics.items.enum).toHaveLength(30);
    expect(props.cefr_level.enum).toEqual([...CEFR_LEVELS, null]);
    expect(props.senses.items.properties.register.enum).toEqual([...REGISTER_VALUES, null]);
    expect(props.senses.items.properties.pos.enum).toEqual([...POS_VALUES]);
  });

  it('uses no keyword the structured-output API does not support (spec §9.2)', () => {
    expect(findForbiddenKeywords(DRAFT_JSON_SCHEMA)).toEqual([]);
    // sanity: the detector itself works
    expect(findForbiddenKeywords({ type: 'string', maxLength: 3 })).toEqual(['$: maxLength']);
    expect(findForbiddenKeywords({ type: 'array', minItems: 2 })).toEqual(['$: minItems 2']);
    expect(findForbiddenKeywords({ type: 'object', additionalProperties: true })).toEqual(['$: additionalProperties must be false']);
    expect(FORBIDDEN_SCHEMA_KEYWORDS).toEqual(expect.arrayContaining(['minimum', 'maximum', 'minLength', 'maxLength']));
  });

  it('keeps the number of union-typed parameters within the documented limit of 16', () => {
    let unions = 0;
    const walk = (node: any) => {
      if (Array.isArray(node?.type) || (node?.enum && node.enum.includes(null))) unions++;
      if (node?.properties) Object.values(node.properties).forEach(walk);
      if (node?.items) walk(node.items);
    };
    walk(DRAFT_JSON_SCHEMA);
    expect(unions).toBeLessThanOrEqual(16);
  });

  it('serializes to plain JSON (no undefined, no functions)', () => {
    expect(JSON.parse(JSON.stringify(DRAFT_JSON_SCHEMA))).toEqual(DRAFT_JSON_SCHEMA);
  });
});

describe('DraftSchema (zod)', () => {
  it('accepts a complete draft', () => {
    expect(DraftSchema.safeParse(makeDraft()).success).toBe(true);
  });

  it('accepts the minimal "rejected word" shape', () => {
    const rejected = makeDraft({
      is_proper_noun: true, headword: 'london', lemma: 'london', pos: [], cefr_level: null, is_countable: null, topics: [], senses: [], notes_for_review: ['tên riêng'],
    });
    expect(DraftSchema.safeParse(rejected).success).toBe(true);
  });

  it.each([
    ['an unknown key', { ...makeDraft(), extra: 1 }],
    ['a missing key', (() => { const d: any = makeDraft(); delete d.lemma; return d; })()],
    ['a pos outside the enum', makeDraft({ pos: ['interjection' as any] })],
    ['a cefr level outside the enum', makeDraft({ cefr_level: 'D1' as any })],
    ['more than 6 senses', makeDraft({ senses: Array(7).fill(makeDraft().senses[0]) })],
    ['more than 4 meanings', makeDraft({ senses: [{ ...makeDraft().senses[0], meanings_vi: ['a', 'b', 'c', 'd', 'e'] }] })],
    ['zero meanings', makeDraft({ senses: [{ ...makeDraft().senses[0], meanings_vi: [] }] })],
    ['zero examples', makeDraft({ senses: [{ ...makeDraft().senses[0], examples: [] }] })],
    ['more than 2 examples', makeDraft({ senses: [{ ...makeDraft().senses[0], examples: Array(3).fill(makeDraft().senses[0].examples[0]) }] })],
    ['a register outside the DB check', makeDraft({ senses: [{ ...makeDraft().senses[0], register: 'vulgar' as any }] })],
  ])('rejects %s', (_label, draft) => {
    expect(DraftSchema.safeParse(draft).success).toBe(false);
  });

  it('allows null for the nullable fields', () => {
    const d = makeDraft({ variant_of: null, is_countable: null, is_transitive: null, cefr_level: null });
    expect(DraftSchema.safeParse(d).success).toBe(true);
  });
});
