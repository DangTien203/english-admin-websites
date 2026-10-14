import { runImport, RowWriter } from '../../scripts/refdata/import-wiktionary';
import { BATCH_SIZE as WORDFREQ_BATCH_SIZE, parseWordFreqLine, upsertBatch } from '../../scripts/refdata/import-wordfreq';
import type { ReducedRow } from '../../scripts/refdata/lib/wiktionary';
import { dumpLine, enRow, makeGz } from './helpers';

const RANKS = new Map<string, number>([
  ['run', 100],
  ['ran', 200],
  ['london', 5_000],
]);

const french = dumpLine({ word: 'courir', pos: 'verb', lang: 'French', lang_code: 'fr', senses: [{ glosses: ['to run'] }] });
const latinWithEnglishDescendant = dumpLine({ word: 'currere', pos: 'verb', lang_code: 'la', descendants: [{ lang_code: 'en', word: 'current' }], senses: [] });
const run = dumpLine(enRow('run', { pos: 'verb' }));
const ran = dumpLine(
  enRow('ran', { pos: 'verb', etymology_number: '1', senses: [{ glosses: ['simple past of run'], tags: ['form-of', 'past'], form_of: [{ word: 'run' }] }] })
);
const london = dumpLine(enRow('London', { pos: 'name' }));
const notTopN = dumpLine(enRow('zzyzx'));
const noPos = dumpLine({ word: 'run', lang_code: 'en', senses: [] });
const brokenJson = '{"word": "run", "lang_code": "en", "senses": [';

// 9 lines: 2 French, 1 Latin (nested "en"), 1 broken JSON, 1 without pos, 1 outside the top-N, 3 to keep
const FIXTURE = [french, run, latinWithEnglishDescendant, ran, notTopN, brokenJson, london, noPos, french];

function collector(delayMs = 0) {
  const batches: ReducedRow[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const writer: RowWriter = {
    async writeBatch(rows) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      batches.push(rows);
      inFlight--;
    },
  };
  return { writer, batches, maxInFlight: () => maxInFlight };
}

describe('runImport on a small .gz built inside the test', () => {
  let gz: { file: string; cleanup: () => void };
  beforeAll(() => (gz = makeGz(FIXTURE)));
  afterAll(() => gz.cleanup());

  it('--dry-run applies every filter and counts everything, without writing', async () => {
    const stats = await runImport({ file: gz.file, wordRanks: RANKS, writer: null });
    expect(stats).toMatchObject({
      linesRead: 9,
      prefilterPass: 7, // everything containing the marker, including the Latin row and the broken line
      badLines: 1,
      englishRows: 5,
      missingWordOrPos: 1,
      notInTopN: 1,
      kept: 3,
      written: 0, // dry run
      withLemmaOf: 1,
      stoppedEarly: false,
    });
    expect(stats.samples.map((r) => r.word)).toEqual(['run', 'ran', 'london']);
    expect(stats.perPos).toEqual({ verb: 2, name: 1 });
    expect(stats.dataBytesTotal).toBeGreaterThan(0);
  });

  it('a broken JSON line is counted and skipped; its neighbours still load', async () => {
    const { writer, batches } = collector();
    const stats = await runImport({ file: gz.file, wordRanks: RANKS, writer, batchSize: 1000 });
    expect(stats.badLines).toBe(1);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((r) => r.word)).toEqual(['run', 'ran', 'london']);
  });

  it('writes in batches of the requested size; the reduced rows have the right columns', async () => {
    const { writer, batches } = collector();
    const stats = await runImport({ file: gz.file, wordRanks: RANKS, writer, batchSize: 2 });
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
    expect(stats.written).toBe(3);

    const [runRow, ranRow, londonRow] = batches.flat();
    expect(ranRow).toMatchObject({ word: 'ran', pos: 'verb', etymology_number: 1, lemma_of: 'run' });
    expect(runRow.lemma_of).toBeNull();
    expect(londonRow.word).toBe('london'); // column: lowercase
    expect(londonRow.data.word).toBe('London'); // data: original capitalisation
  });

  it('--limit-lines reads only the first N lines', async () => {
    const stats = await runImport({ file: gz.file, wordRanks: RANKS, writer: null, limitLines: 4 });
    expect(stats.linesRead).toBe(4);
    expect(stats.kept).toBe(2); // run, ran
    expect((await runImport({ file: gz.file, wordRanks: RANKS, writer: null, limitLines: 0 })).linesRead).toBe(0);
  });

  it('stops cleanly on request: the pending batch is still written and the flag is reported', async () => {
    const { writer, batches } = collector();
    let polls = 0;
    const stats = await runImport({ file: gz.file, wordRanks: RANKS, writer, batchSize: 100, shouldStop: () => ++polls > 4 });
    expect(stats.stoppedEarly).toBe(true);
    expect(stats.linesRead).toBe(4);
    expect(batches.flat().map((r) => r.word)).toEqual(['run', 'ran']); // flushed, not lost
  });

  it('never has two batches in flight (the reader waits for the database)', async () => {
    const c = collector(15);
    await runImport({ file: gz.file, wordRanks: RANKS, writer: c.writer, batchSize: 1 });
    expect(c.maxInFlight()).toBe(1);
  });

  it('reports progress with counts, speed and ETA', async () => {
    const messages: string[] = [];
    await runImport({ file: gz.file, wordRanks: RANKS, writer: null, progressEvery: 3, log: (m) => messages.push(m) });
    expect(messages).toHaveLength(3); // lines 3, 6, 9
    expect(messages[0]).toMatch(/3 read · \d+ kept · [\d.]+k lines\/s · \d+% · ETA/);
  });

  it('a different top-N set changes what is kept', async () => {
    const stats = await runImport({ file: gz.file, wordRanks: new Map([['run', 1]]), writer: null });
    expect(stats.kept).toBe(1);
    expect(stats.notInTopN).toBe(3);
  });

  it('estimates the size of each --top-n from the rank of every kept row', async () => {
    const stats = await runImport({ file: gz.file, wordRanks: RANKS, writer: null });
    expect(stats.byTopN['25000'].rows).toBe(3);
    expect(stats.byTopN['100000'].rows).toBe(3);
    const small = await runImport({ file: gz.file, wordRanks: new Map([['run', 30_000]]), writer: null });
    expect(small.byTopN['25000'].rows).toBe(0);
    expect(small.byTopN['50000'].rows).toBe(1);
  });
});

describe('runImport on damaged input', () => {
  it('a truncated .gz fails loudly after writing what it had read', async () => {
    const many = Array.from({ length: 4000 }, (_, i) => dumpLine(enRow(`w${i}x${(i * 7919) % 10007}`, { senses: [{ glosses: [`gloss number ${i} ${Math.random()}`] }] })));
    const ranks = new Map(many.map((_, i) => [`w${i}x${(i * 7919) % 10007}`, i + 1]));
    const gz = makeGz(many, { truncate: true });
    const { writer, batches } = collector();
    try {
      await expect(runImport({ file: gz.file, wordRanks: ranks, writer, batchSize: 50 })).rejects.toThrow(/reading the dump failed/);
      expect(batches.flat().length).toBeGreaterThan(0); // the rows read before the damage were not thrown away
    } finally {
      gz.cleanup();
    }
  });

  it('an empty dump is not an error', async () => {
    const gz = makeGz([]);
    try {
      expect((await runImport({ file: gz.file, wordRanks: RANKS, writer: null })).kept).toBe(0);
    } finally {
      gz.cleanup();
    }
  });
});

describe('import-wordfreq helpers', () => {
  it('parses word<TAB>zipf<TAB>rank and rejects anything else', () => {
    expect(parseWordFreqLine("don't\t4.51\t312")).toEqual({ word: "don't", zipf: 4.51, rank: 312 });
    for (const bad of ['', 'the', 'the\t7.7', 'the\tx\t1', 'the\t7.7\t0', 'the\t7.7\t1.5', '\t7.7\t1', 'a\tb\tc\td']) expect(parseWordFreqLine(bad)).toBeNull();
  });

  it('uses 5,000-row batches', () => {
    expect(WORDFREQ_BATCH_SIZE).toBe(5000);
  });

  it('upsertBatch is one idempotent statement and collapses a repeated word to its best rank', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const pool: any = { query: async (sql: string, params: any[]) => void calls.push({ sql, params }) };
    await upsertBatch(pool, [
      { word: 'run', zipf: 5.5, rank: 300 },
      { word: 'run', zipf: 5.6, rank: 250 },
      { word: 'ran', zipf: 4.9, rank: 900 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('FROM unnest($1::text[], $2::real[], $3::int[])');
    expect(calls[0].sql).toContain('ON CONFLICT (word) DO UPDATE');
    expect(calls[0].params).toEqual([['run', 'ran'], [5.6, 4.9], [250, 900]]);
    await upsertBatch(pool, []);
    expect(calls).toHaveLength(1); // nothing to do, no query
  });
});
