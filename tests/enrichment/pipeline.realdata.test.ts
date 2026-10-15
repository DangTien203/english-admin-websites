/**
 * The pipeline's decisions on the REAL reference data (ref_wiktionary_en / ref_word_frequency in the database of .env).
 * Read-only: Free Dictionary, Datamuse and Claude Haiku are fakes (Haiku throws if the branch must not call it), findExisting
 * is blind (so the result does not depend on which words the dictionary already holds) and nothing is written.
 */
import { isDraftSuccess, type DraftSuccess } from '../../services/enrichment/draft';
import type { Draft } from '../../services/enrichment/haiku/schema';
import { runPipeline, type PipelineDeps } from '../../services/enrichment/pipeline';
import { collectSources } from '../../services/enrichment/sources';
import { getRefDb } from '../../services/lookup/refDb';
import { makeDraft, makeSense } from './fixtures';

jest.setTimeout(60_000);

const TOPICS = new Map<string, string>([['sports_recreation', 'tag-sports']]);
const fdLookup = jest.fn(async (_word: string): Promise<any> => ({ found: false }));
const haikuWords: string[] = [];
const collected: string[] = [];

const draftFor = (word: string): Draft =>
  makeDraft({ headword: word, lemma: word, topics: ['sports_recreation'], senses: [makeSense({ pos: 'verb', definition_en: 'to move fast on foot', meanings_vi: ['chạy', 'chạy bộ'] })] });

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    ensureTopics: async () => TOPICS,
    publishPolicy: () => 'review',
    findExisting: async () => null,
    collectSources: async (word, { signal }) => {
      collected.push(word);
      return collectSources(word, { refDb: getRefDb(), freeDictionary: { lookup: fdLookup }, datamuse: { relations: async () => ({ synonyms: [], antonyms: [] }) }, signal });
    },
    generateDraft: async (bundle) => {
      haikuWords.push(bundle.word);
      const ok: DraftSuccess = { ok: true, draft: draftFor(bundle.word), usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, calls: 1 }, repaired: false, firstIssues: [], model: 'test-model', requestIds: [], callMs: [1] };
      return ok;
    },
    persist: async () => {
      throw new Error('this test never writes');
    },
    linkForm: async () => {
      throw new Error('this test never writes');
    },
    ...over,
  };
}

const job = (word: string) => ({ word, requestedBy: null, ebookId: null, jobRowId: 'realdata-job', attempt: 1 });

beforeEach(() => {
  fdLookup.mockClear();
  haikuWords.length = 0;
  collected.length = 0;
});

describe('real Wiktionary data', () => {
  it('the table is loaded (otherwise the cases below mean nothing)', async () => {
    const { rows } = await getRefDb().query('SELECT count(*)::int AS n FROM ref_wiktionary_en');
    expect(rows[0].n).toBeGreaterThan(100_000);
  });

  it('ran → the entry to write is for the LEMMA "run": one plain word, never "royal australian navy" or "radio access network"', async () => {
    const report = await runPipeline(job('ran'), deps(), { dryRun: true });

    expect(collected).toEqual(['ran', 'run']); // S1 for the word, then S1 again for the lemma
    expect(haikuWords).toEqual(['run']); // Haiku is asked about the lemma, never about "ran"
    expect(report.formLink).toEqual({ form: 'ran', type: 'past_simple', lemma: 'run' });

    const lemma = report.assembled!.lemma;
    expect(lemma).toMatch(/^[a-z]+$/);
    expect(lemma).toBe('run');
    expect(lemma).not.toBe('royal australian navy');
    expect(lemma).not.toBe('radio access network');
    expect(report.assembled!.headword).toBe('run');

    // the bundle behind the draft is the lemma's own: rows of "run" (with a verb among them), the lemma's frequency, no foreign sense
    expect(report.bundle!.word).toBe('run');
    expect(report.bundle!.wiktionaryRows.every((r) => r.word === 'run')).toBe(true);
    expect(report.bundle!.wiktionaryRows.some((r) => r.pos === 'verb')).toBe(true);
    expect(report.assembled!.frequencyRank).toBe(report.bundle!.frequency!.rank);
    expect(fdLookup).not.toHaveBeenCalled(); // Wiktionary knows both words: Free Dictionary is not asked

    // Wiktionary's own forms of "run" are written with the entry: ran as the simple past, running as the present participle
    const forms = report.assembled!.forms.map((f) => `${f.formValue}:${f.formType}`);
    expect(forms).toContain('ran:past_simple');
    expect(forms).toContain('running:present_participle');
    expect(forms).toContain('runs:third_person_singular');
    expect(forms).not.toContain('run:past_participle'); // equal to the lemma
  });

  it('went → an inflection of go (simple past): the lemma "go" is enriched', async () => {
    const report = await runPipeline(job('went'), deps(), { dryRun: true });
    expect(report.formLink).toEqual({ form: 'went', type: 'past_simple', lemma: 'go' });
    expect(collected).toEqual(['went', 'go']);
    expect(haikuWords).toEqual(['go']);
    expect(report.assembled!.lemma).toBe('go');
  });

  it('running → Wiktionary also lists noun / adjective / adverb senses of its own, so it is a word in its own right (no form link). Once "run" exists it is found through the word_forms of run at S0 instead', async () => {
    const report = await runPipeline(job('running'), deps(), { dryRun: true });
    expect(report.bundle!.flags.onlyFormRows).toBe(false);
    expect(report.formLink).toBeUndefined();
    expect(collected).toEqual(['running']);
    expect(haikuWords).toEqual(['running']);
  });

  it('recieve → every row is a misspelling: skipped / variant_form, and Haiku is NOT called', async () => {
    const report = await runPipeline(job('recieve'), deps({ generateDraft: async () => { throw new Error('Haiku must not be called'); } }));
    expect(report.outcome).toMatchObject({ status: 'skipped', reason: 'variant_form' });
    expect(report.bundle!.flags.onlyVariantRows).toBe(true);
    expect(report.bundle!.variantTargets).toEqual(['receive']);
    expect(fdLookup).not.toHaveBeenCalled();
  });

  it('a string no source knows → rejected / unknown_word, and Haiku is NOT called', async () => {
    const word = 'qzqxkcdnotawordqzq';
    const report = await runPipeline(job(word), deps({ generateDraft: async () => { throw new Error('Haiku must not be called'); } }));
    expect(report.outcome).toMatchObject({ status: 'rejected', reason: 'unknown_word' });
    expect(fdLookup).toHaveBeenCalledWith(word, expect.anything()); // Wiktionary had nothing, so Free Dictionary (here a fake 404) was asked
  });

  it('a Free Dictionary outage on a word Wiktionary does not know is thrown, so pg-boss retries (it is not "unknown_word")', async () => {
    const { UpstreamUnavailable } = await import('../../services/upstream/errors');
    fdLookup.mockRejectedValueOnce(new UpstreamUnavailable('free_dictionary', 'timeout'));
    await expect(runPipeline(job('qzqxkcdoutageqzq'), deps())).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(haikuWords).toEqual([]);
  });

  it('serendipity → a plain word: enriched as itself, IPA / audio / etymology come from the real row', async () => {
    const report = await runPipeline(job('serendipity'), deps(), { dryRun: true });
    expect(report.outcome).toMatchObject({ status: 'succeeded', reason: 'dry_run' });
    expect(report.formLink).toBeUndefined();
    expect(collected).toEqual(['serendipity']);
    expect(isDraftSuccess(report.draft!)).toBe(true);
    const e = report.assembled!;
    expect([e.headword, e.lemma]).toEqual(['serendipity', 'serendipity']);
    expect(e.frequencyRank).toBeGreaterThan(0);
    for (const ipa of [e.ipaUs, e.ipaUk]) if (ipa) expect(ipa).toMatch(/^\/[^/[\]]+\/$/);
    for (const url of [e.audioUsUrl, e.audioUkUrl]) if (url) expect(url).toMatch(/^https?:\/\//);
  });
});
