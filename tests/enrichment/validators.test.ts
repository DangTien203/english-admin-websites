import { DraftSchema } from '../../services/enrichment/haiku/schema';
import { validateDraft, zodIssuesToValidation, type ValidationContext } from '../../services/enrichment/haiku/validators';
import { makeDraft, makeSense } from './fixtures';

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({ word: 'bank', expectedLemma: 'bank', ...over });
const sense = makeSense;
const withSense = (over: Parameters<typeof makeSense>[0]) => makeDraft({ senses: [makeSense(over)] });
const codes = (r: ReturnType<typeof validateDraft>) => r.issues.map((i) => `${i.path}:${i.code}`);

describe('a clean draft', () => {
  it('passes with no issue and no automatic note', () => {
    const r = validateDraft(makeDraft(), ctx());
    expect(r.issues).toEqual([]);
    expect(r.draft.notes_for_review).toEqual([]);
  });
});

describe('meanings_vi (spec §9.7)', () => {
  it.each([
    ['one short meaning', ['ngân hàng'], []],
    ['four different meanings', ['mạnh', 'khỏe', 'vững chắc', 'cứng cáp'], []],
    ['exactly 40 characters, 6 syllables', ['a'.repeat(40)], []],
    ['6 syllables', ['một hai ba bốn năm sáu'], []],
  ])('accepts %s', (_n, meanings, expected) => {
    expect(codes(validateDraft(withSense({ meanings_vi: meanings }), ctx()))).toEqual(expected);
  });

  it.each([
    ['an empty meaning', ['ngân hàng', ' '], 'senses[0].meanings_vi[1]:empty'],
    ['41 characters', ['a'.repeat(41)], 'senses[0].meanings_vi[0]:too_long'],
    ['7 syllables', ['một hai ba bốn năm sáu bảy'], 'senses[0].meanings_vi[0]:too_many_syllables'],
    ['parentheses', ['ngân hàng (tổ chức)'], 'senses[0].meanings_vi[0]:parenthesis'],
    ['full-width parentheses', ['ngân hàng（tổ chức）'], 'senses[0].meanings_vi[0]:parenthesis'],
    ['a Chinese character', ['银行 ngân hàng'], 'senses[0].meanings_vi[0]:cjk'],
    ['a Korean character', ['은행'], 'senses[0].meanings_vi[0]:cjk'],
    ['a Japanese character', ['ぎんこう'], 'senses[0].meanings_vi[0]:cjk'],
    ['a duplicate after case and whitespace normalization', ['Ngân  hàng', 'ngân hàng'], 'senses[0].meanings_vi[1]:duplicate'],
  ])('rejects %s', (_n, meanings, expected) => {
    expect(codes(validateDraft(withSense({ meanings_vi: meanings }), ctx()))).toContain(expected);
  });

  it.each([
    ['con mèo', 'mèo'],
    ['mèo', 'con mèo'],
    ['sự vui vẻ', 'vui vẻ'],
    ['cái bàn', 'Bàn'],
    ['cuộc họp', 'họp'],
    ['một tập podcast', 'tập podcast'],
    ['các vị khách', 'vị khách'],
  ])('rejects two meanings that differ only by a classifier: %j and %j', (a, b) => {
    expect(codes(validateDraft(withSense({ meanings_vi: [a, b] }), ctx()))).toContain('senses[0].meanings_vi[1]:classifier_duplicate');
  });

  it('keeps meanings that merely share a word (not classifier-only differences)', () => {
    const r = validateDraft(withSense({ meanings_vi: ['đi bộ', 'đi', 'bộ đội'] }), ctx());
    expect(r.issues).toEqual([]);
  });

  it('a classifier on its own is not stripped to nothing', () => {
    expect(codes(validateDraft(withSense({ meanings_vi: ['con', 'mèo'] }), ctx()))).toEqual([]);
  });

  it('strips trailing punctuation and extra spaces instead of failing', () => {
    const r = validateDraft(withSense({ meanings_vi: ['  ngân  hàng. ', 'nhà băng;'] }), ctx());
    expect(r.issues).toEqual([]);
    expect(r.draft.senses[0].meanings_vi).toEqual(['ngân hàng', 'nhà băng']);
  });

  it('rejects a sense whose meanings ALL equal the English word', () => {
    const r = validateDraft(withSense({ meanings_vi: ['bank'] }), ctx());
    expect(codes(r)).toContain('senses[0].meanings_vi:same_as_english');
    const two = validateDraft(withSense({ meanings_vi: ['Bank', 'bank'] }), ctx());
    expect(codes(two)).toContain('senses[0].meanings_vi:same_as_english');
  });

  it('allows a loanword that keeps one identical meaning next to another (karaoke)', () => {
    const r = validateDraft(makeDraft({ headword: 'karaoke', lemma: 'karaoke', senses: [sense({ meanings_vi: ['karaoke', 'hát theo nhạc nền'] })] }), ctx({ word: 'karaoke', expectedLemma: 'karaoke' }));
    expect(r.issues).toEqual([]);
  });

  it('reports the path of the offending sense and meaning', () => {
    const d = makeDraft({ senses: [sense(), sense({ meanings_vi: ['tốt', 'tốt (ổn)', 'ổn'] })] });
    expect(codes(validateDraft(d, ctx()))).toEqual(['senses[1].meanings_vi[1]:parenthesis']);
  });
});

describe('definition_en and examples', () => {
  it('accepts 25 words, rejects 26', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    expect(validateDraft(withSense({ definition_en: words(25) }), ctx()).issues).toEqual([]);
    expect(codes(validateDraft(withSense({ definition_en: words(26) }), ctx()))).toEqual(['senses[0].definition_en:too_long']);
  });

  it('rejects an empty definition_en', () => {
    expect(codes(validateDraft(withSense({ definition_en: '  ' }), ctx()))).toContain('senses[0].definition_en:empty');
  });

  it('notes (does not reject) a definition that uses the defined word itself', () => {
    const r = validateDraft(withSense({ definition_en: 'a place where a bank keeps money' }), ctx());
    expect(r.issues).toEqual([]);
    expect(r.draft.notes_for_review.join(' ')).toMatch(/dùng lại chính từ/);
  });

  it('rejects example_vi identical to example_en (any case), an empty example_vi, and CJK', () => {
    const base = { example_en: 'I went to the bank.', example_vi: 'Tôi đã đến ngân hàng.' };
    const bad = (e: Partial<typeof base>) => codes(validateDraft(withSense({ examples: [{ ...base, ...e }] }), ctx()));
    expect(bad({})).toEqual([]);
    expect(bad({ example_vi: 'i went to the BANK.' })).toContain('senses[0].examples[0].example_vi:same_as_english');
    expect(bad({ example_vi: '' })).toContain('senses[0].examples[0].example_vi:empty');
    expect(bad({ example_vi: 'Tôi đến 银行.' })).toContain('senses[0].examples[0].example_vi:cjk');
    expect(bad({ example_en: '' })).toContain('senses[0].examples[0].example_en:empty');
  });

  it('rejects Chinese, Korean or Japanese characters in the Vietnamese notes', () => {
    expect(codes(validateDraft(withSense({ usage_note: 'dùng ở 日本' }), ctx()))).toContain('senses[0].usage_note:cjk');
  });
});

describe('identity: headword, lemma, expected lemma', () => {
  it('accepts a display-case headword with a lowercase lemma (April / april, AIDS / aids)', () => {
    const r = validateDraft(makeDraft({ headword: 'April', lemma: 'april' }), ctx({ word: 'april', expectedLemma: 'april' }));
    expect(r.issues).toEqual([]);
  });

  it('lowercases the lemma', () => {
    expect(validateDraft(makeDraft({ lemma: 'Bank' }), ctx()).draft.lemma).toBe('bank');
  });

  it('rejects a headword that is not the display form of the lemma', () => {
    expect(codes(validateDraft(makeDraft({ headword: 'banks', lemma: 'bank' }), ctx()))).toContain('headword:headword_lemma');
  });

  it('rejects a lemma that is not a single word', () => {
    expect(codes(validateDraft(makeDraft({ headword: 'ice cream', lemma: 'ice cream' }), ctx({ word: 'ice cream', expectedLemma: null })))).toContain('lemma:format');
  });

  it('requires the lemma named by the sources, case-insensitively (ran → run)', () => {
    const run = makeDraft({ headword: 'run', lemma: 'run' });
    expect(validateDraft(run, ctx({ word: 'ran', expectedLemma: 'run' })).issues).toEqual([]);
    expect(validateDraft(makeDraft({ headword: 'Run', lemma: 'RUN' }), ctx({ word: 'ran', expectedLemma: 'Run' })).issues).toEqual([]);
    expect(codes(validateDraft(makeDraft({ headword: 'ran', lemma: 'ran' }), ctx({ word: 'ran', expectedLemma: 'run' })))).toContain('lemma:lemma_mismatch');
  });

  it('does not constrain the lemma when the sources name none', () => {
    expect(validateDraft(makeDraft({ headword: 'podcast', lemma: 'podcast' }), ctx({ word: 'podcast', expectedLemma: null })).issues).toEqual([]);
  });
});

describe('topics', () => {
  it('drops unknown names (never replaced by academic_formal) and notes it', () => {
    const r = validateDraft(makeDraft({ topics: ['IELTS', 'food_drink', 'Beginner'] }), ctx());
    expect(r.draft.topics).toEqual(['food_drink']);
    expect(r.draft.notes_for_review.join(' ')).toContain('"IELTS"');
    expect(r.issues).toEqual([]);
  });

  it('leaves the list EMPTY when nothing valid is left, with a note, and no academic_formal', () => {
    const r = validateDraft(makeDraft({ topics: ['IELTS'] }), ctx());
    expect(r.draft.topics).toEqual([]);
    expect(r.draft.topics).not.toContain('academic_formal');
    expect(r.draft.notes_for_review.join(' ')).toMatch(/topics rỗng/);
    expect(r.issues).toEqual([]);
  });

  it.each([
    ['next to another topic', ['character_values', 'academic_formal'], 'C1'],
    ['at a level below C1', ['academic_formal'], 'B1'],
    ['at B2', ['academic_formal'], 'B2'],
  ])('drops academic_formal %s', (_n, topics, cefr) => {
    const r = validateDraft(makeDraft({ topics, cefr_level: cefr as any }), ctx());
    expect(r.draft.topics).not.toContain('academic_formal');
    expect(r.draft.notes_for_review.join(' ')).toMatch(/bỏ academic_formal/);
  });

  it.each(['C1', 'C2'])('keeps academic_formal as the only topic of a %s word', (cefr) => {
    const r = validateDraft(makeDraft({ topics: ['academic_formal'], cefr_level: cefr as any }), ctx());
    expect(r.draft.topics).toEqual(['academic_formal']);
  });

  it('deduplicates and keeps at most 3', () => {
    const r = validateDraft(makeDraft({ topics: ['food_drink', 'food_drink', 'home_household', 'weather_climate', 'work_career'] }), ctx());
    expect(r.draft.topics).toEqual(['food_drink', 'home_household', 'weather_climate']);
  });
});

describe('sense and entry structure', () => {
  it('requires a cefr level and at least one sense for a real word', () => {
    expect(codes(validateDraft(makeDraft({ cefr_level: null }), ctx()))).toContain('cefr_level:missing');
    expect(codes(validateDraft(makeDraft({ senses: [] }), ctx()))).toContain('senses:empty');
  });

  it('lowercases, deduplicates and cuts synonyms / antonyms to 8, and removes the word itself', () => {
    const syn = ['Lender', 'lender', 'BANK', ...Array.from({ length: 10 }, (_, i) => `s${i}`)];
    const r = validateDraft(withSense({ synonyms: syn, antonyms: ['Borrower'] }), ctx());
    expect(r.draft.senses[0].synonyms).toEqual(['lender', 's0', 's1', 's2', 's3', 's4', 's5', 's6']);
    expect(r.draft.senses[0].antonyms).toEqual(['borrower']);
  });

  it('derives pos from the senses, in order of appearance', () => {
    const r = validateDraft(makeDraft({ pos: ['verb'], senses: [sense({ pos: 'noun' }), sense({ pos: 'verb' }), sense({ pos: 'noun' })] }), ctx());
    expect(r.draft.pos).toEqual(['noun', 'verb']);
  });

  it('clears is_countable without a noun sense and is_transitive without a verb sense', () => {
    const adj = validateDraft(makeDraft({ is_countable: true, is_transitive: true, senses: [sense({ pos: 'adjective' })] }), ctx());
    expect(adj.draft.is_countable).toBeNull();
    expect(adj.draft.is_transitive).toBeNull();
    const verb = validateDraft(makeDraft({ is_countable: true, is_transitive: true, senses: [sense({ pos: 'noun' }), sense({ pos: 'verb' })] }), ctx());
    expect(verb.draft.is_countable).toBe(true);
    expect(verb.draft.is_transitive).toBe(true);
  });

  it('trims domain / region to the column sizes', () => {
    const r = validateDraft(withSense({ domain: 'D'.repeat(150), region: 'R'.repeat(50) }), ctx());
    expect(r.draft.senses[0].domain).toHaveLength(100);
    expect(r.draft.senses[0].region).toHaveLength(30);
  });
});

describe('words that are not entries (not English, proper noun, variant)', () => {
  const rejected = (over: Parameters<typeof makeDraft>[0]) => makeDraft({ headword: 'london', lemma: 'london', pos: [], cefr_level: null, is_countable: null, topics: [], senses: [], ...over });

  it.each([
    ['a proper noun', rejected({ is_proper_noun: true })],
    ['not an English word', rejected({ is_english_word: false })],
    ['a misspelling', rejected({ variant_of: 'receive', headword: 'recieve', lemma: 'recieve' })],
  ])('accepts %s with no senses and no cefr level', (_n, draft) => {
    expect(validateDraft(draft, ctx({ word: 'london', expectedLemma: 'run' })).issues).toEqual([]);
  });

  it('lowercases variant_of and ignores an empty string', () => {
    expect(validateDraft(rejected({ variant_of: ' Receive ' }), ctx()).draft.variant_of).toBe('receive');
    const blank = validateDraft(makeDraft({ variant_of: '   ' }), ctx());
    expect(blank.draft.variant_of).toBeNull();
  });
});

describe('idioms, phrasal verbs, collocations (optional extras are dropped, not repaired)', () => {
  const idiom = { idiom_text: 'break the bank', definition_en: 'to cost too much', definition_vi: 'tốn quá nhiều tiền', example_en: 'A holiday will not break the bank.', example_vi: 'Một kỳ nghỉ sẽ không tốn kém quá mức.' };

  it('keeps good items and drops bad ones with a note', () => {
    const r = validateDraft(makeDraft({ idioms: [idiom, { ...idiom, idiom_text: '' }, { ...idiom, definition_vi: '花钱' }] }), ctx());
    expect(r.draft.idioms).toEqual([idiom]);
    expect(r.issues).toEqual([]);
    expect(r.draft.notes_for_review.filter((n) => n.includes('thành ngữ'))).toHaveLength(2);
  });

  it('keeps at most 5 of each kind', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...idiom, idiom_text: `idiom ${i}` }));
    expect(validateDraft(makeDraft({ idioms: many }), ctx()).draft.idioms).toHaveLength(5);
  });

  it('a phrasal verb must start with the verb and have a particle', () => {
    const pv = { phrasal_verb: 'run out', particle: 'out', is_separable: false, definition_en: 'to finish', definition_vi: 'cạn kiệt', example_en: 'We ran out of milk.', example_vi: 'Chúng tôi hết sữa.' };
    const d = makeDraft({ headword: 'run', lemma: 'run', phrasal_verbs: [pv, { ...pv, phrasal_verb: 'give up' }, { ...pv, particle: '' }] });
    const r = validateDraft(d, ctx({ word: 'run', expectedLemma: 'run' }));
    expect(r.draft.phrasal_verbs.map((p) => p.phrasal_verb)).toEqual(['run out']);
  });

  it('trims collocation pattern to 50 characters', () => {
    const col = { collocation: 'bank account', pattern: 'p'.repeat(80), example_en: 'x', example_vi: 'y' };
    expect(validateDraft(makeDraft({ collocations: [col] }), ctx()).draft.collocations[0].pattern).toHaveLength(50);
  });
});

describe('zodIssuesToValidation', () => {
  it('turns schema errors into issues with readable paths', () => {
    const bad = JSON.parse(JSON.stringify(makeDraft()));
    bad.senses[0].meanings_vi = ['a', 'b', 'c', 'd', 'e'];
    bad.senses[0].register = 'vulgar';
    const parsed = DraftSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issues = zodIssuesToValidation(parsed.error);
      expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['senses[0].meanings_vi', 'senses[0].register']));
      expect(issues.every((i) => i.code.startsWith('schema_'))).toBe(true);
    }
  });
});
