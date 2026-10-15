import 'dotenv/config';
import pool from '../config/db';

// Session-private TEMP tables with N rows and the same expression indexes: how do the query shapes scale?
const N = Number(process.argv[2] ?? 200000);

async function main() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`CREATE TEMP TABLE t_entries (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), headword varchar(255), lemma varchar(255), published boolean DEFAULT TRUE, created_at timestamptz DEFAULT now())`);
    await c.query(`CREATE TEMP TABLE t_forms (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), entry_id uuid, form_value varchar(255))`);
    await c.query(`INSERT INTO t_entries (headword, lemma) SELECT 'Word' || g, 'word' || g FROM generate_series(1, $1) g`, [N]);
    await c.query(`INSERT INTO t_forms (entry_id, form_value) SELECT id, lemma || 's' FROM t_entries LIMIT $1`, [N]);
    await c.query(`CREATE INDEX t_h ON t_entries (lower(headword))`);
    await c.query(`CREATE INDEX t_l ON t_entries (lower(lemma))`);
    await c.query(`CREATE INDEX t_f ON t_forms (lower(form_value))`);
    await c.query(`ANALYZE t_entries`);
    await c.query(`ANALYZE t_forms`);

    const current = `SELECT e.id FROM t_entries e WHERE e.published = TRUE
       AND (LOWER(e.headword) = $1 OR LOWER(e.lemma) = $1 OR e.id IN (SELECT wf.entry_id FROM t_forms wf WHERE LOWER(wf.form_value) = $1))
     ORDER BY CASE WHEN LOWER(e.headword) = $1 THEN 0 WHEN LOWER(e.lemma) = $1 THEN 1 ELSE 2 END LIMIT 1`;
    const union = `SELECT e.id FROM t_entries e WHERE e.published = TRUE
       AND e.id IN (SELECT id FROM t_entries WHERE LOWER(headword) = $1 UNION SELECT id FROM t_entries WHERE LOWER(lemma) = $1 UNION SELECT entry_id FROM t_forms WHERE LOWER(form_value) = $1)
     ORDER BY CASE WHEN LOWER(e.headword) = $1 THEN 0 WHEN LOWER(e.lemma) = $1 THEN 1 ELSE 2 END LIMIT 1`;
    for (const [label, sql] of [['current (OR of three)', current], ['UNION of three', union]] as const) {
      for (const w of ['word777', 'word777s', 'nothingthere']) {
        let plan = '';
        for (let i = 0; i < 3; i++) plan = (await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, [w])).rows.map((r) => r['QUERY PLAN']).join('\n');
        const ms = /Execution Time: ([\d.]+)/.exec(plan)![1];
        const scan = /Seq Scan on t_entries/.test(plan) ? 'SEQ SCAN on entries' : 'indexes only';
        console.log(`${label.padEnd(24)} ${w.padEnd(14)} ${ms.padStart(8)} ms   ${scan}`);
      }
    }
    await c.query('ROLLBACK');
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
