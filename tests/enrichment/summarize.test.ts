import { estimateTokens, summarizeForPrompt } from '../../services/enrichment/sources/wiktionary';
import type { WiktionaryRow } from '../../services/enrichment/types';
import { wrow } from './fixtures';

const sense = (n: number, over: Record<string, unknown> = {}) => ({
  glosses: [`gloss number ${n} of the word`],
  tags: ['countable'],
  examples: [{ text: `first example ${n}` }, { text: `second example ${n}` }, { text: `third example ${n}` }],
  synonyms: [{ word: `syn${n}` }],
  antonyms: [{ word: `ant${n}` }],
  ...over,
});

describe('summarizeForPrompt', () => {
  it('keeps pos, head expansion, glosses, tags, forms, and at most 2 examples per sense', () => {
    const row = wrow({
      word: 'cat',
      pos: 'noun',
      etymology_number: 1,
      head: 'cat (plural cats)',
      forms: [{ form: 'cats', tags: ['plural'] }, { form: '-' }, { form: 'cats' }, { form: 'no-table-tags' }],
      senses: [sense(1)],
    });
    const { entries } = summarizeForPrompt([row]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ pos: 'noun', etymology: 1, head: 'cat (plural cats)' });
    expect(entries[0].forms).toEqual(['cats']); // "-", "no-table-tags" and duplicates dropped
    expect(entries[0].senses[0]).toEqual({
      glosses: ['gloss number 1 of the word'],
      tags: ['countable'],
      examples: ['first example 1', 'second example 1'],
      synonyms: ['syn1'],
      antonyms: ['ant1'],
    });
  });

  it('never sends IPA or audio', () => {
    const row = wrow({ word: 'cat', pos: 'noun', senses: [sense(1)], sounds: [{ ipa: '/kæt/', tags: ['US'], mp3_url: 'https://upload.wikimedia.org/x.mp3', audio: 'En-us-cat.ogg' }] });
    const text = JSON.stringify(summarizeForPrompt([row]).entries);
    expect(text).not.toMatch(/ipa|mp3|ogg|audio|sounds|kæt|wikimedia/i);
  });

  it('keeps at most 6 senses in total, however many rows and senses there are', () => {
    const rows = [
      wrow({ id: 1, word: 'run', pos: 'verb', senses: Array.from({ length: 12 }, (_, i) => sense(i)) }),
      wrow({ id: 2, word: 'run', pos: 'noun', senses: Array.from({ length: 9 }, (_, i) => sense(i + 20)) }),
    ];
    const r = summarizeForPrompt(rows);
    expect(r.sensesKept).toBe(6);
    expect(r.entries.reduce((n, e) => n + e.senses.length, 0)).toBe(6);
    expect(r.sensesDropped).toBe(21 - 6);
  });

  it('spreads the senses over the parts of speech (round-robin) so a long verb entry does not hide the noun', () => {
    const rows = [
      wrow({ id: 1, word: 'run', pos: 'verb', senses: Array.from({ length: 12 }, (_, i) => sense(i)) }),
      wrow({ id: 2, word: 'run', pos: 'noun', senses: Array.from({ length: 9 }, (_, i) => sense(i + 20)) }),
      wrow({ id: 3, word: 'run', pos: 'adj', senses: [sense(40)] }),
    ];
    const { entries } = summarizeForPrompt(rows);
    expect(entries.map((e) => e.pos).sort()).toEqual(['adj', 'noun', 'verb']);
    // 6 slots over 3 rows, one per row per round: verb 3, noun 2, adj 1
    expect(entries.find((e) => e.pos === 'verb')!.senses).toHaveLength(3);
    expect(entries.find((e) => e.pos === 'noun')!.senses).toHaveLength(2);
    expect(entries.find((e) => e.pos === 'adj')!.senses).toHaveLength(1);
  });

  it('puts rows whose letter case equals the lookup key (data.word lowercase) before the others', () => {
    const rows: WiktionaryRow[] = [
      wrow({ id: 1, word: 'ran', written: 'RAN', pos: 'name', senses: [sense(1)] }),
      wrow({ id: 2, word: 'ran', written: 'Ran', pos: 'name', senses: [sense(2)] }),
      wrow({ id: 3, word: 'ran', pos: 'verb', senses: [sense(3)] }),
    ];
    const { entries } = summarizeForPrompt(rows, { maxSenses: 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0].pos).toBe('verb');
    expect(entries[0].written).toBeUndefined();
    const all = summarizeForPrompt(rows).entries;
    expect(all.map((e) => e.written ?? e.pos)).toEqual(['verb', 'RAN', 'Ran']);
  });

  it('honours the token budget (estimated as characters / 4) by dropping detail, then senses', () => {
    const big = (i: number) => sense(i, { glosses: ['g'.repeat(300)], examples: [{ text: 'e'.repeat(240) }, { text: 'f'.repeat(240) }] });
    const rows = [wrow({ word: 'x', pos: 'noun', forms: Array.from({ length: 20 }, (_, i) => ({ form: `form${i}` })), senses: Array.from({ length: 8 }, (_, i) => big(i)) })];
    const loose = summarizeForPrompt(rows, { maxTokens: 100000 });
    const tight = summarizeForPrompt(rows, { maxTokens: 450 });
    expect(estimateTokens(JSON.stringify(loose.entries))).toBeGreaterThan(450);
    expect(tight.approxTokens).toBeLessThanOrEqual(450);
    expect(estimateTokens(JSON.stringify(tight.entries))).toBe(tight.approxTokens);
    expect(tight.sensesKept).toBeLessThan(loose.sensesKept);
    expect(tight.sensesKept).toBeGreaterThanOrEqual(1);
  });

  it('with the default budget (2500 tokens) a typical 6-sense entry fits', () => {
    const rows = [wrow({ word: 'bank', pos: 'noun', head: 'bank (plural banks)', senses: Array.from({ length: 6 }, (_, i) => sense(i)) })];
    const r = summarizeForPrompt(rows);
    expect(r.approxTokens).toBeLessThanOrEqual(2500);
    expect(r.entries[0].senses.every((s) => s.examples?.length === 2)).toBe(true);
  });

  it('keeps form_of / alt_of targets so Haiku can see a form or a misspelling', () => {
    const rows = [wrow({ word: 'recieve', pos: 'verb', senses: [{ glosses: ['Misspelling of receive.'], tags: ['alt-of', 'misspelling'], alt_of: [{ word: 'receive' }] }] })];
    const s = summarizeForPrompt(rows).entries[0].senses[0];
    expect(s.alt_of).toEqual(['receive']);
    expect(s.tags).toEqual(['alt-of', 'misspelling']);
  });

  it('handles rows without senses and an empty list', () => {
    expect(summarizeForPrompt([]).entries).toEqual([]);
    expect(summarizeForPrompt([wrow({ word: 'x', pos: 'noun', senses: [] })]).entries).toEqual([]);
  });
});
