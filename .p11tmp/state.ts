import 'dotenv/config';
import pool from '../config/db';
import { lookupConfig as c } from '../config/lookup';
(async () => {
  console.log('config (from .env, before any override):', JSON.stringify({ flags: c.flags, concurrency: c.queue.workerConcurrency, cap: c.queue.maxJobsPerDay, model: c.anthropic.modelEnrich, anthropicKey: c.anthropic.apiKey ? 'set' : 'MISSING' }));
  const q = async (label: string, sql: string) => console.log(label, JSON.stringify((await pool.query(sql)).rows));
  await q('now', `SELECT now() AS now, current_date AS d`);
  await q('entries', `SELECT count(*)::int total, count(*) FILTER (WHERE admin_note LIKE '[auto]%')::int auto, count(*) FILTER (WHERE admin_note LIKE '[auto]%' AND published)::int auto_published, count(*) FILTER (WHERE headword LIKE 'qzq%')::int fixtures FROM dictionary_entries`);
  await q('active rows / open pg-boss jobs', `SELECT (SELECT count(*)::int FROM word_enrichment_jobs WHERE status IN ('queued','running')) active_rows, (SELECT count(*)::int FROM pgboss.job WHERE name LIKE 'dictionary.enrich_word%' AND state IN ('created','retry','active')) open_boss_jobs`);
  await q('live workers (heartbeat < 3 min, not stopped)', `SELECT host, pid, started_on, heartbeat_on FROM pgboss.instance WHERE stopped_on IS NULL AND heartbeat_on > now() - interval '3 minutes' ORDER BY started_on`);
  await q('most recent instances', `SELECT host, pid, started_on, stopped_on, heartbeat_on FROM pgboss.instance ORDER BY started_on DESC LIMIT 5`);
  await q('daily counter', `SELECT period, used FROM api_usage_counters WHERE provider = 'enrichment' AND unit = 'jobs' ORDER BY period DESC LIMIT 3`);
  await q('anthropic month tokens', `SELECT period, unit, used FROM api_usage_counters WHERE provider = 'anthropic' ORDER BY period DESC, unit LIMIT 4`);
  await q('jobs in the last 12 h by status', `SELECT status, coalesce(reason,'-') reason, count(*)::int n FROM word_enrichment_jobs WHERE created_at > now() - interval '12 hours' GROUP BY 1,2 ORDER BY 3 DESC`);
  await q('db size', `SELECT pg_size_pretty(pg_database_size(current_database())) size`);
  await pool.end();
})();
