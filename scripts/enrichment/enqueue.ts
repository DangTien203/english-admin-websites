/**
 * Sends one word to the enrichment queue through the REAL enqueuer (the same code path as the lookup API).
 *
 *   npm run enrich:enqueue -- --word ubiquitous
 *
 * Needs ENRICHMENT_ENABLED=true (otherwise the enqueuer reports "disabled"). Uses the 'sender' role of
 * pg-boss, so it runs no maintenance and starts no worker; a worker (npm run worker) has to be running
 * somewhere to process the job.
 */
import 'dotenv/config';
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { stopBoss } from '../../services/queue';
import { getBoss } from '../../services/queue/boss';
import { createPgBossEnqueuer } from '../../services/queue';
import { NoopEnqueuer } from '../../services/lookup/enqueuer';
import { listRecent } from '../../models/EnrichmentJob';
import { readArg } from './args';

async function main(): Promise<number> {
  const word = readArg(process.argv.slice(2), 'word');
  if (!word) {
    console.error('usage: npm run enrich:enqueue -- --word <word>');
    return 2;
  }

  if (!lookupConfig.flags.enrichmentEnabled) {
    const result = await new NoopEnqueuer().enqueue({ word, requestedBy: null, ebookId: null });
    console.log(JSON.stringify(result), '(set ENRICHMENT_ENABLED=true to enqueue for real)');
    return 2;
  }

  console.log(`schema : ${lookupConfig.queue.schema}`);
  await getBoss('sender'); // the role of the first caller sticks: this tool never runs maintenance
  const result = await createPgBossEnqueuer().enqueue({ word, requestedBy: null, ebookId: null });
  console.log('result :', JSON.stringify(result));

  if (result.status === 'queued' || result.status === 'already_queued') {
    const [row] = await listRecent(pool, { word: word.trim().toLowerCase(), limit: 1 });
    if (row) console.log(`row    : ${row.id} status=${row.status} attempts=${row.attempts}`);
  }
  return 0;
}

main()
  .then(async (code) => {
    await stopBoss().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('enrich:enqueue failed:', err?.message ?? err);
    await stopBoss().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
