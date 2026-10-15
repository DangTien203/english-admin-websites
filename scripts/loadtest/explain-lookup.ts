/**
 * EXPLAIN (ANALYZE, BUFFERS) of the queries on the lookup path, against the database in .env (read-only: every statement is a
 * SELECT inside a transaction that is rolled back). Used for docs/lookup-loadtest.md §3.
 *
 *   npx tsx scripts/loadtest/explain-lookup.ts [--word <w>] [--form <w>] [--ref-form <w>] [--scale 200000]
 *
 * --scale N also builds session-private TEMP tables with N entries and the same lower() indexes (nothing persistent is written) and
 * times the OLD query shape (an OR of three conditions) against the CURRENT one (a UNION of three index lookups).
 *
 * For every query it prints the plan of the 3rd run (warm cache), the execution time, the buffers touched, and which indexes the
 * plan used. When the planner picks a sequential scan on a small table, it ALSO prints the plan with enable_seqscan = off, which
 * shows whether the index could be used (on a table of a few hundred rows the planner is right to prefer the scan).
 */
import 'dotenv/config';
import pool from '../../config/db';
import { FULL_ENTRY_SQL } from '../../utils/entryQueries';
import { ENTRY_EXISTS_SQL } from '../../services/queue/pgBossEnqueuer';
import { readArg } from '../enrichment/args';

const argv = process.argv.slice(2);

interface Case {
  id: string;
  label: string;
  sql: string;
  params: unknown[];
}

/** services/lookup/localLookup.ts, lookupLocal(): the CURRENT shape. */
const F4_SQL = `${FULL_ENTRY_SQL}
     WHERE e.published = TRUE
       AND e.id IN (SELECT id FROM dictionary_entries WHERE LOWER(headword) = $1
                    UNION
                    SELECT id FROM dictionary_entries WHERE LOWER(lemma) = $1
                    UNION
                    SELECT wf.entry_id FROM word_forms wf WHERE LOWER(wf.form_value) = $1)
     ORDER BY CASE WHEN LOWER(e.headword) = $1 THEN 0 WHEN LOWER(e.lemma) = $1 THEN 1 ELSE 2 END
     LIMIT 1`;

/** services/enrichment/persist.ts, findExistingEntry(): the CURRENT shape. */
const S0_SQL = `SELECT e.id, e.published, e.headword, e.lemma,
            CASE WHEN lower(e.headword) = ANY($1::text[]) THEN 'headword'
                 WHEN lower(e.lemma) = ANY($1::text[]) THEN 'lemma'
                 ELSE 'form' END AS via
       FROM dictionary_entries e
      WHERE e.id IN (SELECT id FROM dictionary_entries WHERE lower(headword) = ANY($1::text[])
                     UNION
                     SELECT id FROM dictionary_entries WHERE lower(lemma) = ANY($1::text[])
                     UNION
                     SELECT wf.entry_id FROM word_forms wf WHERE lower(wf.form_value) = ANY($1::text[]))
      ORDER BY CASE WHEN lower(e.headword) = ANY($1::text[]) THEN 0 WHEN lower(e.lemma) = ANY($1::text[]) THEN 1 ELSE 2 END, e.created_at
      LIMIT 1`;

async function pick(sql: string, params: unknown[], fallback: string): Promise<string> {
  const { rows } = await pool.query(sql, params);
  return rows[0]?.w ?? fallback;
}

function target(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? '');
    return `${u.hostname}${u.pathname}`;
  } catch {
    return '(DATABASE_URL)';
  }
}

async function explain(c: Case, opts: { noSeqScan?: boolean } = {}): Promise<{ plan: string; ms: number; indexes: string[]; seqScans: string[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    if (opts.noSeqScan) await client.query('SET LOCAL enable_seqscan = off');
    let plan = '';
    for (let run = 0; run < 3; run++) {
      const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${c.sql}`, c.params as any[]);
      plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    }
    await client.query('ROLLBACK');
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? NaN);
    const indexes = [...new Set([...plan.matchAll(/Index(?: Only)? Scan using (\S+)|Bitmap Index Scan on (\S+)/g)].map((m) => m[1] ?? m[2]))];
    const seqScans = [...new Set([...plan.matchAll(/Seq Scan on (\S+)/g)].map((m) => m[1]))];
    return { plan, ms, indexes, seqScans };
  } finally {
    client.release();
  }
}

/** TEMP tables (private to this session, gone at ROLLBACK): the OR shape against the UNION shape on N entries. */
async function scaleExperiment(n: number): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`CREATE TEMP TABLE t_entries (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), headword varchar(255), lemma varchar(255), published boolean DEFAULT TRUE, created_at timestamptz DEFAULT now())`);
    await c.query(`CREATE TEMP TABLE t_forms (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), entry_id uuid, form_value varchar(255))`);
    await c.query(`INSERT INTO t_entries (headword, lemma) SELECT 'Word' || g, 'word' || g FROM generate_series(1, $1) g`, [n]);
    await c.query(`INSERT INTO t_forms (entry_id, form_value) SELECT id, lemma || 's' FROM t_entries LIMIT $1`, [n]);
    await c.query('CREATE INDEX t_h ON t_entries (lower(headword))');
    await c.query('CREATE INDEX t_l ON t_entries (lower(lemma))');
    await c.query('CREATE INDEX t_f ON t_forms (lower(form_value))');
    await c.query('ANALYZE t_entries');
    await c.query('ANALYZE t_forms');

    const order = 'ORDER BY CASE WHEN LOWER(e.headword) = $1 THEN 0 WHEN LOWER(e.lemma) = $1 THEN 1 ELSE 2 END LIMIT 1';
    const shapes: Array<[string, string]> = [
      ['OR of three (old)', `SELECT e.id FROM t_entries e WHERE e.published = TRUE AND (LOWER(e.headword) = $1 OR LOWER(e.lemma) = $1 OR e.id IN (SELECT wf.entry_id FROM t_forms wf WHERE LOWER(wf.form_value) = $1)) ${order}`],
      ['UNION of three (now)', `SELECT e.id FROM t_entries e WHERE e.published = TRUE AND e.id IN (SELECT id FROM t_entries WHERE LOWER(headword) = $1 UNION SELECT id FROM t_entries WHERE LOWER(lemma) = $1 UNION SELECT entry_id FROM t_forms WHERE LOWER(form_value) = $1) ${order}`],
    ];
    console.log(`\nSCALE: ${n} entries and ${n} forms in TEMP tables, lower() indexes, ANALYZEd (3rd run of each)`);
    const rows: Array<Record<string, string>> = [];
    for (const [label, sql] of shapes) {
      for (const [kind, w] of [['by headword', 'word777'], ['by form', 'word777s'], ['miss', 'nothingthere']] as const) {
        let plan = '';
        for (let i = 0; i < 3; i++) plan = (await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, [w])).rows.map((r) => r['QUERY PLAN']).join('\n');
        rows.push({ shape: label, lookup: kind, ms: /Execution Time: ([\d.]+)/.exec(plan)![1], reads: /Seq Scan on t_entries/.test(plan) ? 'SEQ SCAN of every entry' : 'indexes only' });
      }
    }
    console.table(rows);
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }
}

async function main(): Promise<void> {
  console.log(`database : ${target()}\n`);

  const sizes = await pool.query(`
    SELECT 'dictionary_entries' AS t, count(*)::int AS n FROM dictionary_entries
    UNION ALL SELECT 'word_forms', count(*)::int FROM word_forms
    UNION ALL SELECT 'ref_wiktionary_en', count(*)::int FROM ref_wiktionary_en
    UNION ALL SELECT 'ref_word_frequency', count(*)::int FROM ref_word_frequency
    UNION ALL SELECT 'word_enrichment_jobs', count(*)::int FROM word_enrichment_jobs`);
  console.log('rows     :', sizes.rows.map((r) => `${r.t}=${r.n}`).join('  '), '\n');

  const published = await pick(`SELECT lower(headword) AS w FROM dictionary_entries WHERE published = TRUE AND headword ~ '^[A-Za-z]+$' ORDER BY created_at LIMIT 1`, [], 'bank');
  const formWord = readArg(argv, 'form') ?? (await pick(`SELECT lower(wf.form_value) AS w FROM word_forms wf JOIN dictionary_entries e ON e.id = wf.entry_id WHERE e.published = TRUE AND wf.form_value ~ '^[A-Za-z]+$' LIMIT 1`, [], 'banks'));
  const refForm = readArg(argv, 'ref-form') ?? (await pick(`SELECT word AS w FROM ref_wiktionary_en WHERE lemma_of IS NOT NULL AND word IN ('ran','running','children','went') ORDER BY word LIMIT 1`, [], 'ran'));
  const headword = readArg(argv, 'word') ?? published;
  const miss = 'qzqexplainmiss';

  const cases: Case[] = [
    { id: 'F4-headword', label: `F4: published entry by headword ("${headword}")`, sql: F4_SQL, params: [headword] },
    { id: 'F4-form', label: `F4: found through word_forms ("${formWord}")`, sql: F4_SQL, params: [formWord] },
    { id: 'F4-miss', label: `F4: dictionary miss ("${miss}")`, sql: F4_SQL, params: [miss] },
    { id: 'F4b-probe', label: 'F4b: "is ref_wiktionary_en populated" probe (cached 5 min)', sql: `SELECT EXISTS (SELECT 1 FROM ref_wiktionary_en LIMIT 1) AS populated`, params: [] },
    { id: 'F4b-form', label: `F4b: inflection lookup ("${refForm}")`, sql: `SELECT lemma_of, data FROM ref_wiktionary_en WHERE word = $1 AND lemma_of IS NOT NULL LIMIT 20`, params: [refForm] },
    { id: 'F4b-miss', label: `F4b: unknown word ("${miss}")`, sql: `SELECT lemma_of, data FROM ref_wiktionary_en WHERE word = $1 AND lemma_of IS NOT NULL LIMIT 20`, params: [miss] },
    { id: 'F11-known-wikt', label: 'F11 "trusted word": ref_wiktionary_en', sql: `SELECT 1 FROM ref_wiktionary_en WHERE word = $1 LIMIT 1`, params: [refForm] },
    { id: 'F11-known-freq', label: 'F11 "trusted word": ref_word_frequency', sql: `SELECT 1 FROM ref_word_frequency WHERE word = $1 LIMIT 1`, params: [headword] },
    { id: 'S0-hit', label: `S0: existence check, entry exists ("${headword}")`, sql: S0_SQL, params: [[headword]] },
    { id: 'S0-form', label: `S0: existence check through word_forms ("${formWord}")`, sql: S0_SQL, params: [[formWord]] },
    { id: 'S0-miss', label: `S0: existence check, nothing ("${miss}")`, sql: S0_SQL, params: [[miss]] },
    { id: 'S1-wikt', label: `S1: Wiktionary rows of a word ("${refForm}")`, sql: `SELECT id, word, pos, etymology_number, lemma_of, data FROM ref_wiktionary_en WHERE word = $1 ORDER BY id LIMIT 40`, params: [refForm] },
    { id: 'S1-freq', label: 'S1: frequency', sql: `SELECT zipf, rank FROM ref_word_frequency WHERE word = $1 LIMIT 1`, params: [headword] },
    { id: 'enq-exists', label: 'enqueuer: entry already exists', sql: ENTRY_EXISTS_SQL, params: [miss] },
    { id: 'enq-active', label: 'enqueuer: active row for the word', sql: `SELECT 1 FROM word_enrichment_jobs WHERE word = $1 AND status IN ('queued', 'running') LIMIT 1`, params: [miss] },
  ];

  const summary: Array<{ id: string; ms: number; plan: string; seq: string }> = [];
  for (const c of cases) {
    const r = await explain(c);
    console.log(`── ${c.id} · ${c.label}`);
    console.log(r.plan.split('\n').map((l) => '   ' + l).join('\n'));
    let note = r.indexes.length ? `index: ${r.indexes.join(', ')}` : 'no index';
    if (r.seqScans.length) note += `; seq scan on: ${r.seqScans.join(', ')}`;
    summary.push({ id: c.id, ms: r.ms, plan: note, seq: r.seqScans.join(',') });

    if (r.seqScans.length) {
      const forced = await explain(c, { noSeqScan: true });
      console.log(`   [with enable_seqscan = off] ${forced.ms} ms, index: ${forced.indexes.join(', ') || 'none usable'}`);
      summary[summary.length - 1].plan += ` | forced: ${forced.ms} ms via ${forced.indexes.join(', ') || 'none'}`;
    }
    console.log('');
  }

  console.log('SUMMARY (3rd run, warm)');
  console.table(summary.map((s) => ({ query: s.id, ms: s.ms, plan: s.plan.length > 150 ? s.plan.slice(0, 147) + '...' : s.plan })));

  const scale = readArg(argv, 'scale');
  if (scale) await scaleExperiment(Math.max(1000, parseInt(scale, 10) || 200000));
}

main()
  .catch((err) => {
    console.error('explain-lookup failed:', (err as Error)?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
