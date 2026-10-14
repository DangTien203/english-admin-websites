import type { Draft, Sense } from '../../services/enrichment/haiku/schema';
import type { SourceBundle, WiktionaryRow } from '../../services/enrichment/types';

/** A reduced ref_wiktionary_en row, shaped like the real table (docs/lookup-refdata.md §6.2). */
export function wrow(over: {
  id?: number;
  word: string;
  pos: string;
  /** original letter case of data.word; defaults to word */
  written?: string;
  lemma_of?: string | null;
  etymology_number?: number | null;
  senses?: any[];
  head?: string;
  forms?: Array<{ form: string; tags?: string[] }>;
  tags?: string[];
  sounds?: any[];
}): WiktionaryRow {
  return {
    id: over.id ?? 1,
    word: over.word,
    pos: over.pos,
    etymology_number: over.etymology_number ?? null,
    lemma_of: over.lemma_of ?? null,
    data: {
      word: over.written ?? over.word,
      pos: over.pos,
      senses: over.senses ?? [{ glosses: [`gloss of ${over.word}`], tags: [] }],
      ...(over.head ? { head_templates: [{ name: 'head', expansion: over.head }] } : {}),
      ...(over.forms ? { forms: over.forms } : {}),
      ...(over.tags ? { tags: over.tags } : {}),
      ...(over.sounds ? { sounds: over.sounds } : {}),
    },
  };
}

export function makeSense(over: Partial<Sense> = {}): Sense {
  return {
    pos: 'noun',
    definition_en: 'a financial institution that keeps money for customers',
    meanings_vi: ['ngân hàng', 'nhà băng'],
    register: null,
    domain: null,
    region: null,
    grammar_note: null,
    usage_note: null,
    examples: [{ example_en: 'She opened an account at the bank last week.', example_vi: 'Tuần trước cô ấy đã mở một tài khoản ở ngân hàng.' }],
    synonyms: [],
    antonyms: [],
    ...over,
  };
}

export function makeDraft(over: Partial<Draft> = {}): Draft {
  return {
    is_english_word: true,
    is_proper_noun: false,
    variant_of: null,
    headword: 'bank',
    lemma: 'bank',
    pos: ['noun'],
    cefr_level: 'A2',
    is_countable: true,
    is_transitive: null,
    topics: ['business_economy'],
    senses: [makeSense()],
    idioms: [],
    phrasal_verbs: [],
    collocations: [],
    notes_for_review: [],
    ...over,
  };
}

export function makeBundle(over: Partial<SourceBundle> = {}): SourceBundle {
  return {
    word: 'bank',
    expectedLemma: 'bank',
    formLemmas: [],
    variantTargets: [],
    wiktionaryRows: [wrow({ word: 'bank', pos: 'noun', senses: [{ glosses: ['A financial institution.'], tags: ['countable'] }] })],
    lemmaRows: [],
    freeDictionary: { status: 'skipped' },
    frequency: { zipf: 5.16, rank: 705 },
    datamuse: { synonyms: ['depository'], antonyms: [] },
    flags: { onlyFormRows: false, onlyVariantRows: false, onlyProperNounRows: false, noSourceRecognizesWord: false },
    strayRows: 0,
    sourceErrors: {},
    timingsMs: {},
    ...over,
  };
}
