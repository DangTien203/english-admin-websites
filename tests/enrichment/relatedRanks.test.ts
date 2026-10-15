import { collectSources } from '../../services/enrichment/sources';
import { fetchRanks } from '../../services/enrichment/sources/frequency';
import { wrow } from './fixtures';

const serendipity = wrow({
  id: 1,
  word: 'serendipity',
  pos: 'noun',
  senses: [{ glosses: ['finding something by chance'], synonyms: [{ word: 'casualty' }, { word: 'hap' }, { word: "murphy's law" }, { word: 'luck' }], antonyms: [{ word: 'misfortune' }] }],
});

/** A reference database with a few words in the frequency list. */
function refDb(over: { failRanks?: boolean } = {}) {
  const rankQueries: string[][] = [];
  const known: Record<string, number> = { casualty: 9500, luck: 1900, misfortune: 14000, serendipity: 40016 };
  const db = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM ref_wiktionary_en')) return { rows: params[0] === 'serendipity' ? [serendipity] : [] };
      if (sql.includes('ANY($1::text[])')) {
        if (over.failRanks) throw new Error('boom');
        rankQueries.push(params[0]);
        return { rows: (params[0] as string[]).filter((w) => w in known).map((word) => ({ word, rank: known[word] })) };
      }
      if (sql.includes('FROM ref_word_frequency')) return { rows: params[0] in known ? [{ zipf: 2.74, rank: known[params[0]] }] : [] };
      throw new Error('unexpected SQL ' + sql);
    }),
  };
  return { db, rankQueries };
}

const deps = (db: any) => ({
  refDb: db,
  freeDictionary: { lookup: async () => ({ found: false }) as any },
  datamuse: { relations: async () => ({ synonyms: [], antonyms: [] }) },
});

describe('fetchRanks', () => {
  it('returns the rank of the words that are in the list and nothing for the others, in ONE query', async () => {
    const { db } = refDb();
    await expect(fetchRanks(db, ['luck', 'hap', 'luck', 'casualty'])).resolves.toEqual({ luck: 1900, casualty: 9500 });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('does not query for an empty list', async () => {
    const { db } = refDb();
    await expect(fetchRanks(db, [])).resolves.toEqual({});
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('collectSources: relatedRanks', () => {
  it('looks up the plain single-word synonyms and antonyms the rows list (never the phrases) with one extra query', async () => {
    const { db, rankQueries } = refDb();
    const b = await collectSources('serendipity', deps(db));
    expect(rankQueries).toHaveLength(1);
    expect([...rankQueries[0]].sort()).toEqual(['casualty', 'hap', 'luck', 'misfortune']); // "murphy's law" is not even looked up
    expect(b.relatedRanks).toEqual({ casualty: 9500, luck: 1900, misfortune: 14000 }); // hap is not in the list
    expect(b.timingsMs.related_ranks).toBeGreaterThanOrEqual(0);
  });

  it('no Wiktionary rows → no extra query, empty ranks', async () => {
    const { db, rankQueries } = refDb();
    const b = await collectSources('zorp', deps(db));
    expect(rankQueries).toHaveLength(0);
    expect(b.relatedRanks).toEqual({});
  });

  it('a failing ranks query is tolerated: empty ranks, the error is kept, the rest of the bundle is intact', async () => {
    const { db } = refDb({ failRanks: true });
    const b = await collectSources('serendipity', deps(db));
    expect(b.relatedRanks).toEqual({});
    expect(b.sourceErrors.related_ranks).toBe('boom');
    expect(b.wiktionaryRows).toHaveLength(1);
    expect(b.flags.noSourceRecognizesWord).toBe(false);
  });
});
