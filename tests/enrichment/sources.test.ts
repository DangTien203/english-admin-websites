import { analyzeRows } from '../../services/enrichment/sources/wiktionary';
import { collectSources, haikuSkipReason, type SourceDeps } from '../../services/enrichment/sources';
import type { WiktionaryRow } from '../../services/enrichment/types';
import { UpstreamUnavailable } from '../../services/upstream/errors';
import { wrow } from './fixtures';

// ── rows modelled on the real ones (docs/lookup-refdata.md §5, checked against ref_wiktionary_en) ──

const RAN: WiktionaryRow[] = [
  wrow({ id: 6396, word: 'ran', pos: 'verb', etymology_number: 1, lemma_of: 'run', senses: [
    { glosses: ['simple past of run'], tags: ['form-of', 'past'], form_of: [{ word: 'run' }] },
    { glosses: ['simple past of rin'], tags: ['form-of', 'past'], form_of: [{ word: 'rin' }] },
    { glosses: ['past participle of run'], tags: ['colloquial', 'form-of', 'nonstandard', 'participle', 'past'], form_of: [{ word: 'run' }] },
  ] }),
  wrow({ id: 6397, word: 'ran', pos: 'noun', etymology_number: 2, senses: [{ glosses: ['Yarns coiled on a spun-yarn winch.'], tags: ['uncountable'] }] }),
  wrow({ id: 125480, word: 'ran', written: 'RAN', pos: 'name', lemma_of: 'royal australian navy', senses: [{ glosses: ['Initialism of Royal Australian Navy'], tags: ['Australia', 'abbreviation', 'alt-of', 'initialism'], alt_of: [{ word: 'Royal Australian Navy' }] }] }),
  wrow({ id: 125481, word: 'ran', written: 'RAN', pos: 'noun', lemma_of: 'radio access network', senses: [{ glosses: ['Initialism of radio access network'], tags: ['abbreviation', 'alt-of', 'initialism', 'uncountable'], alt_of: [{ word: 'radio access network' }] }] }),
  wrow({ id: 135807, word: 'ran', written: 'Ran', pos: 'name', senses: [{ glosses: ['A male given name from Hebrew.'] }] }),
];
const RUN_LEMMA: WiktionaryRow[] = [
  wrow({ id: 1, word: 'run', pos: 'verb', senses: [{ glosses: ['To move quickly on foot.'], tags: [] }] }),
  wrow({ id: 2, word: 'run', pos: 'noun', senses: [{ glosses: ['An act of running.'], tags: [] }] }),
];
const RECIEVE = [wrow({ id: 143691, word: 'recieve', pos: 'verb', senses: [{ glosses: ['Misspelling of receive.'], tags: ['alt-of', 'misspelling'], alt_of: [{ word: 'receive' }] }] })];
const LONDON = [wrow({ id: 9639, word: 'london', written: 'London', pos: 'name', senses: [{ glosses: ['The capital city of the United Kingdom.'], tags: ['countable', 'uncountable'] }] })];
const SAW = [
  wrow({ id: 1, word: 'saw', pos: 'noun', etymology_number: 1, senses: [{ glosses: ['A tool for cutting.'] }, { glosses: ['A saying.'] }] }),
  wrow({ id: 2, word: 'saw', pos: 'verb', etymology_number: 1, senses: [{ glosses: ['To cut with a saw.'] }] }),
  wrow({ id: 3, word: 'saw', pos: 'verb', etymology_number: 3, lemma_of: 'see', senses: [{ glosses: ['simple past of see'], tags: ['form-of', 'past'], form_of: [{ word: 'see' }] }] }),
];
const UBIQUITOUS = [wrow({ id: 5, word: 'ubiquitous', pos: 'adj', senses: [{ glosses: ['Being everywhere.'], tags: [] }] })];

describe('analyzeRows', () => {
  it('ran: a pure form of run — the abbreviation rows RAN never give the lemma', () => {
    const a = analyzeRows('ran', RAN);
    expect(a.onlyFormRows).toBe(true);
    expect(a.formLemmas).toEqual(['run']);
    expect(a.formLemmas).not.toContain('royal australian navy');
    expect(a.formLemmas).not.toContain('radio access network');
    expect(a.onlyVariantRows).toBe(false);
    expect(a.onlyProperNounRows).toBe(false);
  });

  it('ran: the lone noun sense (yarns) is tolerated as a stray, and reported', () => {
    const a = analyzeRows('ran', RAN);
    expect(a.independentRows).toHaveLength(1);
    expect(a.independentSenseCount).toBe(1);
    expect(a.strayRows).toBe(1);
  });

  it('saw: two independent senses make it a real word too, not a pure form', () => {
    const a = analyzeRows('saw', SAW);
    expect(a.formLemmas).toEqual(['see']);
    expect(a.independentSenseCount).toBe(3);
    expect(a.onlyFormRows).toBe(false);
  });

  it('recieve: a misspelling, with its target', () => {
    const a = analyzeRows('recieve', RECIEVE);
    expect(a.onlyVariantRows).toBe(true);
    expect(a.variantTargets).toEqual(['receive']);
    expect(a.onlyFormRows).toBe(false);
  });

  it('london: only a proper-noun row (stored under data.word "London")', () => {
    const a = analyzeRows('london', LONDON);
    expect(a.primaryRows).toHaveLength(0);
    expect(a.onlyProperNounRows).toBe(true);
    expect(a.onlyFormRows).toBe(false);
    expect(a.onlyVariantRows).toBe(false);
  });

  it('a normal word has no flag', () => {
    const a = analyzeRows('ubiquitous', UBIQUITOUS);
    expect([a.onlyFormRows, a.onlyVariantRows, a.onlyProperNounRows]).toEqual([false, false, false]);
    expect(a.independentRows).toHaveLength(1);
  });

  it('a row whose lemma is a phrase is not a form', () => {
    const a = analyzeRows('x', [wrow({ word: 'x', pos: 'noun', lemma_of: 'two words', senses: [{ glosses: ['g'], form_of: [{ word: 'two words' }] }] })]);
    expect(a.formRows).toHaveLength(0);
  });

  it('every non-standard tag counts: obsolete, archaic, nonstandard, dialectal, rare, proscribed', () => {
    for (const tag of ['obsolete', 'archaic', 'nonstandard', 'dialectal', 'rare', 'proscribed', 'misspelling']) {
      expect(analyzeRows('x', [wrow({ word: 'x', pos: 'adj', senses: [{ glosses: ['g'], tags: [tag] }] })]).onlyVariantRows).toBe(true);
    }
  });

  it('one standard sense next to a misspelling sense is not a variant row', () => {
    const a = analyzeRows('x', [wrow({ word: 'x', pos: 'adj', senses: [{ glosses: ['g'], tags: [] }, { glosses: ['h'], tags: ['rare'] }] })]);
    expect(a.onlyVariantRows).toBe(false);
  });

  it('no rows: nothing is claimed', () => {
    const a = analyzeRows('zzz', []);
    expect([a.onlyFormRows, a.onlyVariantRows, a.onlyProperNounRows]).toEqual([false, false, false]);
  });
});

// ── collectSources with fake databases and clients ──

interface FakeWorld {
  rows?: Record<string, WiktionaryRow[]>;
  freq?: Record<string, { zipf: number; rank: number }>;
  failWiktionary?: boolean;
  failFrequency?: boolean;
}

function deps(world: FakeWorld, over: Partial<SourceDeps> = {}) {
  const sql: string[] = [];
  const refDb = {
    query: jest.fn(async (text: string, params: any[] = []) => {
      sql.push(text);
      if (text.includes('FROM ref_wiktionary_en')) {
        if (world.failWiktionary) throw new Error('relation "ref_wiktionary_en" does not exist');
        return { rows: world.rows?.[params[0]] ?? [] };
      }
      if (text.includes('FROM ref_word_frequency')) {
        if (world.failFrequency) throw new Error('boom');
        const f = world.freq?.[params[0]];
        return { rows: f ? [f] : [] };
      }
      throw new Error('unexpected SQL ' + text);
    }),
  };
  const lookup = jest.fn(async (_w: string, _o?: any): Promise<any> => ({ found: false }));
  const relations = jest.fn(async (_w: string, _o?: any) => ({ synonyms: ['a'], antonyms: ['b'] }));
  return { refDb, lookup, relations, sql, deps: { refDb, freeDictionary: { lookup }, datamuse: { relations }, ...over } as SourceDeps };
}

describe('collectSources', () => {
  it('ran: onlyFormRows, expectedLemma "run" with the lemma rows, and Free Dictionary is NOT asked', async () => {
    const d = deps({ rows: { ran: RAN, run: RUN_LEMMA }, freq: { ran: { zipf: 5, rank: 800 } } });
    const b = await collectSources('ran', d.deps);
    expect(b.flags).toEqual({ onlyFormRows: true, onlyVariantRows: false, onlyProperNounRows: false, noSourceRecognizesWord: false });
    expect(b.expectedLemma).toBe('run');
    expect(b.lemmaRows).toHaveLength(2);
    expect(b.strayRows).toBe(1);
    expect(b.freeDictionary).toEqual({ status: 'skipped' });
    expect(d.lookup).not.toHaveBeenCalled();
    expect(b.datamuse).toEqual({ synonyms: ['a'], antonyms: ['b'] });
    expect(b.frequency).toEqual({ zipf: 5, rank: 800 });
  });

  it('an ordinary word: expectedLemma is the word itself; no lemma rows are fetched', async () => {
    const d = deps({ rows: { ubiquitous: UBIQUITOUS } });
    const b = await collectSources('ubiquitous', d.deps);
    expect(b.expectedLemma).toBe('ubiquitous');
    expect(b.lemmaRows).toEqual([]);
    expect(d.sql.filter((s) => s.includes('ref_wiktionary_en'))).toHaveLength(1);
  });

  it('a mixed word (saw) keeps its own lemma but lists the form lemmas for the next stage', async () => {
    const b = await collectSources('saw', deps({ rows: { saw: SAW } }).deps);
    expect(b.expectedLemma).toBe('saw');
    expect(b.formLemmas).toEqual(['see']);
    expect(b.flags.onlyFormRows).toBe(false);
  });

  it('recieve: onlyVariantRows with its target; expectedLemma stays null', async () => {
    const b = await collectSources('recieve', deps({ rows: { recieve: RECIEVE } }).deps);
    expect(b.flags.onlyVariantRows).toBe(true);
    expect(b.variantTargets).toEqual(['receive']);
    expect(b.expectedLemma).toBeNull();
    expect(haikuSkipReason(b)).toBe('variant_form');
  });

  it('london: onlyProperNounRows (Haiku is still asked: the spec lets Haiku classify names)', async () => {
    const b = await collectSources('london', deps({ rows: { london: LONDON }, freq: { london: { zipf: 5.27, rank: 543 } } }).deps);
    expect(b.flags.onlyProperNounRows).toBe(true);
    expect(haikuSkipReason(b)).toBeNull();
  });

  it('a lemma that is only a name is not accepted (the form falls back to an ordinary word)', async () => {
    const form = wrow({ word: 'foos', pos: 'noun', lemma_of: 'foo', senses: [{ glosses: ['plural of foo'], tags: ['form-of', 'plural'], form_of: [{ word: 'foo' }] }] });
    const b = await collectSources('foos', deps({ rows: { foos: [form], foo: [wrow({ word: 'foo', written: 'Foo', pos: 'name' })] } }).deps);
    expect(b.flags.onlyFormRows).toBe(false);
    expect(b.expectedLemma).toBeNull();
  });

  describe('Free Dictionary — only when Wiktionary has nothing', () => {
    it('is asked for an unknown-to-Wiktionary word; found → in the bundle', async () => {
      const entry = { headword: 'zorp' } as any;
      const d = deps({});
      d.lookup.mockResolvedValueOnce({ found: true, entry });
      const b = await collectSources('zorp', d.deps);
      expect(d.lookup).toHaveBeenCalledTimes(1);
      expect(b.freeDictionary).toEqual({ status: 'found', entry });
      expect(b.flags.noSourceRecognizesWord).toBe(false);
    });

    it('404 is normal: not_found; with no frequency row either, no source recognizes the word', async () => {
      const b = await collectSources('asdfghjk', deps({}).deps);
      expect(b.freeDictionary).toEqual({ status: 'not_found' });
      expect(b.flags.noSourceRecognizesWord).toBe(true);
      expect(haikuSkipReason(b)).toBe('unknown_word');
    });

    it('404 but the word is in the frequency list: still recognized', async () => {
      const b = await collectSources('podcastx', deps({ freq: { podcastx: { zipf: 3, rank: 9000 } } }).deps);
      expect(b.flags.noSourceRecognizesWord).toBe(false);
    });

    it('a transient failure is rethrown as UpstreamUnavailable (pg-boss retries the job)', async () => {
      const d = deps({});
      const err = new UpstreamUnavailable('free_dictionary', 'http_5xx', { status: 522 });
      d.lookup.mockRejectedValueOnce(err);
      await expect(collectSources('zorp', d.deps)).rejects.toBe(err);
    });

    it('…unless the caller tolerates it (the CLI): kept in the bundle, and the word is NOT declared unknown', async () => {
      const d = deps({}, { tolerateFreeDictionaryError: true });
      d.lookup.mockRejectedValueOnce(new UpstreamUnavailable('free_dictionary', 'http_5xx', { status: 522 }));
      const b = await collectSources('asdfghjk', d.deps);
      expect(b.freeDictionary.status).toBe('error');
      expect(b.sourceErrors.free_dictionary).toBeDefined();
      expect(b.flags.noSourceRecognizesWord).toBe(false);
    });
  });

  describe('sources may be missing', () => {
    it('Datamuse failing changes nothing but the candidate lists', async () => {
      const d = deps({ rows: { ubiquitous: UBIQUITOUS } });
      d.relations.mockRejectedValueOnce(new Error('network'));
      const b = await collectSources('ubiquitous', d.deps);
      expect(b.datamuse).toBeNull();
      expect(b.sourceErrors.datamuse).toBe('network');
      expect(b.expectedLemma).toBe('ubiquitous');
    });

    it('a Wiktionary read error is tolerated (no rows) and blocks the "unknown word" verdict', async () => {
      const b = await collectSources('whatever', deps({ failWiktionary: true }).deps);
      expect(b.wiktionaryRows).toEqual([]);
      expect(b.sourceErrors.wiktionary).toMatch(/does not exist/);
      expect(b.flags.noSourceRecognizesWord).toBe(false);
    });

    it('a frequency read error is tolerated too', async () => {
      const b = await collectSources('ubiquitous', deps({ rows: { ubiquitous: UBIQUITOUS }, failFrequency: true }).deps);
      expect(b.frequency).toBeNull();
      expect(b.sourceErrors.frequency).toBe('boom');
    });

    it('a database that hangs is cut by the per-source timeout', async () => {
      const d = deps({});
      d.refDb.query.mockImplementation(() => new Promise(() => undefined));
      const b = await collectSources('slow', { ...d.deps, timeoutMs: 30 });
      expect(b.sourceErrors.wiktionary).toMatch(/timed out/);
      expect(b.sourceErrors.frequency).toMatch(/timed out/);
    });
  });

  it('reads the Wiktionary rows with the lowercase word as the key', async () => {
    const d = deps({ rows: { ubiquitous: UBIQUITOUS } });
    await collectSources('ubiquitous', d.deps);
    expect(d.refDb.query.mock.calls.find((c) => String(c[0]).includes('ref_wiktionary_en'))![1]).toEqual(['ubiquitous']);
  });
});
