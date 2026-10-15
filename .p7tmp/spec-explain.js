const fs = require('fs');
const file = 'scripts/loadtest/explain-lookup.ts';
let t = fs.readFileSync(file, 'utf8');

function replaceOnce(from, to) {
  const i = t.indexOf(from);
  if (i < 0) throw new Error('not found: ' + from.slice(0, 60));
  if (t.indexOf(from, i + 1) >= 0) throw new Error('twice: ' + from.slice(0, 60));
  t = t.slice(0, i) + to + t.slice(i + from.length);
}

// header usage
replaceOnce(
  ' *   npx tsx scripts/loadtest/explain-lookup.ts [--word <w>] [--form <w>] [--ref-form <w>] [--markdown]\n',
  ' *   npx tsx scripts/loadtest/explain-lookup.ts [--word <w>] [--form <w>] [--ref-form <w>] [--scale 200000]\n *\n * --scale N also builds session-private TEMP tables with N entries and the same lower() indexes (nothing persistent is written) and\n * times the OLD query shape (an OR of three conditions) against the CURRENT one (a UNION of three index lookups).\n'
);

// the F4/S0 constants: current shapes + the old ones kept for the comparison
replaceOnce(
  'const F4_SQL = `${FULL_ENTRY_SQL}\n     WHERE e.published = TRUE\n       AND (LOWER(e.headword) = $1\n            OR LOWER(e.lemma) = $1\n            OR e.id IN (SELECT wf.entry_id FROM word_forms wf WHERE LOWER(wf.form_value) = $1))\n     ORDER BY',
  '/** services/lookup/localLookup.ts, lookupLocal(): the CURRENT shape. */\nconst F4_SQL = `${FULL_ENTRY_SQL}\n     WHERE e.published = TRUE\n       AND e.id IN (SELECT id FROM dictionary_entries WHERE LOWER(headword) = $1\n                    UNION\n                    SELECT id FROM dictionary_entries WHERE LOWER(lemma) = $1\n                    UNION\n                    SELECT wf.entry_id FROM word_forms wf WHERE LOWER(wf.form_value) = $1)\n     ORDER BY'
);
replaceOnce(
  'const S0_SQL = `SELECT e.id, e.published, e.headword, e.lemma,',
  '/** services/enrichment/persist.ts, findExistingEntry(): the CURRENT shape. */\nconst S0_SQL = `SELECT e.id, e.published, e.headword, e.lemma,'
);
replaceOnce(
  "      WHERE lower(e.headword) = ANY($1::text[])\n         OR lower(e.lemma) = ANY($1::text[])\n         OR e.id IN (SELECT wf.entry_id FROM word_forms wf WHERE lower(wf.form_value) = ANY($1::text[]))\n      ORDER BY",
  "      WHERE e.id IN (SELECT id FROM dictionary_entries WHERE lower(headword) = ANY($1::text[])\n                     UNION\n                     SELECT id FROM dictionary_entries WHERE lower(lemma) = ANY($1::text[])\n                     UNION\n                     SELECT wf.entry_id FROM word_forms wf WHERE lower(wf.form_value) = ANY($1::text[]))\n      ORDER BY"
);

// the scale experiment
replaceOnce(
  'async function main(): Promise<void> {\n  console.log(`database : ${target()}\\n`);',
  `/** TEMP tables (private to this session, gone at ROLLBACK): the OR shape against the UNION shape on N entries. */
async function scaleExperiment(n: number): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(\`CREATE TEMP TABLE t_entries (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), headword varchar(255), lemma varchar(255), published boolean DEFAULT TRUE, created_at timestamptz DEFAULT now())\`);
    await c.query(\`CREATE TEMP TABLE t_forms (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), entry_id uuid, form_value varchar(255))\`);
    await c.query(\`INSERT INTO t_entries (headword, lemma) SELECT 'Word' || g, 'word' || g FROM generate_series(1, $1) g\`, [n]);
    await c.query(\`INSERT INTO t_forms (entry_id, form_value) SELECT id, lemma || 's' FROM t_entries LIMIT $1\`, [n]);
    await c.query('CREATE INDEX t_h ON t_entries (lower(headword))');
    await c.query('CREATE INDEX t_l ON t_entries (lower(lemma))');
    await c.query('CREATE INDEX t_f ON t_forms (lower(form_value))');
    await c.query('ANALYZE t_entries');
    await c.query('ANALYZE t_forms');

    const order = 'ORDER BY CASE WHEN LOWER(e.headword) = $1 THEN 0 WHEN LOWER(e.lemma) = $1 THEN 1 ELSE 2 END LIMIT 1';
    const shapes: Array<[string, string]> = [
      ['OR of three (old)', \`SELECT e.id FROM t_entries e WHERE e.published = TRUE AND (LOWER(e.headword) = $1 OR LOWER(e.lemma) = $1 OR e.id IN (SELECT wf.entry_id FROM t_forms wf WHERE LOWER(wf.form_value) = $1)) \${order}\`],
      ['UNION of three (now)', \`SELECT e.id FROM t_entries e WHERE e.published = TRUE AND e.id IN (SELECT id FROM t_entries WHERE LOWER(headword) = $1 UNION SELECT id FROM t_entries WHERE LOWER(lemma) = $1 UNION SELECT entry_id FROM t_forms WHERE LOWER(form_value) = $1) \${order}\`],
    ];
    console.log(\`\\nSCALE: \${n} entries and \${n} forms in TEMP tables, lower() indexes, ANALYZEd (3rd run of each)\`);
    const rows: Array<Record<string, string>> = [];
    for (const [label, sql] of shapes) {
      for (const [kind, w] of [['by headword', 'word777'], ['by form', 'word777s'], ['miss', 'nothingthere']] as const) {
        let plan = '';
        for (let i = 0; i < 3; i++) plan = (await c.query(\`EXPLAIN (ANALYZE, BUFFERS) \${sql}\`, [w])).rows.map((r) => r['QUERY PLAN']).join('\\n');
        rows.push({ shape: label, lookup: kind, ms: /Execution Time: ([\\d.]+)/.exec(plan)![1], reads: /Seq Scan on t_entries/.test(plan) ? 'SEQ SCAN of every entry' : 'indexes only' });
      }
    }
    console.table(rows);
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }
}

async function main(): Promise<void> {
  console.log(\`database : \${target()}\\n\`);`
);

replaceOnce(
  "  console.log('SUMMARY (3rd run, warm)');\n  console.table(summary.map((s) => ({ query: s.id, 'ms': s.ms, plan: s.plan })));\n}",
  "  console.log('SUMMARY (3rd run, warm)');\n  console.table(summary.map((s) => ({ query: s.id, ms: s.ms, plan: s.plan.length > 150 ? s.plan.slice(0, 147) + '...' : s.plan })));\n\n  const scale = readArg(argv, 'scale');\n  if (scale) await scaleExperiment(Math.max(1000, parseInt(scale, 10) || 200000));\n}"
);

fs.writeFileSync(file, t);
console.log('explain-lookup.ts updated');
