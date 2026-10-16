import 'dotenv/config';
import pool from '../config/db';
(async () => {
  const j = await pool.query(`SELECT COUNT(*)::int n FROM word_enrichment_jobs WHERE word LIKE 'qzq%'`);
  const u = await pool.query(`SELECT COUNT(*)::int n FROM users WHERE email LIKE 'lt-%@example.com'`);
  const e = await pool.query(`SELECT COUNT(*)::int n FROM ebooks WHERE title LIKE 'LT ebook%'`);
  const c = await pool.query(`SELECT period, used FROM api_usage_counters WHERE provider='enrichment' ORDER BY period DESC LIMIT 2`);
  console.log(JSON.stringify({ qzqJobs: j.rows[0].n, ltUsers: u.rows[0].n, ltEbooks: e.rows[0].n, enrichmentCounter: c.rows }));
  await pool.end();
})();
