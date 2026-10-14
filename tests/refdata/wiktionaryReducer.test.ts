import {
  cut,
  deriveLemmaOf,
  EN_MARKER,
  isEnglishCandidate,
  LIMITS,
  parseDumpLine,
  parseEtymologyNumber,
  reduceEntry,
  reduceForms,
  reduceSounds,
} from '../../scripts/refdata/lib/wiktionary';
import { dumpLine, enRow, sampleRow, sampleRows } from './helpers';

describe('reduceEntry on real dump rows', () => {
  it('keeps the original capitalisation in data.word while the key column is lowercase (London ≠ london)', () => {
    const r = reduceEntry(sampleRow('London', 'name'))!;
    expect(r.word).toBe('london');
    expect(r.data.word).toBe('London');
    expect(r.pos).toBe('name');
    expect(r.lemma_of).toBeNull();
  });

  it('ran (verb): lemma_of is run even though one of its three senses is a nonstandard past participle', () => {
    const raw = sampleRow('ran', 'verb');
    expect(raw.senses.map((s: any) => s.tags)).toEqual([['form-of', 'past'], ['form-of', 'past'], ['colloquial', 'form-of', 'nonstandard', 'participle', 'past']]);
    const r = reduceEntry(raw)!;
    expect(r.lemma_of).toBe('run');
    expect(r.etymology_number).toBe(1);
    // the nonstandard sense is still in the data so the enrichment can see it
    expect(r.data.senses[2].tags).toContain('nonstandard');
    expect(r.data.senses[2].form_of).toEqual([{ word: 'run' }]);
  });

  it('ran (verb) with the literal "any sense is non-standard" rule: lemma_of is null (the documented trade-off)', () => {
    expect(reduceEntry(sampleRow('ran', 'verb'), { nonStandardRule: 'any' })!.lemma_of).toBeNull();
  });

  it('ran (noun, etymology 2) is a real word, not a form: no lemma_of', () => {
    const r = reduceEntry(sampleRow('ran', 'noun'))!;
    expect(r.lemma_of).toBeNull();
    expect(r.etymology_number).toBe(2);
  });

  it.each([
    ['running', 'verb', 'run'],
    ['children', 'noun', 'child'],
  ])('%s (%s) is a form of %s', (word, pos, lemma) => {
    expect(reduceEntry(sampleRow(word, pos))!.lemma_of).toBe(lemma);
  });

  it('running (noun / adj / adv) have their own senses: no lemma_of', () => {
    for (const pos of ['noun', 'adj', 'adv']) expect(reduceEntry(sampleRow('running', pos))!.lemma_of).toBeNull();
  });

  it('recieve (misspelling): lemma_of is null but the data still says alt_of receive + the misspelling tag', () => {
    const r = reduceEntry(sampleRow('recieve', 'verb'))!;
    expect(r.lemma_of).toBeNull();
    expect(r.data.senses[0]).toMatchObject({ tags: ['alt-of', 'misspelling'], alt_of: [{ word: 'receive' }] });
    expect(r.data.head_templates![0].expansion).toBe('recieve');
  });

  it('etymology_number is a STRING in the dump and becomes an integer (column and data)', () => {
    expect(sampleRow('ran', 'verb').etymology_number).toBe('1'); // proves the raw type
    const r = reduceEntry(sampleRow('ran', 'verb'))!;
    expect(r.etymology_number).toBe(1);
    expect(r.data.etymology_number).toBe(1);
    expect(parseEtymologyNumber('2')).toBe(2);
    expect(parseEtymologyNumber(3)).toBe(3);
    for (const bad of ['', 'x', '1.5', '-1', null, undefined, 1.5, {}]) expect(parseEtymologyNumber(bad)).toBeUndefined();
  });

  it('keeps etymology_number only where the dump has it', () => {
    expect(reduceEntry(sampleRow('London', 'name'))!.etymology_number).toBeNull();
    expect(reduceEntry(sampleRow('London', 'name'))!.data).not.toHaveProperty('etymology_number');
  });

  it('serendipity: etymology text, ubiquitous: ipa + audio in sounds', () => {
    expect(reduceEntry(sampleRow('serendipity', 'noun'))!.data.etymology_text).toMatch(/Serendip/i);
    const sounds = reduceEntry(sampleRow('ubiquitous', 'adj'))!.data.sounds!;
    expect(sounds.some((s) => s.ipa)).toBe(true);
    expect(sounds.some((s) => s.mp3_url && s.ogg_url && s.audio)).toBe(true);
  });

  it('drops everything it does not keep', () => {
    const r = reduceEntry(sampleRow('ubiquitous', 'adj'))!;
    for (const dropped of ['translations', 'descendants', 'categories', 'etymology_links', 'etymology_templates', 'lang', 'lang_code', '_sample', 'hyphenations', 'wikipedia']) {
      expect(r.data).not.toHaveProperty(dropped);
    }
    for (const sense of r.data.senses) {
      for (const dropped of ['links', 'categories', 'raw_glosses', 'senseid', 'wikidata']) expect(sense).not.toHaveProperty(dropped);
    }
    for (const sound of r.data.sounds!) expect(Object.keys(sound).every((k) => ['ipa', 'tags', 'mp3_url', 'ogg_url', 'audio', 'enpr'].includes(k))).toBe(true);
  });

  it('derived / related keep only the words', () => {
    const r = reduceEntry(sampleRow('ubiquitous', 'adj'))!;
    expect(r.data.derived).toEqual(expect.arrayContaining(['ubiquitously']));
    expect(r.data.derived!.every((w) => typeof w === 'string')).toBe(true);
    expect(r.data.related!.every((w) => typeof w === 'string')).toBe(true);
  });

  it('run (verb) with 64 senses: capped, forms cleaned, still small', () => {
    const r = reduceEntry(sampleRow('run', 'verb', undefined) /* first run/verb */)!;
    expect(r.data.senses.length).toBeLessThanOrEqual(LIMITS.senses);
    expect(r.data.forms!.length).toBeLessThanOrEqual(LIMITS.forms);
    expect(r.data.forms!.some((f) => f.form === 'no-table-tags' || f.form === 'glossary')).toBe(false);
    expect(JSON.stringify(r.data).length).toBeLessThan(16 * 1024);
  });

  it('every real sample row reduces without throwing and stays well below the original size', () => {
    let reducedTotal = 0;
    let originalTotal = 0;
    for (const raw of sampleRows()) {
      const r = reduceEntry(raw)!;
      expect(r).not.toBeNull();
      expect(r.word).toBe(raw.word.toLowerCase());
      expect(JSON.stringify(r.data).length).toBeLessThan(16 * 1024);
      reducedTotal += JSON.stringify(r.data).length;
      originalTotal += JSON.stringify(raw).length;
    }
    expect(reducedTotal).toBeLessThan(originalTotal * 0.5);
  });
});

describe('deriveLemmaOf', () => {
  const formOf = (word: string, tags: string[] = ['form-of']) => ({ glosses: ['x'], tags, form_of: [{ word }] });
  const altOf = (word: string, tags: string[] = ['alt-of']) => ({ glosses: ['x'], tags, alt_of: [{ word }] });

  it('form_of and alt_of both give a lemma (lowercased)', () => {
    expect(deriveLemmaOf([formOf('Run')], 'ran')).toBe('run');
    expect(deriveLemmaOf([altOf('Color', ['alt-of', 'alternative'])], 'colour')).toBe('color');
  });

  it('every sense must point somewhere: one real definition makes the row its own lemma', () => {
    expect(deriveLemmaOf([formOf('run'), { glosses: ['a real meaning'] }], 'ran')).toBeNull();
    expect(deriveLemmaOf([], 'x')).toBeNull();
  });

  it.each(['misspelling', 'obsolete', 'archaic', 'nonstandard', 'dialectal', 'rare', 'proscribed'])('a sense tagged %s never provides the lemma', (tag) => {
    expect(deriveLemmaOf([altOf('receive', ['alt-of', tag])], 'recieve')).toBeNull();
  });

  it('also looks at raw_tags', () => {
    expect(deriveLemmaOf([{ glosses: ['x'], form_of: [{ word: 'a' }], raw_tags: ['Obsolete'] }], 'b')).toBeNull();
  });

  it('rule "all": the lemma comes from the first STANDARD sense; rule "any": one bad sense is enough to drop', () => {
    const senses = [formOf('rin', ['form-of', 'dialectal']), formOf('run', ['form-of', 'past'])];
    expect(deriveLemmaOf(senses, 'ran', 'all')).toBe('run');
    expect(deriveLemmaOf(senses, 'ran', 'any')).toBeNull();
  });

  it('never returns the word itself', () => {
    expect(deriveLemmaOf([formOf('RUN')], 'run')).toBeNull();
  });

  it('ignores empty / malformed form_of entries', () => {
    expect(deriveLemmaOf([{ glosses: ['x'], form_of: [{}] }], 'x')).toBeNull();
    expect(deriveLemmaOf([{ glosses: ['x'], form_of: [{ word: '  ' }] }], 'x')).toBeNull();
  });
});

describe('truncation and limits', () => {
  it('etymology_text is cut to 1000 characters', () => {
    const r = reduceEntry(enRow('big', { etymology_text: 'e'.repeat(5000) }))!;
    expect(r.data.etymology_text).toHaveLength(LIMITS.etymologyText);
  });

  it('glosses and examples are cut to 250 characters; at most 2 examples per sense', () => {
    const r = reduceEntry(
      enRow('big', {
        senses: [
          {
            glosses: ['g'.repeat(900)],
            examples: [{ text: 't'.repeat(900), translation: 'x'.repeat(900) }, { text: 'second' }, { text: 'third' }, { text: '' }],
          },
        ],
      })
    )!;
    const sense = r.data.senses[0];
    expect(sense.glosses![0]).toHaveLength(250);
    expect(sense.examples).toHaveLength(2);
    expect(sense.examples![0].text).toHaveLength(250);
    expect(sense.examples![0].translation).toHaveLength(250);
    expect(sense.examples![1]).toEqual({ text: 'second' });
  });

  it('at most 8 senses, but lemma_of still looks at ALL of them', () => {
    const formSense = (n: number) => ({ glosses: [`g${n}`], tags: ['form-of'], form_of: [{ word: 'base' }] });
    const many = Array.from({ length: 12 }, (_, i) => formSense(i));
    const r = reduceEntry(enRow('bases', { senses: many }))!;
    expect(r.data.senses).toHaveLength(8);
    expect(r.lemma_of).toBe('base');
    // a plain sense hiding in position 11 must still stop the row from being a form
    const hidden = [...many.slice(0, 10), { glosses: ['a real word'] }];
    expect(reduceEntry(enRow('bases', { senses: hidden }))!.lemma_of).toBeNull();
  });

  it('sense synonyms / antonyms: words only, at most 8, de-duplicated', () => {
    const syn = Array.from({ length: 20 }, (_, i) => ({ word: `w${i % 12}`, sense: 'ignored' }));
    const r = reduceEntry(enRow('big', { senses: [{ glosses: ['x'], synonyms: syn, antonyms: [{ word: 'small' }] }] }))!;
    expect(r.data.senses[0].synonyms).toHaveLength(8);
    expect(new Set(r.data.senses[0].synonyms).size).toBe(8);
    expect(r.data.senses[0].antonyms).toEqual(['small']);
  });

  it('forms: table markers and "-" placeholders removed, repeats collapsed, at most 20', () => {
    const forms = [
      { form: 'runs', tags: ['present', 'third-person'] },
      { form: 'no-table-tags', source: 'conjugation', tags: ['table-tags'] },
      { form: 'glossary', tags: ['inflection-template'] },
      { form: 'x', tags: ['class'] },
      { form: '-', tags: ['imperative'] },
      { form: 'runs', tags: ['third-person', 'present'] }, // same form, same tags in another order
      ...Array.from({ length: 40 }, (_, i) => ({ form: `f${i}`, tags: ['past'] })),
    ];
    const out = reduceForms(forms);
    expect(out[0]).toEqual({ form: 'runs', tags: ['present', 'third-person'] });
    expect(out.map((f) => f.form)).not.toEqual(expect.arrayContaining(['no-table-tags', 'glossary', 'x', '-']));
    expect(out.filter((f) => f.form === 'runs')).toHaveLength(1);
    expect(out).toHaveLength(LIMITS.forms);
  });

  it('sounds: at most 8, and a flood of ipa entries cannot push the recordings out', () => {
    const ipa = Array.from({ length: 12 }, (_, i) => ({ ipa: `/ipa${i}/`, tags: ['US'] }));
    const audio = [{ audio: 'en-us-x.ogg', tags: ['US'], ogg_url: 'https://a/x.ogg', mp3_url: 'https://a/x.mp3' }];
    const out = reduceSounds([...ipa, ...audio]);
    expect(out).toHaveLength(LIMITS.sounds);
    expect(out.some((s) => s.mp3_url)).toBe(true);
    expect(out.filter((s) => s.ipa).length).toBeGreaterThanOrEqual(LIMITS.soundsPerKind);
    expect(out.indexOf(out.find((s) => s.ipa)!)).toBe(0); // original order kept
  });

  it('sounds: entries with nothing usable (rhymes, homophones, notes) are dropped', () => {
    expect(reduceSounds([{ rhymes: '-ʌn' }, { homophone: 'x' }, { note: 'n' }, { ipa: '/a/' }])).toEqual([{ ipa: '/a/' }]);
  });

  it('head_templates: at most 2, expansion cut to 200', () => {
    const r = reduceEntry(enRow('big', { head_templates: [1, 2, 3].map((n) => ({ name: `t${n}`, args: { 1: 'x' }, expansion: 'e'.repeat(500) })) }))!;
    expect(r.data.head_templates).toHaveLength(2);
    expect(r.data.head_templates![0]).toEqual({ name: 't1', expansion: 'e'.repeat(200) });
    expect(r.data.head_templates![0]).not.toHaveProperty('args');
  });

  it('derived / related: at most 20 words, top-level synonyms / antonyms at most 8', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => ({ word: `w${i}`, source: 'Thesaurus:x', sense: 's' }));
    const r = reduceEntry(enRow('big', { derived: list(50), related: list(50), synonyms: list(50), antonyms: list(50) }))!;
    expect(r.data.derived).toHaveLength(20);
    expect(r.data.related).toHaveLength(20);
    expect(r.data.synonyms).toHaveLength(8);
    expect(r.data.antonyms).toHaveLength(8);
  });

  it('cut() never splits a surrogate pair', () => {
    const s = 'a' + '😀'.repeat(10); // each emoji is two UTF-16 units
    const out = cut(s, 4)!; // 'a' + one emoji (2 units) + half of the next
    expect(out).toBe('a😀');
    expect(Array.from(out).every((c) => c.length === 1 || c.codePointAt(0)! > 0xffff)).toBe(true);
  });

  it('copes with missing / odd fields instead of throwing', () => {
    expect(reduceEntry({ word: 'x', pos: 'noun' })!.data.senses).toEqual([]);
    expect(reduceEntry({ word: 'x', pos: 'noun', senses: 'nope', forms: 7, sounds: {}, head_templates: 'z', derived: 3 })).not.toBeNull();
    expect(reduceEntry({ word: '  ', pos: 'noun' })).toBeNull();
    expect(reduceEntry({ word: 'x' })).toBeNull();
    expect(reduceEntry(null)).toBeNull();
  });
});

describe('pre-filter and line parsing', () => {
  it('the marker is the dump\'s exact serialization, with the space after the colon', () => {
    expect(EN_MARKER).toBe('"lang_code": "en"');
    expect(isEnglishCandidate(dumpLine(enRow('run')))).toBe(true);
    expect(isEnglishCandidate(JSON.stringify(enRow('run')))).toBe(false); // compact JSON is NOT what the dump uses
  });

  it('other languages are rejected before any JSON.parse', () => {
    const fr = dumpLine({ word: 'courir', pos: 'verb', lang: 'French', lang_code: 'fr', senses: [] });
    expect(isEnglishCandidate(fr)).toBe(false);
    expect(parseDumpLine(fr)).toEqual({ kind: 'skip' });
  });

  it('a nested lang_code "en" in another language passes the cheap test but is skipped after parsing', () => {
    const latin = dumpLine({ word: 'currere', pos: 'verb', lang_code: 'la', descendants: [{ lang_code: 'en', word: 'current' }] });
    expect(isEnglishCandidate(latin)).toBe(true);
    expect(parseDumpLine(latin)).toEqual({ kind: 'skip' });
  });

  it('English rows are parsed; broken JSON is reported as bad, never thrown', () => {
    expect(parseDumpLine(dumpLine(enRow('run')))).toMatchObject({ kind: 'english', raw: { word: 'run' } });
    expect(parseDumpLine('{"word": "run", "lang_code": "en", "senses": [')).toEqual({ kind: 'bad' });
    expect(parseDumpLine('')).toEqual({ kind: 'skip' });
  });

  it('never misses an English row, whatever the key order', () => {
    for (const raw of sampleRows()) {
      const reordered = Object.fromEntries(Object.entries(raw).reverse());
      expect(parseDumpLine(dumpLine(reordered)).kind).toBe('english');
    }
  });
});
