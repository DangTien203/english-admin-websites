import {
  assembleEntry,
  filterWiktionaryRelated,
  IPA_UNTAGGED_MARK,
  pickWiktionaryUntaggedIpa,
  untaggedIpaNote,
  WIKTIONARY_RELATED_MAX,
  type AssembleContext,
  type AssembledEntry,
} from '../../services/enrichment/assemble';
import { collectRelatedWords, isPlainRelatedWord } from '../../services/enrichment/sources/wiktionary';
import type { Draft } from '../../services/enrichment/haiku/schema';
import type { SourceBundle } from '../../services/enrichment/types';
import { makeBundle, makeDraft, makeSense, wrow } from './fixtures';

const ctx = (over: Partial<AssembleContext> = {}): AssembleContext => ({ jobId: 'job-1', model: 'test-model', publishPolicy: 'review', topicIds: new Map([['business_economy', 'tag-business']]), ...over });

function entryOf(bundle: SourceBundle, draft: Draft = makeDraft()): AssembledEntry {
  const r = assembleEntry(bundle, draft, ctx());
  if (r.status !== 'ok') throw new Error(`expected an entry, got ${JSON.stringify(r)}`);
  return r.entry;
}

const withSounds = (sounds: any[], over: Partial<SourceBundle> = {}) => makeBundle({ wiktionaryRows: [wrow({ word: 'bank', pos: 'noun', sounds })], ...over });

// ═════════════════════════════════════════════════════════════════════════════
describe('ipa_us: the untagged IPA is the LAST resort', () => {
  it('a US-tagged IPA is used, even when an untagged one comes first; no marker', () => {
    const e = entryOf(withSounds([{ ipa: '/bæŋk-untagged/' }, { ipa: '/bæŋk/', tags: ['US'] }]));
    expect(e.ipaUs).toBe('/bæŋk/');
    expect(e.adminNote).not.toContain(IPA_UNTAGGED_MARK);
  });

  it('General-American counts as US', () => {
    const e = entryOf(withSounds([{ ipa: '/x1/' }, { ipa: '/bæŋk/', tags: ['General-American'] }]));
    expect(e.ipaUs).toBe('/bæŋk/');
    expect(e.adminNote).not.toContain(IPA_UNTAGGED_MARK);
  });

  it('no US-tagged IPA: the FIRST untagged IPA becomes ipa_us, and admin_note carries the marker', () => {
    const e = entryOf(withSounds([{ ipa: '/ɛˈfɛ.mə.ɹəl/' }, { ipa: '/əˈfɛ.mə.ɹəl/' }, { tags: ['US'], audio: 'en-us-ephemeral.ogg', mp3_url: 'https://x.org/a.mp3' }]));
    expect(e.ipaUs).toBe('/ɛˈfɛ.mə.ɹəl/');
    expect(e.adminNote).toContain(IPA_UNTAGGED_MARK);
    expect(e.adminNote).toContain(untaggedIpaNote());
    expect(e.adminNote).toMatch(/^\[auto\]/); // the entry stays recognizable as automatic
  });

  it('the untagged IPA is NEVER copied to ipa_uk', () => {
    const e = entryOf(withSounds([{ ipa: '/ɛˈfɛ.mə.ɹəl/' }]));
    expect(e.ipaUs).toBe('/ɛˈfɛ.mə.ɹəl/');
    expect(e.ipaUk).toBeNull();
  });

  it('a UK-tagged IPA still fills ipa_uk, and the untagged one fills the missing ipa_us', () => {
    const e = entryOf(withSounds([{ ipa: '/ʃeə/' , tags: ['Received-Pronunciation'] }, { ipa: '/ʃɛɹ/' }]));
    expect([e.ipaUs, e.ipaUk]).toEqual(['/ʃɛɹ/', '/ʃeə/']);
    expect(e.adminNote).toContain(IPA_UNTAGGED_MARK);
  });

  it('only a valid IPA counts: narrow transcription [..] and partial /-..-/ are skipped', () => {
    const e = entryOf(withSounds([{ ipa: '[ɹɛən]' }, { ipa: '/-ˌkæst/' }, { ipa: '/pɒdkɑːst/' }]));
    expect(e.ipaUs).toBe('/pɒdkɑːst/');
  });

  it('a sound with ANY tag is not untagged: tagged for another accent or "rare" is never used', () => {
    const e = entryOf(withSounds([{ ipa: '/ɾan/', tags: ['Scotland'] }, { ipa: '/ɹan/', tags: ['rare'] }, { ipa: '/ɹan/', raw_tags: ['dated'] }]));
    expect([e.ipaUs, e.ipaUk]).toEqual([null, null]);
    expect(e.adminNote).not.toContain(IPA_UNTAGGED_MARK);
  });

  it('no IPA at all: both stay empty, tier B says so, no marker', () => {
    const e = entryOf(withSounds([{ tags: ['US'], audio: 'en-us-x.ogg', mp3_url: 'https://x.org/a.mp3' }]));
    expect([e.ipaUs, e.ipaUk]).toEqual([null, null]);
    expect(e.report.tierBMissing).toContain('ipa');
    expect(e.adminNote).not.toContain(IPA_UNTAGGED_MARK);
  });

  it('an untagged IPA satisfies tier B (ipa is no longer listed as missing)', () => {
    const e = entryOf(withSounds([{ ipa: '/bæŋk/' }]));
    expect(e.report.tierBMissing).not.toContain('ipa');
    expect(e.adminNote).not.toMatch(/thiếu tầng B: [^·]*\bipa\b/);
  });

  it('order of the whole chain: tagged → Free Dictionary → untagged', () => {
    const fd = (ipa: any) => ({ status: 'found', entry: { headword: 'bank', ipa, audio: { us: null, uk: null, any: null }, pos: ['noun'], senses: [], license: null, sourceUrls: [] } }) as any;
    // Free Dictionary beats the untagged Wiktionary IPA
    const viaFd = entryOf(withSounds([{ ipa: '/untagged/' }], { freeDictionary: fd({ us: '/fd-us/', uk: null, any: null }) }));
    expect(viaFd.ipaUs).toBe('/fd-us/');
    expect(viaFd.adminNote).not.toContain(IPA_UNTAGGED_MARK);
    // Free Dictionary without a usable IPA: the untagged one is used
    const viaUntagged = entryOf(withSounds([{ ipa: '/untagged/' }], { freeDictionary: fd({ us: null, uk: null, any: null }) }));
    expect(viaUntagged.ipaUs).toBe('/untagged/');
    expect(viaUntagged.adminNote).toContain(IPA_UNTAGGED_MARK);
  });

  it('pickWiktionaryUntaggedIpa reads the rows of the entry only and returns null without any bare IPA', () => {
    expect(pickWiktionaryUntaggedIpa([wrow({ word: 'x', pos: 'noun', sounds: [{ ipa: '/a/' }] })])).toBe('/a/');
    expect(pickWiktionaryUntaggedIpa([wrow({ word: 'x', pos: 'noun', sounds: [{ ipa: '/a/', tags: ['US'] }] })])).toBeNull();
    expect(pickWiktionaryUntaggedIpa([wrow({ word: 'x', pos: 'noun' })])).toBeNull();
    expect(pickWiktionaryUntaggedIpa([])).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('synonyms / antonyms from Wiktionary are filtered by the frequency list', () => {
  const none = new Set<string>();

  it('keeps only words that are in ref_word_frequency', () => {
    expect(filterWiktionaryRelated(['casualty', 'hap', 'luck'], { casualty: 9500, luck: 1900 }, none)).toEqual(['luck', 'casualty']);
  });

  it('drops phrases and words with an apostrophe or quote, even when the list happens to know them', () => {
    const ranks = { "murphy's": 5, "murphy's law": 5, 'perfect storm': 5, 'perfect': 700, 'storm': 2000, 'ne’er': 9, 'say"x': 9, 'chance-medley': 9 };
    expect(filterWiktionaryRelated(["murphy's law", 'perfect storm', 'ne’er', 'say"x', "murphy's", 'perfect'], ranks, none)).toEqual(['perfect']);
  });

  it('most frequent first (smallest rank), ties keep Wiktionary\'s order', () => {
    expect(filterWiktionaryRelated(['rare', 'common', 'middle', 'tie-a', 'tie-b'], { rare: 50000, common: 100, middle: 5000, 'tie-a': 700, 'tie-b': 700 }, none)).toEqual(['common', 'tie-a', 'tie-b', 'middle', 'rare']);
  });

  it(`at most ${WIKTIONARY_RELATED_MAX}`, () => {
    const words = Array.from({ length: 12 }, (_, i) => `w${i}`);
    const ranks = Object.fromEntries(words.map((w, i) => [w, 1000 + i]));
    const out = filterWiktionaryRelated(words, ranks, none);
    expect(out).toHaveLength(5);
    expect(out).toEqual(['w0', 'w1', 'w2', 'w3', 'w4']);
  });

  it('lowercases, removes duplicates and never returns the headword or the lemma', () => {
    expect(filterWiktionaryRelated(['Luck', 'LUCK', 'bank', 'fortune'], { luck: 1900, bank: 705, fortune: 3000 }, new Set(['bank']))).toEqual(['luck', 'fortune']);
  });

  it('no ranks at all gives nothing', () => {
    expect(filterWiktionaryRelated(['luck', 'chance'], {}, none)).toEqual([]);
  });

  describe('in the assembled entry (the serendipity case)', () => {
    const rows = [
      wrow({
        word: 'serendipity',
        pos: 'noun',
        senses: [
          {
            glosses: ['The occurrence of finding something valuable or pleasant by chance.'],
            synonyms: [{ word: 'casualty' }, { word: 'hap' }, { word: 'chance-medley' }, { word: 'luck' }, { word: 'fortune' }, { word: 'accident' }],
            antonyms: [{ word: "murphy's law" }, { word: 'perfect storm' }, { word: 'misfortune' }],
          },
        ],
      }),
    ];
    const draft = (extra: { synonyms?: string[]; antonyms?: string[] } = {}) =>
      makeDraft({
        headword: 'serendipity',
        lemma: 'serendipity',
        senses: [makeSense({ definition_en: 'the occurrence of finding something valuable or pleasant by chance', meanings_vi: ['may mắn tình cờ'], synonyms: extra.synonyms ?? [], antonyms: extra.antonyms ?? [] })],
      });
    const bundle = (over: Partial<SourceBundle> = {}) =>
      makeBundle({ word: 'serendipity', expectedLemma: 'serendipity', wiktionaryRows: rows, relatedRanks: { casualty: 9500, luck: 1900, fortune: 3300, accident: 2100, misfortune: 14000 }, ...over });

    it('only listed single words, most frequent first; phrases, hyphenated rarities and unlisted words are gone', () => {
      const e = entryOf(bundle(), draft());
      expect(e.senses[0].synonyms).toEqual(['luck', 'accident', 'fortune', 'casualty']); // hap and chance-medley are not in the list
      expect(e.senses[0].antonyms).toEqual(['misfortune']); // murphy's law and perfect storm are phrases
    });

    it('Haiku\'s own choice follows Wiktionary\'s words and is not frequency-filtered', () => {
      const e = entryOf(bundle(), draft({ synonyms: ['happenstance', 'luck'], antonyms: ['bad luck'] }));
      expect(e.senses[0].synonyms).toEqual(['luck', 'accident', 'fortune', 'casualty', 'happenstance']);
      expect(e.senses[0].antonyms).toEqual(['misfortune', 'bad luck']);
    });

    it('at most 5 come from Wiktionary; the sense total stays at 8', () => {
      const many = Array.from({ length: 9 }, (_, i) => `syn${i}`);
      const wiktRows = [wrow({ word: 'serendipity', pos: 'noun', senses: [{ glosses: ['The occurrence of finding something valuable or pleasant by chance.'], synonyms: many.map((word) => ({ word })) }] })];
      const ranks = Object.fromEntries(many.map((w, i) => [w, 100 + i]));
      const haiku = ['h1', 'h2', 'h3', 'h4', 'h5'];
      const e = entryOf(bundle({ wiktionaryRows: wiktRows, relatedRanks: ranks }), draft({ synonyms: haiku }));
      expect(e.senses[0].synonyms).toEqual(['syn0', 'syn1', 'syn2', 'syn3', 'syn4', 'h1', 'h2', 'h3']);
    });

    it('a bundle without relatedRanks gets no Wiktionary synonyms (Haiku\'s stay)', () => {
      const b = bundle();
      delete b.relatedRanks;
      const e = entryOf(b, draft({ synonyms: ['happenstance'] }));
      expect(e.senses[0].synonyms).toEqual(['happenstance']);
      expect(e.senses[0].antonyms).toEqual([]);
    });
  });
});

describe('collecting the candidates to look up', () => {
  it('isPlainRelatedWord: one word, no apostrophe, no quote', () => {
    expect(isPlainRelatedWord('luck')).toBe(true);
    expect(isPlainRelatedWord('well-known')).toBe(true);
    for (const bad of ["murphy's", "murphy's law", 'perfect storm', 'ne’er', 'say"x', '`x', '', ' ']) expect(isPlainRelatedWord(bad)).toBe(false);
  });

  it('collectRelatedWords: sense-level synonyms and antonyms (strings or { word }), lowercase, single words only, no duplicates', () => {
    const rows = [
      wrow({ word: 'x', pos: 'noun', senses: [{ glosses: ['g'], synonyms: [{ word: 'Luck' }, 'chance', { word: "murphy's law" }, { word: 'perfect storm' }], antonyms: [{ word: 'misfortune' }, { word: 'luck' }] }] }),
      wrow({ word: 'x', pos: 'verb', senses: [{ glosses: ['h'], synonyms: [{ word: 'fortune' }] }, { glosses: ['i'] }] }),
    ];
    expect(collectRelatedWords(rows).sort()).toEqual(['chance', 'fortune', 'luck', 'misfortune']);
  });

  it('is capped', () => {
    const rows = [wrow({ word: 'x', pos: 'noun', senses: [{ glosses: ['g'], synonyms: Array.from({ length: 50 }, (_, i) => ({ word: `w${i}` })) }] })];
    expect(collectRelatedWords(rows, 10)).toHaveLength(10);
  });
});
