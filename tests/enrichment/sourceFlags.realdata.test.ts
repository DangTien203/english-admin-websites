/**
 * Source flags on the REAL reference data loaded in ref_wiktionary_en / ref_word_frequency (read-only queries,
 * no Haiku, no network: Free Dictionary and Datamuse are fakes). Same database as the other suites.
 *
 * Stage S2 of the enrichment job (P6b) decides from these flags, so the cases below pin the facts it depends on.
 */
import { getRefDb } from '../../services/lookup/refDb';
import { collectSources, haikuSkipReason } from '../../services/enrichment/sources';
import { fetchWiktionaryRows } from '../../services/enrichment/sources/wiktionary';

jest.setTimeout(60_000);

const fdLookup = jest.fn(async (_word: string): Promise<any> => ({ found: false }));
const sources = (word: string) =>
  collectSources(word, {
    refDb: getRefDb(),
    freeDictionary: { lookup: fdLookup },
    datamuse: { relations: async () => ({ synonyms: [], antonyms: [] }) },
  });

beforeEach(() => fdLookup.mockClear());

describe('real Wiktionary data', () => {
  it('the table is loaded (otherwise every other case here is meaningless)', async () => {
    const { rows } = await getRefDb().query('SELECT count(*)::int AS n FROM ref_wiktionary_en');
    expect(rows[0].n).toBeGreaterThan(100_000);
  });

  it('recieve → onlyVariantRows (the misspelling tag is still in the data column; stage S2 depends on it)', async () => {
    const rows = await fetchWiktionaryRows(getRefDb(), 'recieve');
    const tags = rows.flatMap((r) => (r.data.senses ?? []).flatMap((s: any) => s.tags ?? []));
    expect(tags).toContain('misspelling');

    const b = await sources('recieve');
    expect(b.flags.onlyVariantRows).toBe(true);
    expect(b.variantTargets).toEqual(['receive']);
    expect(b.flags.onlyFormRows).toBe(false);
    expect(haikuSkipReason(b)).toBe('variant_form');
    expect(fdLookup).not.toHaveBeenCalled();
  });

  it('ran → onlyFormRows, expectedLemma "run" — never "royal australian navy" or "radio access network"', async () => {
    const b = await sources('ran');
    expect(b.flags.onlyFormRows).toBe(true);
    expect(b.expectedLemma).toBe('run');
    expect(b.expectedLemma).toMatch(/^[a-z]+$/); // a single word
    expect(b.formLemmas).toEqual(['run']);
    expect(b.expectedLemma).not.toBe('royal australian navy');
    expect(b.expectedLemma).not.toBe('radio access network');
    // the lemma rows are those of "run", with a verb among them
    expect(b.lemmaRows.length).toBeGreaterThan(0);
    expect(b.lemmaRows.every((r) => r.word === 'run')).toBe(true);
    expect(b.lemmaRows.some((r) => r.pos === 'verb')).toBe(true);
    expect(b.flags.noSourceRecognizesWord).toBe(false);
    expect(fdLookup).not.toHaveBeenCalled();
  });

  it('run → a real word of its own (its verb/noun/adj rows are not forms); expectedLemma is "run"', async () => {
    const b = await sources('run');
    expect(b.flags.onlyFormRows).toBe(false);
    expect(b.flags.onlyVariantRows).toBe(false);
    expect(b.expectedLemma).toBe('run');
  });

  it('london → only a proper-noun row', async () => {
    const b = await sources('london');
    expect(b.flags.onlyProperNounRows).toBe(true);
    expect(b.flags.onlyFormRows).toBe(false);
    expect(b.expectedLemma).toBeNull();
  });

  it.each(['serendipity', 'ubiquitous', 'ephemeral', 'podcast', 'quarantine', 'karaoke', 'light', 'bank'])('%s → an ordinary word with its own rows, a frequency, no special flag', async (word) => {
    const b = await sources(word);
    expect(b.wiktionaryRows.length).toBeGreaterThan(0);
    expect(b.frequency).not.toBeNull();
    expect(b.flags).toEqual({ onlyFormRows: false, onlyVariantRows: false, onlyProperNounRows: false, noSourceRecognizesWord: false });
    expect(b.expectedLemma).toBe(word);
    expect(b.freeDictionary).toEqual({ status: 'skipped' });
    expect(fdLookup).not.toHaveBeenCalled();
  });

  it('asdfghjk → no source recognizes it (Free Dictionary fake answers 404)', async () => {
    const b = await sources('asdfghjk');
    expect(b.wiktionaryRows).toEqual([]);
    expect(b.frequency).toBeNull();
    expect(fdLookup).toHaveBeenCalledWith('asdfghjk', expect.anything());
    expect(b.flags.noSourceRecognizesWord).toBe(true);
    expect(haikuSkipReason(b)).toBe('unknown_word');
  });

  it('inflected forms of common verbs resolve to their lemma', async () => {
    for (const [form, lemma] of [['running', 'run'], ['children', 'child'], ['went', 'go']] as const) {
      const b = await sources(form);
      expect(b.formLemmas).toContain(lemma);
    }
  });
});
