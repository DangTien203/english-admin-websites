import 'dotenv/config';
import pool from '../config/db';
(async () => {
  const q = async (label: string, sql: string) => console.log(label, JSON.stringify((await pool.query(sql)).rows));
  await q('jobs STARTED by any worker since my last worker stopped (2026-10-20 09:12 UTC)', `SELECT name, state, data->>'word' AS word, started_on, completed_on FROM pgboss.job WHERE name LIKE 'dictionary.enrich_word%' AND started_on > '2026-10-20T09:12:00Z' ORDER BY started_on`);
  await q('all jobs created since then', `SELECT data->>'word' AS word, state, created_on, started_on FROM pgboss.job WHERE name = 'dictionary.enrich_word' AND created_on > '2026-10-20T09:12:00Z' ORDER BY created_on`);
  await q('queue row', `SELECT name, policy, retry_limit, expire_seconds, dead_letter FROM pgboss.queue WHERE name LIKE 'dictionary.enrich_word%'`);
  await q('subscriptions/instances columns', `SELECT column_name FROM information_schema.columns WHERE table_schema = 'pgboss' AND table_name = 'instance' ORDER BY ordinal_position`);
  await q('instance rows of the deployed host (all)', `SELECT name, host, pid, started_on, heartbeat_on, stopped_on FROM pgboss.instance WHERE host LIKE 'srv-%' ORDER BY started_on DESC LIMIT 6`);
  await pool.end();
})();
