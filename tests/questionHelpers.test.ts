/**
 * utils/questionHelpers.ts builds the SwiftChoice and Cloze questions for both /practice and /leitner. A question used to cost three or
 * four statements one after the other (distractors, then — when too few — the fallback distractors, then the example); the reads that do
 * not depend on each other are now issued together, and the two distractor queries are ONE statement. The pool is a fake that records
 * what is asked and when.
 */
const mockQuery = jest.fn();
jest.mock('../config/db', () => ({ query: (...args: any[]) => mockQuery(...args) }));

import { InsufficientDistractorsError, NoExamplesError, buildClozeQuestion, buildSwiftChoiceQuestion } from '../utils/questionHelpers';

const entry = { entry_id: 'e1', headword: 'run', ipa_us: '/rʌn/', pos: ['verb'], cefr_level: 'A1', correct_vi: 'chạy' };

interface Fakes {
  distractors?: Array<{ display_vi: string | null }>;
  example?: string | null;
  forms?: Array<{ form_value: string; form_type: string }>;
  examples?: Array<{ example_en: string }>;
  wrong?: Array<{ headword: string }>;
}

function fake(f: Fakes) {
  mockQuery.mockReset().mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (/WITH preferred AS/.test(text)) return { rows: f.distractors ?? [] };
    if (/SELECT example_en FROM \(/.test(text)) return { rows: f.examples ?? [] }; // the cloze examples (a UNION that also mentions se.example_en)
    if (/SELECT se.example_en/.test(text)) return { rows: f.example ? [{ example_en: f.example }] : [] };
    if (/FROM word_forms/.test(text)) return { rows: f.forms ?? [] };
    if (/SELECT de.headword FROM dictionary_entries/.test(text)) return { rows: f.wrong ?? [] };
    throw new Error(`unexpected statement: ${text}`);
  });
}

describe('buildSwiftChoiceQuestion', () => {
  it('asks the distractors (one statement) and the hint example together, and shapes the question', async () => {
    fake({ distractors: [{ display_vi: 'đi' }, { display_vi: 'ăn' }, { display_vi: 'ngủ' }], example: 'I run every morning.' });
    const pending = buildSwiftChoiceQuestion(entry);
    expect(mockQuery).toHaveBeenCalledTimes(2); // both issued before anything has been awaited
    const q = await pending;

    expect(q.question_type).toBe('meaning_from_word');
    expect(q.prompt).toEqual({ word: 'run', ipa_us: '/rʌn/', pos: 'verb' });
    expect(q.hint_example).toBe('e.g., I ___ every morning.');
    expect(q.options).toHaveLength(4);
    expect(q.options.map((o) => o.text).sort()).toEqual(['ngủ', 'chạy', 'đi', 'ăn'].sort());
    expect(q.options[q.correct_index].text).toBe('chạy');
  });

  it('sends the level, the entry and the parts of speech to the one distractor statement', async () => {
    fake({ distractors: [{ display_vi: 'a' }, { display_vi: 'b' }, { display_vi: 'c' }] });
    await buildSwiftChoiceQuestion(entry);
    const call = mockQuery.mock.calls.find(([sql]) => /WITH preferred AS/.test(String(sql)))!;
    expect(call[1]).toEqual(['A1', 'e1', ['verb']]);
    expect(String(call[0])).toMatch(/UNION ALL/); // preferred set, then the fallback set only when the preferred one is short
  });

  it('a word without a part of speech is matched on level alone', async () => {
    fake({ distractors: [{ display_vi: 'a' }, { display_vi: 'b' }, { display_vi: 'c' }] });
    const q = await buildSwiftChoiceQuestion({ ...entry, pos: null });
    expect(mockQuery.mock.calls.find(([sql]) => /WITH preferred AS/.test(String(sql)))![1]).toEqual(['A1', 'e1']);
    expect(q.prompt.pos).toBeNull();
    expect(q.hint_example).toBeNull();
  });

  it('refuses with InsufficientDistractorsError when fewer than three come back', async () => {
    fake({ distractors: [{ display_vi: 'a' }, { display_vi: 'b' }] });
    await expect(buildSwiftChoiceQuestion(entry)).rejects.toBeInstanceOf(InsufficientDistractorsError);
  });
});

describe('buildClozeQuestion', () => {
  const sentence = [{ example_en: 'They were running late.' }, { example_en: 'I run daily.' }];
  const forms = [{ form_value: 'running', form_type: 'present_participle' }];

  it('level 1: the word forms, the examples and the wrong words are read together', async () => {
    fake({ forms, examples: sentence, wrong: [{ headword: 'walk' }, { headword: 'jump' }, { headword: 'swim' }] });
    const pending = buildClozeQuestion({ entry_id: 'e1', headword: 'run', pos: ['verb'] }, 1);
    expect(mockQuery).toHaveBeenCalledTimes(3);
    const q = await pending;

    expect(q.level).toBe(1);
    expect(['running', 'run']).toContain(q.target_word);
    expect(q.sentence_masked).toContain('___');
    expect(q.sentence_full).not.toContain('___');
    expect(q.word_choices).toHaveLength(4);
    expect(q.word_choices).toEqual(expect.arrayContaining([q.target_word, 'walk', 'jump', 'swim']));
    expect(q.scrambled_letters).toBeNull();
  });

  it('level 2: no wrong words are read; the letters are scrambled instead', async () => {
    fake({ forms, examples: sentence });
    const q = await buildClozeQuestion({ entry_id: 'e1', headword: 'run', pos: ['verb'] }, 2);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(q.word_choices).toBeNull();
    expect(q.scrambled_letters!.length).toBeGreaterThan(q.target_word.length);
  });

  it('tells "no examples at all" from "examples that do not contain the word"', async () => {
    fake({ forms: [], examples: [] });
    await expect(buildClozeQuestion({ entry_id: 'e1', headword: 'run', pos: ['verb'] }, 3)).rejects.toMatchObject({ name: 'NoExamplesError', reason: 'none' });

    fake({ forms: [], examples: [{ example_en: 'Nothing here matches.' }] });
    const err = await buildClozeQuestion({ entry_id: 'e1', headword: 'run', pos: ['verb'] }, 3).catch((e) => e);
    expect(err).toBeInstanceOf(NoExamplesError);
    expect(err.reason).toBe('no_match');
  });

  it('level 1 puts the same part of speech first when it asks for the wrong words', async () => {
    fake({ forms: [], examples: sentence, wrong: [{ headword: 'a' }, { headword: 'b' }, { headword: 'c' }] });
    await buildClozeQuestion({ entry_id: 'e1', headword: 'run', pos: ['verb'] }, 1);
    const call = mockQuery.mock.calls.find(([sql]) => /SELECT de.headword FROM dictionary_entries/.test(String(sql)))!;
    expect(call[1]).toEqual(['e1', 'verb']);
    expect(String(call[0])).toContain('CASE WHEN $2 = ANY(de.pos)');
  });
});
