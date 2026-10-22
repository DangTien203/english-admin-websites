import 'dotenv/config';
import pool from '../config/db';
(async () => {
  const { rows } = await pool.query(`SELECT name, host, pid, application_name, supervise, schedule, workers, started_on, stopped_on, heartbeat_on FROM pgboss.instance ORDER BY started_on DESC LIMIT 14`);
  for (const r of rows) console.log(JSON.stringify({ ...r, workers: typeof r.workers === 'string' ? r.workers.slice(0, 80) : JSON.stringify(r.workers)?.slice(0, 80) }));
  await pool.end();
})();
