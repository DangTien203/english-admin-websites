import 'dotenv/config';
import pool from '../config/db';
(async () => {
  const r = await pool.query(`SELECT status, count(*)::int n FROM word_enrichment_jobs GROUP BY status ORDER BY status`);
  console.log(JSON.stringify(r.rows));
  const q = await pool.query(`SELECT status, count(*)::int n FROM word_enrichment_jobs WHERE created_at > now() - interval '3 hours' GROUP BY status ORDER BY status`);
  console.log('last 3h', JSON.stringify(q.rows));
  const pub = await pool.query(`SELECT count(*)::int n FROM dictionary_entries WHERE admin_note LIKE '[auto]%' AND published = true AND created_at > now() - interval '3 hours'`);
  console.log('auto-created entries published in last 3h:', pub.rows[0].n);
  await pool.end();
})();
