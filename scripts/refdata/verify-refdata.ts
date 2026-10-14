/**
 * Read-only check of the reference data (docs/lookup-refdata.md).
 *
 *   npm run refdata:verify
 *
 * Prints table sizes and statistics, then a PASS / WARN table for a fixed list of words. A WARN is an
 * explanation, never a failure: the dump changes between releases, so the script exits 0 unless the
 * database itself cannot be read. Finally it calls the lookup service's resolveViaForms (F4b) for a few forms.
 * Target database: REFDATA_DATABASE_URL if set, otherwise the main database. Writes nothing.
 */
import type { Pool } from 'pg';
import { resolveViaForms } from '../../services/lookup/localLookup';
import { assertRefTables, fmtInt, openRefdata } from './lib/db';

interface Check {
  word: string;
  expectation: string;
  /** returns [passed, what was found] */
  run: (pool: Pool) => Promise<[boolean, string]>;
}

const rowsOf = async (pool: Pool, word: string) =>
  (await pool.query<{ word: string; pos: string; lemma_of: string | null; data: any }>(`SELECT word, pos, lemma_of, data FROM ref_wiktionary_en WHERE word = $1`, [word.toLowerCase()])).rows;

const zipfOf = async (pool: Pool, word: string): Promise<number | null> => {
  const { rows } = await pool.query(`SELECT zipf FROM ref_word_frequency WHERE word = $1`, [word.toLowerCase()]);
  return rows.length > 0 ? Number(rows[0].zipf) : null;
};

const describeRows = (rows: Array<{ pos: string; lemma_of: string | null }>) =>
  rows.length === 0 ? 'no row' : rows.map((r) => `${r.pos}${r.lemma_of ? '→' + r.lemma_of : ''}`).join(', ');

const CHECKS: Check[] = [
  {
    word: 'run',
    expectation: 'a verb row, zipf > 5',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'run');
      const zipf = await zipfOf(pool, 'run');
      return [rows.some((r) => r.pos === 'verb') && (zipf ?? 0) > 5, `${describeRows(rows)}; zipf ${zipf ?? 'n/a'}`];
    },
  },
  {
    word: 'ran',
    expectation: 'lemma_of = run',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'ran');
      return [rows.some((r) => r.lemma_of === 'run'), describeRows(rows)];
    },
  },
  {
    word: 'running',
    expectation: 'a row with lemma_of = run',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'running');
      return [rows.some((r) => r.lemma_of === 'run'), describeRows(rows)];
    },
  },
  {
    word: 'children',
    expectation: 'lemma_of = child',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'children');
      return [rows.some((r) => r.lemma_of === 'child'), describeRows(rows)];
    },
  },
  {
    word: 'ubiquitous',
    expectation: 'a row with sounds that carry an ipa',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'ubiquitous');
      const withIpa = rows.some((r) => (r.data?.sounds ?? []).some((s: any) => typeof s.ipa === 'string' && s.ipa));
      return [rows.length > 0 && withIpa, `${describeRows(rows)}; ipa ${withIpa ? 'yes' : 'no'}`];
    },
  },
  {
    word: 'serendipity',
    expectation: 'a row with etymology_text',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'serendipity');
      const withEtym = rows.some((r) => typeof r.data?.etymology_text === 'string' && r.data.etymology_text.length > 0);
      return [rows.length > 0 && withEtym, `${describeRows(rows)}; etymology ${withEtym ? 'yes' : 'no'}`];
    },
  },
  {
    word: 'taxi',
    expectation: 'a row',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'taxi');
      return [rows.length > 0, describeRows(rows)];
    },
  },
  {
    word: 'karaoke',
    expectation: 'a row',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'karaoke');
      return [rows.length > 0, describeRows(rows)];
    },
  },
  {
    word: 'London',
    expectation: 'a "name" row (proper noun) with the capital L kept in data.word, no lemma_of',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'London');
      const ok = rows.some((r) => r.pos === 'name' && r.lemma_of === null && r.data?.word === 'London');
      return [ok, `${describeRows(rows)}; data.word=${rows.map((r) => JSON.stringify(r.data?.word)).join(',') || '-'}`];
    },
  },
  {
    word: 'recieve',
    expectation: 'no lemma_of (or no row at all)',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'recieve');
      return [rows.every((r) => r.lemma_of === null), describeRows(rows)];
    },
  },
  {
    word: 'asdfghjk',
    expectation: 'no row',
    run: async (pool) => {
      const rows = await rowsOf(pool, 'asdfghjk');
      return [rows.length === 0, describeRows(rows)];
    },
  },
];

const WHY: Record<string, string> = {
  run: 'run is missing, or ref_word_frequency lacks it: load the dump with a top-n that includes it.',
  ran: 'ran has no row pointing to run. Check that the importer ran with the default (all-senses) non-standard rule, or that the dump still lists "past of run" first.',
  running: 'the form-of row for running was not kept (top-n too small?) or the dump changed its tags.',
  children: 'children is missing, or Wiktionary now links it to a different lemma.',
  ubiquitous: 'no row or no ipa in sounds: the row may be outside top-n, or the dump moved pronunciations.',
  serendipity: 'no row or no etymology_text.',
  taxi: 'taxi is not in the loaded rows (top-n?).',
  karaoke: 'karaoke is not in the loaded rows (top-n?).',
  London: 'London missing (top-n?), or the pos is no longer "name", or data.word lost its capital letter.',
  recieve: 'recieve got a lemma_of: the misspelling tag was not recognised, so it would be auto-linked into word_forms.',
  asdfghjk: 'a nonsense word has a row: the filter is too loose.',
};

async function main() {
  const target = openRefdata();
  console.log(`target: ${target.label}\n`);
  try {
    await assertRefTables(target.pool, ['ref_word_frequency', 'ref_wiktionary_en']);

    const freq = await target.pool.query(
      `SELECT COUNT(*)::int AS n, MIN(rank) AS min_rank, MAX(rank) AS max_rank, pg_size_pretty(pg_total_relation_size('ref_word_frequency')) AS total FROM ref_word_frequency`
    );
    const wikt = await target.pool.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(DISTINCT word)::int AS distinct_words,
              COUNT(*) FILTER (WHERE lemma_of IS NOT NULL)::int AS with_lemma,
              pg_size_pretty(pg_total_relation_size('ref_wiktionary_en')) AS total,
              pg_size_pretty(pg_relation_size('ref_wiktionary_en')) AS heap,
              pg_size_pretty(pg_indexes_size('ref_wiktionary_en')) AS indexes,
              COALESCE(AVG(pg_column_size(data)), 0)::int AS avg_stored_bytes,
              COALESCE(AVG(length(data::text)), 0)::int AS avg_text_bytes
         FROM ref_wiktionary_en`
    );

    console.log('TABLES');
    console.log(`  ref_word_frequency : ${fmtInt(freq.rows[0].n)} rows (rank ${freq.rows[0].min_rank ?? '-'} … ${freq.rows[0].max_rank ?? '-'}) · ${freq.rows[0].total}`);
    const w = wikt.rows[0];
    console.log(`  ref_wiktionary_en  : ${fmtInt(w.n)} rows · ${fmtInt(w.distinct_words)} distinct words · ${fmtInt(w.with_lemma)} rows with lemma_of · ${w.total} total (heap ${w.heap}, indexes ${w.indexes})`);
    console.log(`  data column        : avg ${fmtInt(w.avg_stored_bytes)} B stored (compressed) · ${fmtInt(w.avg_text_bytes)} B as JSON text\n`);

    if (w.n === 0 || freq.rows[0].n === 0) {
      console.log('WARN: a table is empty — load it first (npm run refdata:wordfreq, npm run refdata:wiktionary).\n');
    }

    console.log('SPOT CHECKS (a WARN explains, it does not fail the script)');
    console.log('  result  word          expectation → found');
    let warnings = 0;
    for (const check of CHECKS) {
      const [ok, found] = await check.run(target.pool);
      if (!ok) warnings++;
      console.log(`  ${ok ? 'PASS  ' : 'WARN  '}  ${check.word.padEnd(12)}  ${check.expectation} → ${found}`);
      if (!ok) console.log(`          why: ${WHY[check.word]}`);
    }
    console.log(`\n  ${CHECKS.length - warnings}/${CHECKS.length} passed${warnings > 0 ? ` · ${warnings} warning(s): the data depends on the dump release and on --top-n` : ''}\n`);

    // F4b: the lookup service's resolveViaForms against the real reference tables.
    console.log('resolveViaForms (lookup F4b)');
    const entryFor = (headword: string) => ({ id: `stub-${headword}`, headword, lemma: headword, word_forms: [] });
    // (1) the real main database: succeeds only when the lemma is a published dictionary entry
    // (2) a stand-in dictionary that contains every lemma, to show what the ref data alone resolves
    const stubDb = {
      query: async (_sql: string, params: any[] = []) => ({ rows: [entryFor(String(params[0]))] }),
    };
    for (const word of ['ran', 'children', 'recieve']) {
      const real = await resolveViaForms(target.pool, target.pool, word).catch((e) => ({ error: String(e?.message ?? e) }));
      const stub = await resolveViaForms(stubDb, target.pool, word).catch((e) => ({ error: String(e?.message ?? e) }));
      const show = (r: any) =>
        r === null ? 'null (no lemma entry)' : 'error' in r ? `error: ${r.error}` : `lemma "${r.lemma}", matchedForm "${r.matchedForm}", formType ${r.formType ?? 'null'}`;
      console.log(`  ${word.padEnd(9)} real dictionary → ${show(real)}`);
      console.log(`  ${''.padEnd(9)} if lemma existed → ${show(stub)}`);
    }
  } finally {
    await target.close();
  }
}

main().catch((err) => {
  console.error('verify-refdata failed:', err?.message ?? err);
  process.exit(1);
});
