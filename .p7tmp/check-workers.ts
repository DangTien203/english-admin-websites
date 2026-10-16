import 'dotenv/config';
import pool from '../config/db';
(async () => {
  const r = await pool.query(`SELECT name, host, pid, started_on, heartbeat_on, stopped_on FROM pgboss.instance ORDER BY started_on DESC LIMIT 8`);
  console.log(JSON.stringify(r.rows.map((x) => ({ ...x, now: new Date().toISOString() })), null, 1));
  const q = await pool.query(`SELECT name, state, count(*)::int n FROM pgboss.job WHERE name LIKE 'dictionary.enrich_word%' GROUP BY 1,2 ORDER BY 1,2`);
  console.log(JSON.stringify(q.rows));
  await pool.end();
})();
