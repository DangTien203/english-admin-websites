import {
  alignSense,
  assembleEntry,
  buildMeaningVi,
  wiktionaryFormType,
  cleanEtymology,
  cleanFreeDictionaryIpa,
  cleanIpa,
  COLUMN_LIMITS,
  countRows,
  cut,
  glossOverlap,
  mergeRelated,
  type AssembleContext,
  type AssembledEntry,
} from '../../services/enrichment/assemble';
import type { Draft } from '../../services/enrichment/haiku/schema';
import type { SourceBundle } from '../../services/enrichment/types';
import { makeBundle, makeDraft, makeSense, wrow } from './fixtures';

const TOPICS = new Map<string, string>([
  ['business_economy', 'tag-business'],
  ['education_school', 'tag-education'],
  ['food_drink', 'tag-food'],
  ['health_medicine', 'tag-health'],
  ['time_calendar', 'tag-time'],
]);

const ctx = (over: Partial<AssembleContext> = {}): AssembleContext => ({ jobId: 'job-1', model: 'test-model', publishPolicy: 'review', topicIds: TOPICS, ...over });

function entryOf(bundle: SourceBundle, draft: Draft, c: AssembleContext = ctx()): AssembledEntry {
  const r = assembleEntry(bundle, draft, c);
  if (r.status !== 'ok') throw new Error(`expected an entry, got ${JSON.stringify(r)}`);
  return r.entry;
}

const sense = (meanings: string[], over: Parameters<typeof makeSense>[0] = {}) => makeSense({ meanings_vi: meanings, ...over });

describe('assembleEntry — basics', () => {
  it('builds the entry fields, with sense_order from 0 and definition_vi = the meanings joined by "; "', () => {
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['ngân hàng', 'nhà băng', 'quỹ'])] }));
    expect(e).toMatchObject({
      headword: 'bank',
      lemma: 'bank',
      pos: ['noun'],
      meaningVi: 'ngân hàng; nhà băng; quỹ',
      meaningEn: 'a financial institution that keeps money for customers',
      exampleEn: 'She opened an account at the bank last week.',
      exampleVi: 'Tuần trước cô ấy đã mở một tài khoản ở ngân hàng.',
      cefrLevel: 'A2',
      frequencyRank: 705,
      source: 'wiktionary',
      tagIds: ['tag-business'],
    });
    expect(e.senses[0]).toMatchObject({ senseOrder: 0, pos: 'noun', definitionVi: 'ngân hàng; nhà băng; quỹ' });
  });

  it('definition_vi keeps at most 4 meanings', () => {
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['a1', 'b2', 'c3', 'd4', 'e5'])] }));
    expect(e.senses[0].definitionVi).toBe('a1; b2; c3; d4');
  });

  it('several senses: sense_order is one running number, so two senses of the same part of speech never collide', () => {
    const e = entryOf(
      makeBundle(),
      makeDraft({ senses: [sense(['ngân hàng'], { pos: 'noun' }), sense(['bờ sông'], { pos: 'noun' }), sense(['nghiêng'], { pos: 'verb' })] })
    );
    expect(e.senses.map((s) => [s.pos, s.senseOrder])).toEqual([['noun', 0], ['noun', 1], ['verb', 2]]);
    expect(e.pos).toEqual(['noun', 'verb']);
  });

  it('pos[] follows the senses (in order, no duplicates)', () => {
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['a'], { pos: 'verb' }), sense(['b'], { pos: 'noun' }), sense(['c'], { pos: 'verb' }), sense(['d'], { pos: 'adjective' })] }));
    expect(e.pos).toEqual(['verb', 'noun', 'adjective']);
  });

  it('examples are kept per sense and the entry takes the first example of the first sense', () => {
    const e = entryOf(
      makeBundle(),
      makeDraft({
        senses: [
          sense(['a'], { examples: [{ example_en: 'One.', example_vi: 'Một.' }, { example_en: 'Two.', example_vi: 'Hai.' }] }),
          sense(['b'], { examples: [{ example_en: 'Three.', example_vi: 'Ba.' }] }),
        ],
      })
    );
    expect(e.senses.map((s) => s.examples.map((x) => x.exampleEn))).toEqual([['One.', 'Two.'], ['Three.']]);
    expect([e.exampleEn, e.exampleVi]).toEqual(['One.', 'Một.']);
    expect(countRows(e)).toMatchObject({ entry_senses: 2, sense_examples: 3, dictionary_entries: 1, entry_edit_history: 1 });
  });

  it('an example repeated inside one sense is written once', () => {
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['a'], { examples: [{ example_en: 'Same.', example_vi: 'Giống.' }, { example_en: 'same.', example_vi: 'Giống 2.' }] })] }));
    expect(e.senses[0].examples).toHaveLength(1);
  });

  it('frequency_rank is NULL when the word is not in the frequency list', () => {
    expect(entryOf(makeBundle({ frequency: null }), makeDraft()).frequencyRank).toBeNull();
  });

  it('register outside the 7 values of the CHECK becomes NULL (the constraint is not touched)', () => {
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['a'], { register: 'formal' }), sense(['b'], { register: 'vulgar' as any }), sense(['c'], { register: null })] }));
    expect(e.senses.map((s) => s.register)).toEqual(['formal', null, null]);
    expect(e.register).toBe('formal');
  });
});

describe('meaning_vi — round robin (spec §9.8)', () => {
  it('one sense with 3 meanings gives 3 meanings', () => {
    expect(buildMeaningVi([['a', 'b', 'c']])).toEqual(['a', 'b', 'c']);
  });

  it('3 senses: the first meaning of every sense first, then the second of every sense', () => {
    expect(buildMeaningVi([['a1', 'a2', 'a3'], ['b1', 'b2'], ['c1']])).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
  });

  it('stops at 6 meanings', () => {
    expect(buildMeaningVi([['a1', 'a2', 'a3', 'a4'], ['b1', 'b2', 'b3', 'b4'], ['c1', 'c2', 'c3', 'c4']])).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'c2']);
  });

  it('stops before the meaning that would pass 200 characters ("; " counts)', () => {
    const m = (c: string) => c.repeat(40);
    const parts = buildMeaningVi([[m('a'), m('b'), m('c'), m('d'), m('e')]]);
    expect(parts).toHaveLength(4); // 4 × 40 + 3 × 2 = 166; a fifth would make 208
    expect(parts.join('; ').length).toBeLessThanOrEqual(200);
  });

  it('exactly 200 characters is allowed', () => {
    // 4 meanings of 47 + 3 separators of 2 = 194; one more of 4 chars + separator = 200
    const parts = buildMeaningVi([['a'.repeat(47), 'b'.repeat(47), 'c'.repeat(47), 'd'.repeat(47), 'eeee']]);
    expect(parts.join('; ')).toHaveLength(200);
    expect(parts).toHaveLength(5);
  });

  it('skips a meaning repeated between senses (letter case and edge punctuation do not make it new)', () => {
    expect(buildMeaningVi([['chạy', 'đi'], ['Chạy.', 'vội']])).toEqual(['chạy', 'đi', 'vội']);
  });

  it('skips empty meanings and ignores blank senses', () => {
    expect(buildMeaningVi([['', '  ', 'a'], []])).toEqual(['a']);
  });

  it('falls back to the first meaning of the first sense when the rule gives nothing, and to nothing when there is nothing', () => {
    expect(buildMeaningVi([['...']])).toEqual(['...']);
    expect(buildMeaningVi([[]])).toEqual([]);
    expect(buildMeaningVi([])).toEqual([]);
  });

  it('assembleEntry cancels the entry (invalid_output) rather than write an empty meaning_vi', () => {
    const r = assembleEntry(makeBundle(), makeDraft({ senses: [sense([' ', ''])] }), ctx());
    expect(r.status).toBe('invalid_output');
    expect(assembleEntry(makeBundle(), makeDraft({ senses: [] }), ctx()).status).toBe('invalid_output');
  });

  it('a word with ONE sense still gets several meanings in the fallback column', () => {
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['may mắn tình cờ', 'sự tình cờ thú vị', 'điều may mắn bất ngờ'])] }));
    expect(e.meaningVi).toBe('may mắn tình cờ; sự tình cờ thú vị; điều may mắn bất ngờ');
  });
});

describe('entry_answer_aliases (spec §10.7)', () => {
  it('are the meanings that did not fit into meaning_vi, once each, with a normalized answer', () => {
    const e = entryOf(
      makeBundle(),
      makeDraft({ senses: [sense(['A1', 'a2', 'a3', 'a4']), sense(['b1', 'b2', 'b3', 'b4']), sense(['c1', 'C2', 'c3', 'c4'])] })
    );
    expect(e.meaningVi).toBe('A1; b1; c1; a2; b2; C2');
    expect(e.aliases.map((a) => a.normalizedAnswer)).toEqual(['a3', 'a4', 'b3', 'b4', 'c3', 'c4']);
  });

  it('are empty when every meaning fits, and never repeat a meaning of meaning_vi', () => {
    expect(entryOf(makeBundle(), makeDraft({ senses: [sense(['x', 'y'])] })).aliases).toEqual([]);
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['a', 'b', 'c', 'd']), sense(['A', 'e', 'f', 'g'])] }));
    expect(e.aliases.map((a) => a.normalizedAnswer)).not.toContain('a');
    expect(new Set(e.aliases.map((a) => a.normalizedAnswer)).size).toBe(e.aliases.length);
  });
});

describe('tiers and publication (spec §3, §10.3)', () => {
  const complete = () =>
    makeBundle({
      wiktionaryRows: [
        wrow({
          word: 'bank',
          pos: 'noun',
          senses: [{ glosses: ['A financial institution.'], tags: ['countable'] }],
          sounds: [{ ipa: '/bæŋk/', tags: ['US'] }],
          tags: [],
        }),
      ],
    });

  it('review policy never publishes', () => {
    const e = entryOf(complete(), makeDraft({ etymologyHint: undefined } as any), ctx({ publishPolicy: 'review' }));
    expect(e.report.tierAMissing).toEqual([]);
    expect(e.published).toBe(false);
    expect(e.adminNote).toContain('chờ duyệt');
  });

  it('auto policy publishes an entry with tier A complete', () => {
    const e = entryOf(complete(), makeDraft(), ctx({ publishPolicy: 'auto' }));
    expect(e.published).toBe(true);
  });

  it('missing IPA (tier B) still publishes and is written to admin_note', () => {
    const e = entryOf(makeBundle(), makeDraft(), ctx({ publishPolicy: 'auto' }));
    expect(e.ipaUs).toBeNull();
    expect(e.ipaUk).toBeNull();
    expect(e.report.tierBMissing).toContain('ipa');
    expect(e.published).toBe(true);
    expect(e.adminNote).toMatch(/thiếu tầng B: [^·]*ipa/);
  });

  it('every tier B field that is missing is listed', () => {
    const e = entryOf(makeBundle({ frequency: null, wiktionaryRows: [] }), makeDraft({ cefr_level: null, is_countable: null, topics: [], senses: [sense(['a'], { pos: 'noun' }), sense(['b'], { pos: 'verb' })], is_transitive: null }), ctx({ publishPolicy: 'auto' }));
    expect(e.report.tierBMissing).toEqual(['ipa', 'cefr_level', 'frequency_rank', 'is_countable', 'is_transitive', 'tag (chủ đề)', 'etymology']);
    expect(e.published).toBe(true);
  });

  it('is_countable / is_transitive are only demanded when there is a noun / verb sense', () => {
    const e = entryOf(makeBundle(), makeDraft({ is_countable: null, senses: [sense(['a'], { pos: 'adjective' })] }));
    expect(e.report.tierBMissing).not.toContain('is_countable');
    expect(e.report.tierBMissing).not.toContain('is_transitive');
  });

  it('a missing example (tier A) means published=false even under the auto policy', () => {
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['a'], { examples: [] })] }), ctx({ publishPolicy: 'auto' }));
    expect(e.report.tierAMissing).toEqual(['ví dụ (example_en và example_vi)']);
    expect(e.published).toBe(false);
    expect(e.exampleEn).toBeNull();
    expect(e.adminNote).toContain('thiếu tầng A');
  });

  it('an example with an empty translation does not count as an example', () => {
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['a'], { examples: [{ example_en: 'Hello.', example_vi: '  ' }] })] }), ctx({ publishPolicy: 'auto' }));
    expect(e.published).toBe(false);
  });

  it('a sense without a definition_en is not a complete sense (tier A)', () => {
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['a'], { definition_en: '' })] }), ctx({ publishPolicy: 'auto' }));
    expect(e.report.tierAMissing.join(' ')).toContain('sense');
    expect(e.published).toBe(false);
  });

  it('admin_note starts with [auto] and names the sources, model, job, estimate and the notes of Haiku', () => {
    const e = entryOf(makeBundle(), makeDraft({ notes_for_review: ['Nghĩa A cần xem lại.', '[kiểm tra] bỏ academic_formal'] }), ctx({ jobId: 'job-xyz', model: 'claude-test' }));
    expect(e.adminNote.startsWith('[auto] ')).toBe(true);
    expect(e.adminNote).toContain('nguồn: wiktionary, ref_word_frequency');
    expect(e.adminNote).toContain('haiku');
    expect(e.adminNote).toContain('model: claude-test');
    expect(e.adminNote).toContain('job: job-xyz');
    expect(e.adminNote).toContain('ước tính: cefr_level=A2');
    expect(e.adminNote).toContain('ghi chú của Haiku: Nghĩa A cần xem lại. | [kiểm tra] bỏ academic_formal');
  });
});

describe('Datamuse is a candidate list only', () => {
  it('a candidate that Haiku did not choose is not written; one it chose is', () => {
    const bundle = makeBundle({ datamuse: { synonyms: ['depository', 'lender'], antonyms: ['borrower'] } });
    const e = entryOf(bundle, makeDraft({ senses: [sense(['a'], { synonyms: ['lender'], antonyms: [] })] }));
    expect(e.senses[0].synonyms).toEqual(['lender']);
    expect(e.senses[0].antonyms).toEqual([]);
    expect(e.entrySynonymLemmas).toEqual(['lender']);
    expect(e.adminNote).toContain('datamuse (chỉ là ứng viên của Haiku)');
  });
});

describe('synonyms and antonyms (spec §8.1)', () => {
  const rows = [
    wrow({
      word: 'bank',
      pos: 'noun',
      senses: [
        { glosses: ['A financial institution that accepts deposits and lends money.'], synonyms: [{ word: 'Lender' }, { word: 'depository' }], antonyms: [{ word: 'borrower' }] },
        { glosses: ['The sloping land beside a river or lake.'], synonyms: [{ word: 'shore' }] },
      ],
    }),
  ];

  it('the list of the aligned Wiktionary sense comes first, then Haiku\'s choice; lowercase, no duplicates, not the headword', () => {
    const e = entryOf(
      makeBundle({ wiktionaryRows: rows }),
      makeDraft({
        senses: [
          sense(['ngân hàng'], { definition_en: 'a financial institution that keeps money and lends it', synonyms: ['Savings Bank', 'lender', 'bank'], antonyms: [] }),
          sense(['bờ sông'], { definition_en: 'the sloping land beside a river', synonyms: ['edge'] }),
        ],
      })
    );
    expect(e.senses[0].synonyms).toEqual(['lender', 'depository', 'savings bank']);
    expect(e.senses[0].antonyms).toEqual(['borrower']);
    expect(e.senses[1].synonyms).toEqual(['shore', 'edge']);
  });

  it('a sense that matches no Wiktionary gloss gets only what Haiku chose (no wrong sense is borrowed)', () => {
    const e = entryOf(makeBundle({ wiktionaryRows: rows }), makeDraft({ senses: [sense(['nghiêng'], { definition_en: 'to tilt an aircraft sideways to turn', synonyms: ['tilt'] })] }));
    expect(e.senses[0].synonyms).toEqual(['tilt']);
  });

  it('at most 8 per sense', () => {
    const many = Array.from({ length: 12 }, (_, i) => `word${String.fromCharCode(97 + i)}`);
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['a'], { synonyms: many })] }));
    expect(e.senses[0].synonyms).toHaveLength(8);
  });

  it('mergeRelated / alignSense / glossOverlap helpers', () => {
    expect(mergeRelated(['A', 'b'], ['B', 'c', ''], new Set(['c']))).toEqual(['a', 'b']);
    expect(glossOverlap('the sloping land beside a river', 'The sloping land beside a river or lake.')).toBeGreaterThan(0.7);
    expect(glossOverlap('', 'anything')).toBe(0);
    expect(alignSense('money in a bank', 'verb', [{ pos: 'noun', gloss: 'money in a bank', synonyms: [], antonyms: [] }])).toBeNull(); // other part of speech
  });
});

describe('IPA and audio (spec §8.1)', () => {
  const sounds = [
    { ipa: '[ɹɛən]', tags: ['US'] }, // narrow transcription: ignored
    { ipa: '/-ˌkæst/', tags: ['US'] }, // partial: ignored
    { ipa: '/ɹæn/', tags: ['General-American'] },
    { ipa: '/ɹæn/', tags: ['Received-Pronunciation'] },
    { ipa: '/ɾan/', tags: ['Scotland'] }, // other accent
    { ipa: '/ɹan/' }, // no tag: unknown accent
    { tags: ['US'], audio: 'en-us-ran.ogg', mp3_url: 'https://upload.wikimedia.org/commons/transcoded/c/c1/En-us-ran.ogg/En-us-ran.ogg.mp3', ogg_url: 'https://upload.wikimedia.org/commons/c/c1/En-us-ran.ogg' },
    { tags: ['Southern-England'], audio: 'LL-Q1860 (eng)-Vealhurl-ran.wav', mp3_url: 'https://upload.wikimedia.org/commons/transcoded/2/2d/LL-Q1860_%28eng%29-Vealhurl-ran.wav.mp3' },
  ];
  const bundle = (s: any[], over: Partial<SourceBundle> = {}) => makeBundle({ wiktionaryRows: [wrow({ word: 'bank', pos: 'noun', sounds: s })], ...over });

  it('takes the first valid IPA of each accent (US and General-American; UK, Received-Pronunciation and Southern-England), keeping the slashes', () => {
    const e = entryOf(bundle(sounds), makeDraft());
    expect(e.ipaUs).toBe('/ɹæn/');
    expect(e.ipaUk).toBe('/ɹæn/');
  });

  it('one sound tagged with both accents serves both', () => {
    const e = entryOf(bundle([{ ipa: '/ˈɹʌnɪŋ/', tags: ['Received-Pronunciation', 'US'] }]), makeDraft());
    expect([e.ipaUs, e.ipaUk]).toEqual(['/ˈɹʌnɪŋ/', '/ˈɹʌnɪŋ/']);
  });

  it('audio: mp3_url, accent from the tags, else from the file name; Lingua Libre files take the accent of their tag', () => {
    const e = entryOf(bundle(sounds), makeDraft());
    expect(e.audioUsUrl).toBe('https://upload.wikimedia.org/commons/transcoded/c/c1/En-us-ran.ogg/En-us-ran.ogg.mp3');
    expect(e.audioUkUrl).toContain('LL-Q1860_%28eng%29-Vealhurl-ran.wav.mp3');
  });

  it('audio with no usable tag falls back to the accent in the file name; other accents are not used', () => {
    const e = entryOf(
      bundle([
        { audio: 'En-uk-London.ogg', mp3_url: 'https://x.org/En-uk-London.ogg.mp3' },
        { audio: 'en-au-RAN.ogg', mp3_url: 'https://x.org/en-au-RAN.ogg.mp3', tags: ['Australia'] },
        { audio: 'En-run.ogg', mp3_url: 'https://x.org/En-run.ogg.mp3' },
      ]),
      makeDraft()
    );
    expect(e.audioUkUrl).toBe('https://x.org/En-uk-London.ogg.mp3');
    expect(e.audioUsUrl).toBeNull();
  });

  it('ogg_url only when there is no mp3_url; an over-long URL is dropped, never cut', () => {
    const e = entryOf(bundle([{ tags: ['US'], audio: 'a.ogg', ogg_url: 'https://x.org/a.ogg' }, { tags: ['UK'], audio: 'b.ogg', mp3_url: `https://x.org/${'b'.repeat(520)}.mp3` }]), makeDraft());
    expect(e.audioUsUrl).toBe('https://x.org/a.ogg');
    expect(e.audioUkUrl).toBeNull();
  });

  it('never takes an IPA from Haiku: no Wiktionary and no Free Dictionary data means NULL', () => {
    const e = entryOf(makeBundle(), makeDraft());
    expect([e.ipaUs, e.ipaUk, e.audioUsUrl, e.audioUkUrl]).toEqual([null, null, null, null]);
  });

  it('Free Dictionary fills what Wiktionary lacks; an IPA of unknown accent goes to ipa_us only when nothing else exists, and says so', () => {
    const fd = (ipa: any, audio: any = { us: null, uk: null, any: null }) =>
      ({ status: 'found', entry: { headword: 'bank', ipa, audio, pos: ['noun'], senses: [], license: null, sourceUrls: [] } }) as any;
    const known = entryOf(makeBundle({ wiktionaryRows: [], freeDictionary: fd({ us: 'bæŋk', uk: '/bæŋk/', any: '/x/' }, { us: 'https://a/us.mp3', uk: null, any: null }) }), makeDraft());
    expect([known.ipaUs, known.ipaUk, known.audioUsUrl]).toEqual(['/bæŋk/', '/bæŋk/', 'https://a/us.mp3']);

    const unknownAccent = entryOf(makeBundle({ wiktionaryRows: [], freeDictionary: fd({ us: null, uk: null, any: '/ˈtæksi/' }) }), makeDraft());
    expect([unknownAccent.ipaUs, unknownAccent.ipaUk]).toEqual(['/ˈtæksi/', null]);
    expect(unknownAccent.adminNote).toContain('không rõ giọng');
  });

  it('cleanIpa / cleanFreeDictionaryIpa', () => {
    expect(cleanIpa('/ˈbʊlɪt/')).toBe('/ˈbʊlɪt/');
    expect(cleanIpa('[ˈbʊlɪt]')).toBeNull();
    expect(cleanIpa('/-ˌkæst/')).toBeNull();
    expect(cleanIpa('//')).toBeNull();
    expect(cleanIpa(`/${'a'.repeat(260)}/`)).toBeNull();
    expect(cleanFreeDictionaryIpa('ˈtæksi')).toBe('/ˈtæksi/');
    expect(cleanFreeDictionaryIpa('[x]')).toBeNull();
    expect(cleanFreeDictionaryIpa(undefined)).toBeNull();
  });
});

describe('headword (letter case of Wiktionary)', () => {
  it('April: the only rows are names written with a capital → headword "April", lemma "april"', () => {
    const e = entryOf(
      makeBundle({ word: 'april', expectedLemma: null, wiktionaryRows: [wrow({ word: 'april', written: 'April', pos: 'name' })] }),
      makeDraft({ headword: 'April', lemma: 'april', senses: [sense(['tháng Tư'], { pos: 'noun' })] })
    );
    expect([e.headword, e.lemma]).toEqual(['April', 'april']);
  });

  it('march: a normal lowercase row wins over the capitalised name row', () => {
    const e = entryOf(
      makeBundle({ word: 'march', wiktionaryRows: [wrow({ id: 1, word: 'march', written: 'March', pos: 'name' }), wrow({ id: 2, word: 'march', pos: 'verb' })] }),
      makeDraft({ headword: 'March', lemma: 'march' })
    );
    expect(e.headword).toBe('march');
  });

  it('without Wiktionary rows the headword is Haiku\'s (same letters as the lemma)', () => {
    const e = entryOf(makeBundle({ wiktionaryRows: [] }), makeDraft({ headword: 'AIDS', lemma: 'aids' }));
    expect([e.headword, e.lemma]).toEqual(['AIDS', 'aids']);
  });
});

describe('word_forms', () => {
  const forms = [
    { form: 'runneth', tags: ['archaic', 'third-person', 'singular', 'present'] },
    { form: 'runned', tags: ['past', 'nonstandard'] },
    { form: 'runnen', tags: ['past', 'dialectal'] },
    { form: 'runs', tags: ['present', 'singular', 'third-person'] },
    { form: 'running', tags: ['participle', 'present'] },
    { form: 'ran', tags: ['past'] },
    { form: 'ran', tags: ['past'] }, // repeated
    { form: 'run', tags: ['participle', 'past'] }, // equals the lemma
    { form: 'more run', tags: ['comparative'] }, // several words
    { form: 'no-table-tags', tags: ['table-tags'] },
    { form: '-', tags: ['plural'] },
    { form: 'unknown', tags: ['canonical'] }, // maps to no form_type
    { form: 'rarely', tags: ['past', 'rare'] },
  ];
  const e = () => entryOf(makeBundle({ word: 'run', wiktionaryRows: [wrow({ word: 'run', pos: 'verb', forms })] }), makeDraft({ headword: 'run', lemma: 'run', senses: [sense(['chạy'], { pos: 'verb' })] }));

  it('keeps the forms whose tags map to a form_type, drops misspelling / obsolete / archaic / nonstandard / dialectal / rare ones', () => {
    expect(e().forms.map((f) => [f.formValue, f.formType])).toEqual([
      ['runs', 'third_person_singular'],
      ['running', 'present_participle'],
      ['ran', 'past_simple'],
    ]);
  });

  it('drops table markers, placeholders, multi-word forms, forms equal to the lemma and forms without a type', () => {
    const values = e().forms.map((f) => f.formValue);
    for (const dropped of ['run', 'more run', 'no-table-tags', '-', 'unknown', 'runneth', 'runned', 'runnen', 'rarely']) expect(values).not.toContain(dropped);
  });

  it('sort_order is 0, 1, 2…', () => {
    expect(e().forms.map((f) => f.sortOrder)).toEqual([0, 1, 2]);
  });

  it('the conjugation table of the real "run" row gives exactly 3 verb forms (a past-tense cell is NOT a third person singular)', () => {
    // forms of the verb row "run" as stored in ref_wiktionary_en (15/10/2026), and of its noun row
    const verb = [
      ['runs', ['present', 'singular', 'third-person']], ['running', ['participle', 'present']], ['ran', ['past']], ['run', ['participle', 'past']],
      ['ran', ['colloquial', 'nonstandard', 'participle', 'past']], ['run', ['infinitive']], ['run', ['first-person', 'present', 'singular']],
      ['ran', ['first-person', 'past', 'singular']], ['run', ['present', 'second-person', 'singular']], ['runnest', ['archaic', 'present', 'second-person', 'singular']],
      ['ran', ['past', 'second-person', 'singular']], ['ranst', ['archaic', 'past', 'second-person', 'singular']], ['runneth', ['archaic', 'present', 'singular', 'third-person']],
      ['ran', ['past', 'singular', 'third-person']], ['run', ['plural', 'present']], ['ran', ['past', 'plural']], ['run', ['present', 'subjunctive']],
      ['ran', ['past', 'subjunctive']], ['run', ['imperative', 'present']],
    ].map(([form, tags]) => ({ form, tags }));
    const noun = [{ form: 'runs', tags: ['plural'] }, { form: 'rin', tags: ['alternative', 'dialectal'] }];
    const out = entryOf(
      makeBundle({ word: 'run', wiktionaryRows: [wrow({ id: 1, word: 'run', pos: 'verb', forms: verb as any }), wrow({ id: 2, word: 'run', pos: 'noun', forms: noun })] }),
      makeDraft({ headword: 'run', lemma: 'run', senses: [sense(['chạy'], { pos: 'verb' }), sense(['cuộc chạy'], { pos: 'noun' })] })
    );
    expect(out.forms.map((f) => [f.formValue, f.formType])).toEqual([
      ['runs', 'third_person_singular'],
      ['running', 'present_participle'],
      ['ran', 'past_simple'],
      ['runs', 'plural'],
    ]);
  });

  it('wiktionaryFormType reads the tags with the part of speech of the row', () => {
    expect(wiktionaryFormType('verb', ['present', 'singular', 'third-person'])).toBe('third_person_singular');
    expect(wiktionaryFormType('verb', ['past', 'singular', 'third-person'])).toBe('past_simple');
    expect(wiktionaryFormType('verb', ['plural', 'present'])).toBeNull(); // "are": a cell of the table, not a noun plural
    expect(wiktionaryFormType('verb', ['past', 'participle'])).toBe('past_participle');
    expect(wiktionaryFormType('noun', ['plural'])).toBe('plural');
    expect(wiktionaryFormType('noun', ['possessive'])).toBe('possessive');
    expect(wiktionaryFormType('adjective', ['comparative'])).toBe('comparative');
    expect(wiktionaryFormType('adjective', ['superlative'])).toBe('superlative');
    expect(wiktionaryFormType('adverb', ['canonical'])).toBeNull();
    expect(wiktionaryFormType(null, ['plural'])).toBe('plural');
  });
});

describe('is_countable and is_transitive (Wiktionary first, then Haiku)', () => {
  const noun = (expansion: string, tags: string[] = []) =>
    makeBundle({ wiktionaryRows: [wrow({ word: 'bank', pos: 'noun', head: expansion, senses: [{ glosses: ['x'], tags }] })] });

  it('"countable and uncountable" → true', () => {
    expect(entryOf(noun('karaoke (countable and uncountable, plural karaokes)'), makeDraft({ is_countable: false })).isCountable).toBe(true);
  });
  it('"uncountable" only → false, even if Haiku said true', () => {
    expect(entryOf(noun('advice (uncountable)'), makeDraft({ is_countable: true })).isCountable).toBe(false);
  });
  it('a sense tag counts too', () => {
    expect(entryOf(noun('bank', ['countable']), makeDraft({ is_countable: false })).isCountable).toBe(true);
    expect(entryOf(noun('bank', ['uncountable']), makeDraft({ is_countable: true })).isCountable).toBe(false);
  });
  it('Wiktionary silent → Haiku\'s answer', () => {
    expect(entryOf(noun('bank'), makeDraft({ is_countable: true })).isCountable).toBe(true);
    expect(entryOf(noun('bank'), makeDraft({ is_countable: null })).isCountable).toBeNull();
  });
  it('no noun sense → null whatever the sources say', () => {
    expect(entryOf(noun('bank (countable)'), makeDraft({ senses: [sense(['a'], { pos: 'adjective' })], is_countable: true })).isCountable).toBeNull();
  });

  const verb = (tags: string[]) => makeBundle({ word: 'run', wiktionaryRows: [wrow({ word: 'run', pos: 'verb', senses: [{ glosses: ['x'], tags }] })] });
  const verbDraft = (t: boolean | null) => makeDraft({ headword: 'run', lemma: 'run', senses: [sense(['chạy'], { pos: 'verb' })], is_transitive: t, is_countable: null });
  it('transitive / ambitransitive → true; only intransitive → false; silent → Haiku', () => {
    expect(entryOf(verb(['transitive']), verbDraft(false)).isTransitive).toBe(true);
    expect(entryOf(verb(['ambitransitive']), verbDraft(false)).isTransitive).toBe(true);
    expect(entryOf(verb(['intransitive']), verbDraft(true)).isTransitive).toBe(false);
    expect(entryOf(verb([]), verbDraft(true)).isTransitive).toBe(true);
    expect(entryOf(verb([]), verbDraft(null)).isTransitive).toBeNull();
  });
});

describe('etymology', () => {
  it('cleanEtymology drops the "Etymology tree" ancestors and keeps the prose', () => {
    const text = 'Etymology tree\nJapanese 空\nAncient Greek ὀρχέομαι (orkhéomai)\nEnglish karaoke\nBorrowed from Japanese カラオケ (karaoke), from 空(から) (kara, “empty”) + オケ (oke, “orchestra”).';
    expect(cleanEtymology(text)).toBe('Borrowed from Japanese カラオケ (karaoke), from 空(から) (kara, “empty”) + オケ (oke, “orchestra”).');
  });
  it('a tree with no prose (cut by the 1000-character limit of the loader) gives null', () => {
    expect(cleanEtymology('Etymology tree\nProto-Indo-European *h₁én\nLatin inter\nEnglish net')).toBeNull();
  });
  it('plain prose is kept, whitespace folded, and cut at 1000 characters', () => {
    expect(cleanEtymology('From Middle English runnen,\nfrom Old English rinnan.')).toBe('From Middle English runnen, from Old English rinnan.');
    expect(cleanEtymology('x '.repeat(800))!.length).toBeLessThanOrEqual(1000);
    expect(cleanEtymology(undefined)).toBeNull();
    expect(cleanEtymology('   ')).toBeNull();
  });
  it('is taken from the first normal row that has one (not a name row)', () => {
    const e = entryOf(
      makeBundle({ wiktionaryRows: [wrow({ id: 1, word: 'bank', pos: 'name' }), wrow({ id: 2, word: 'bank', pos: 'noun' })].map((r, i) => ({ ...r, data: { ...r.data, etymology_text: i === 0 ? 'From a name.' : 'From Italian banca, a bench.' } })) }),
      makeDraft()
    );
    expect(e.etymology).toBe('From Italian banca, a bench.');
  });
});

describe('topics, phrases, families, relations', () => {
  it('at most 3 topics, and only those that have an id in tags', () => {
    const e = entryOf(makeBundle(), makeDraft({ topics: ['business_economy', 'unknown_topic', 'education_school', 'food_drink', 'health_medicine'] }));
    expect(e.tagNames).toEqual(['business_economy', 'education_school', 'food_drink']);
    expect(e.tagIds).toEqual(['tag-business', 'tag-education', 'tag-food']);
  });

  it('idioms, phrasal verbs and collocations: at most 5 each', () => {
    const idiom = (n: number) => ({ idiom_text: `idiom ${n}`, definition_en: 'd', definition_vi: 'đ', example_en: 'e', example_vi: 'v' });
    const pv = (n: number) => ({ phrasal_verb: `run ${n}`, particle: 'up', is_separable: false, definition_en: 'd', definition_vi: 'đ', example_en: 'e', example_vi: 'v' });
    const col = (n: number) => ({ collocation: `col ${n}`, pattern: 'adj + noun', example_en: 'e', example_vi: 'v' });
    const seven = [1, 2, 3, 4, 5, 6, 7];
    const e = entryOf(makeBundle(), makeDraft({ idioms: seven.map(idiom), phrasal_verbs: seven.map(pv), collocations: seven.map(col) }));
    expect([e.idioms.length, e.phrasalVerbs.length, e.collocations.length]).toEqual([5, 5, 5]);
  });

  it('derived / related words of Wiktionary become word family candidates (single words only)', () => {
    const row = wrow({ word: 'bank', pos: 'noun' });
    row.data.derived = [{ word: 'banker' }, { word: 'bank holiday' }, 'banking', { word: 'bank' }];
    row.data.related = [{ word: 'bankrupt' }];
    const e = entryOf(makeBundle({ wiktionaryRows: [row] }), makeDraft());
    expect(e.familyWords).toEqual(['banker', 'banking', 'bankrupt']);
  });

  it('entry synonyms / antonyms are lemmas to look up among existing entries, nothing else', () => {
    const e = entryOf(makeBundle(), makeDraft({ senses: [sense(['a'], { synonyms: ['lender', 'depository'], antonyms: ['borrower'] }), sense(['b'], { synonyms: ['lender', 'shore'] })] }));
    expect(e.entrySynonymLemmas).toEqual(['lender', 'depository', 'shore']);
    expect(e.entryAntonymLemmas).toEqual(['borrower']);
  });
});

describe('cutting strings to the column sizes (no 22001)', () => {
  it('cut() respects the limit and never splits a surrogate pair', () => {
    expect(cut('abcdef', 3)).toBe('abc');
    expect(cut('abc', 3)).toBe('abc');
    const emoji = 'a😀b'; // 😀 is two UTF-16 units
    expect(cut(emoji, 2)).toBe('a');
    expect(cut(emoji, 3)).toBe('a😀');
  });

  it('every limited column is cut to its size', () => {
    const long = (n: number) => 'x'.repeat(n);
    const e = entryOf(
      makeBundle({ wiktionaryRows: [] }),
      makeDraft({
        headword: long(300),
        lemma: long(300),
        senses: [sense(['a'], { pos: 'noun', domain: long(150), region: long(50) })],
        idioms: [{ idiom_text: long(600), definition_en: 'd', definition_vi: 'đ', example_en: 'e', example_vi: 'v' }],
        phrasal_verbs: [{ phrasal_verb: long(300), particle: long(40), is_separable: true, definition_en: 'd', definition_vi: 'đ', example_en: 'e', example_vi: 'v' }],
        collocations: [{ collocation: long(300), pattern: long(80), example_en: 'e', example_vi: 'v' }],
      })
    );
    expect(e.lemma.length).toBe(COLUMN_LIMITS.lemma);
    expect(e.headword.length).toBeLessThanOrEqual(COLUMN_LIMITS.headword);
    expect(e.senses[0].domain!.length).toBe(COLUMN_LIMITS.senseDomain);
    expect(e.senses[0].region!.length).toBe(COLUMN_LIMITS.senseRegion);
    expect(e.idioms[0].idiomText.length).toBe(COLUMN_LIMITS.idiomText);
    expect(e.phrasalVerbs[0].phrasalVerb.length).toBe(COLUMN_LIMITS.phrasalVerb);
    expect(e.phrasalVerbs[0].particle.length).toBe(COLUMN_LIMITS.particle);
    expect(e.collocations[0].collocation.length).toBe(COLUMN_LIMITS.collocation);
    expect(e.collocations[0].pattern!.length).toBe(COLUMN_LIMITS.collocationPattern);
  });

  it('meaning_vi never passes 200 characters, admin_note stays bounded', () => {
    const e = entryOf(makeBundle(), makeDraft({ notes_for_review: ['n'.repeat(6000)] }));
    expect(e.meaningVi.length).toBeLessThanOrEqual(200);
    expect(e.adminNote.length).toBeLessThanOrEqual(4000);
  });
});

describe('privacy', () => {
  it('admin_note holds no personal data: only sources, model, job id and review notes', () => {
    const e = entryOf(makeBundle(), makeDraft());
    expect(e.adminNote).not.toMatch(/@|requested|user/i);
  });
});
