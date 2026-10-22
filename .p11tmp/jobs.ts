import 'dotenv/config';
import pool from '../config/db';
(async () => {
  const q = async (label: string, sql: string) => console.log(label, JSON.stringify((await pool.query(sql)).rows));
  await q('active rows', `SELECT word, status, reason, attempts, requested_by IS NOT NULL AS by_user, created_at, updated_at FROM word_enrichment_jobs WHERE status IN ('queued','running') ORDER BY created_at`);
  await q('boss jobs open', `SELECT name, state, data->>'word' AS word, retry_count, created_on, start_after, started_on FROM pgboss.job WHERE name LIKE 'dictionary.enrich_word%' AND state IN ('created','retry','active') ORDER BY created_on`);
  await q('jobs since 2026-10-20 10:00 UTC', `SELECT word, status, reason, attempts, requested_by IS NOT NULL AS by_user, created_at FROM word_enrichment_jobs WHERE created_at > '2026-10-20T10:00:00Z' ORDER BY created_at`);
  await q('entries created since 2026-10-20 10:00 UTC (non-fixture)', `SELECT headword, published, created_at, left(admin_note, 25) AS note, substring(admin_note from 'published=(?:true|false)[^·]*') AS pub FROM dictionary_entries WHERE created_at > '2026-10-20T10:00:00Z' AND headword NOT LIKE 'qzq%' ORDER BY created_at`);
  await q('lookups of missing words in the last 3 days', `SELECT count(*)::int n, count(DISTINCT word_text)::int words FROM word_lookups WHERE created_at > now() - interval '3 days'`);
  await pool.end();
})();
