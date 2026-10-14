import { reduceEntry } from '../../scripts/refdata/lib/wiktionary';
import { inferFormType, resolveViaForms, tagsForLemma } from '../../services/lookup/localLookup';
import type { Db } from '../../services/lookup/types';
import { sampleRow, sampleRows } from './helpers';

/** The ref table as the importer would store it: every sample row, reduced. */
const storedRows = sampleRows().map((raw) => reduceEntry(raw)!);

const refDb: Db = {
  async query(sql: string, params: any[] = []) {
    expect(sql).toContain('FROM ref_wiktionary_en WHERE word = $1 AND lemma_of IS NOT NULL');
    return { rows: storedRows.filter((r) => r.word === params[0] && r.lemma_of !== null).map((r) => ({ lemma_of: r.lemma_of, data: r.data })) };
  },
};

/** A dictionary that has every lemma, so only the reference data decides the outcome. */
const dictionaryWithEveryLemma: Db = {
  async query(_sql: string, params: any[] = []) {
    return { rows: [{ id: `entry-${params[0]}`, headword: params[0], lemma: params[0], word_forms: [] }] };
  },
};

describe('resolveViaForms on the real reference rows', () => {
  it.each([
    ['ran', 'run', 'past_simple'], // NOT past_participle: one of its senses is a nonstandard "past participle of run"
    ['children', 'child', 'plural'],
    ['running', 'run', 'present_participle'],
  ])('%s → lemma %s, form type %s', async (word, lemma, formType) => {
    const hit = await resolveViaForms(dictionaryWithEveryLemma, refDb, word);
    expect(hit).toMatchObject({ lemma, matchedForm: word, formType, entry: { id: `entry-${lemma}` } });
  });

  it('recieve (a misspelling) is never resolved, so it can never reach word_forms', async () => {
    expect(await resolveViaForms(dictionaryWithEveryLemma, refDb, 'recieve')).toBeNull();
  });

  it('words with no form row and unknown words resolve to nothing', async () => {
    for (const word of ['ubiquitous', 'taxi', 'London'.toLowerCase(), 'asdfghjk']) {
      expect(await resolveViaForms(dictionaryWithEveryLemma, refDb, word)).toBeNull();
    }
  });

  it('the lemma must be a published dictionary entry; otherwise the lookup falls through', async () => {
    const emptyDictionary: Db = { query: async () => ({ rows: [] }) };
    expect(await resolveViaForms(emptyDictionary, refDb, 'ran')).toBeNull();
  });
});

describe('tagsForLemma', () => {
  const ran = reduceEntry(sampleRow('ran', 'verb'))!.data;

  it('takes the tags of the first STANDARD sense that points to the lemma', () => {
    expect(tagsForLemma(ran, 'run')).toEqual(['form-of', 'past']);
    expect(inferFormType(tagsForLemma(ran, 'run'))).toBe('past_simple');
  });

  it('the union of all sense tags would have been wrong (this is the bug that was fixed)', () => {
    const union = ran.senses.flatMap((s) => s.tags ?? []);
    expect(inferFormType(union)).toBe('past_participle'); // what the old code computed for "ran"
  });

  it('a lemma that no sense points to falls back to the row tags, then to nothing', () => {
    expect(tagsForLemma(ran, 'walk')).toEqual([]);
    expect(tagsForLemma({ tags: ['plural'], senses: [] }, 'x')).toEqual(['plural']);
    expect(tagsForLemma(null, 'x')).toEqual([]);
  });

  it('prefers a standard sense over a non-standard one pointing to the same lemma', () => {
    const data = {
      senses: [
        { form_of: [{ word: 'run' }], tags: ['form-of', 'nonstandard', 'participle', 'past'] },
        { form_of: [{ word: 'run' }], tags: ['form-of', 'past'] },
      ],
    };
    expect(tagsForLemma(data, 'run')).toEqual(['form-of', 'past']);
  });

  it('falls back to the non-standard sense when it is the only one', () => {
    const data = { senses: [{ form_of: [{ word: 'run' }], tags: ['form-of', 'dialectal', 'past'] }] };
    expect(tagsForLemma(data, 'run')).toEqual(['form-of', 'dialectal', 'past']);
  });
});
