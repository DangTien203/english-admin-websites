/**
 * Shows the latest word_enrichment_jobs rows and the count per status.
 *
 *   npm run enrich:status -- [--word <w>] [--limit 20]
 */
import 'dotenv/config';
import pool from '../../config/db';
import { countByStatus, listRecent } from '../../models/EnrichmentJob';
import { readArg } from './args';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const word = readArg(argv, 'word')?.trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(readArg(argv, 'limit') ?? '20', 10) || 20, 1), 500);

  const counts = await countByStatus(pool);
  const order = ['queued', 'running', 'succeeded', 'rejected', 'skipped', 'failed'];
  console.log('by status :', order.map((s) => `${s}=${counts[s] ?? 0}`).join('  '));

  const rows = await listRecent(pool, { word, limit });
  if (rows.length === 0) {
    console.log(word ? `no rows for "${word}"` : 'no rows');
    return;
  }
  console.table(
    rows.map((r) => ({
      word: r.word,
      status: r.status,
      reason: r.reason ?? '',
      attempts: r.attempts,
      created: new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' '),
      finished: r.finished_at ? new Date(r.finished_at).toISOString().slice(0, 19).replace('T', ' ') : '',
      id: r.id,
    }))
  );
}

main()
  .catch((err) => {
    console.error('enrich:status failed:', err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
