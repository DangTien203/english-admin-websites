/**
 * Sends dead-lettered enrichment jobs back to the queue (procedure: docs/lookup-runbook.md).
 *
 *   npm run enrich:redrive                                   # dry run (default): lists what would be sent again and why not
 *   npm run enrich:redrive -- --word ubiquitous,serendipity  # only these words
 *   npm run enrich:redrive -- --id <dlq job id>[,<id>]       # only these dead-lettered jobs
 *   npm run enrich:redrive -- --reason upstream_error        # only jobs whose ledger row has this reason
 *   npm run enrich:redrive -- --limit 50                     # how many dead letters to look at (default 20, max 500)
 *   npm run enrich:redrive -- --confirm [selection...]       # really send them (needs ENRICHMENT_ENABLED=true)
 *
 * It sends ONLY the jobs you selected, each one through the same enqueuer the lookup API uses (an entry that now exists, an
 * active job, and the daily cap are all respected). Nothing is deleted: the old failed rows stay as history.
 * Run the worker (npm run worker) somewhere, or the new jobs just wait.
 */
import 'dotenv/config';
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { createPgBossEnqueuer, stopBoss } from '../../services/queue';
import { getBoss } from '../../services/queue/boss';
import { applyRedrive, planRedrive, type RedriveSelection } from '../../services/queue/redrive';
import { readArg } from './args';

const argv = process.argv.slice(2);

function target(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return `${process.env.DB_HOST ?? 'localhost'}/${process.env.DB_NAME ?? 'english_learning_app'}`;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

const list = (v: string | undefined): string[] | undefined => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

async function main(): Promise<number> {
  const confirm = argv.includes('--confirm');
  if (confirm && argv.includes('--dry-run')) {
    console.error('Use either --dry-run or --confirm, not both.');
    return 2;
  }
  const limitArg = readArg(argv, 'limit');
  const selection: RedriveSelection = {
    words: list(readArg(argv, 'word')),
    dlqJobIds: list(readArg(argv, 'id')),
    reasons: list(readArg(argv, 'reason')),
    limit: limitArg === undefined ? undefined : parseInt(limitArg, 10),
  };
  if (limitArg !== undefined && !(selection.limit! >= 1)) {
    console.error('--limit must be a positive integer.');
    return 2;
  }

  console.log(`database : ${target()}   pg-boss schema: ${lookupConfig.queue.schema}`);
  console.log(`mode     : ${confirm ? 'CONFIRM (sends jobs)' : 'dry run (nothing is sent)'}`);

  const plan = await planRedrive({ db: pool, schema: lookupConfig.queue.schema }, selection);
  const toSend = plan.items.filter((i) => i.verdict === 'redrive');
  console.log(`\ndead-lettered jobs looked at : ${plan.scanned}`);
  console.log(`  would be sent again        : ${toSend.length}`);
  console.log(`  left alone                 : ${plan.items.length - toSend.length}`);
  if (plan.items.length > 0) {
    console.log('');
    console.table(
      plan.items.map((i) => ({
        word: i.word ?? '(no word)',
        verdict: i.verdict === 'redrive' ? 'SEND AGAIN' : `skip: ${i.skip}`,
        dead_lettered: i.deadLetteredAt.slice(0, 19).replace('T', ' '),
        ledger: i.ledgerStatus ? `${i.ledgerStatus}/${i.ledgerReason ?? '-'} x${i.ledgerAttempts}` : '(no row)',
        dlq_job: i.dlqJobId,
      }))
    );
  }

  if (!confirm) {
    console.log(`\nDry run: nothing was sent. Re-run with --confirm to send ${toSend.length} job(s).`);
    return 0;
  }
  if (!lookupConfig.flags.enrichmentEnabled) {
    console.error('\nENRICHMENT_ENABLED=false: sending jobs is switched off (spec §11.8). Nothing was sent.');
    return 2;
  }
  if (toSend.length === 0) {
    console.log('\nNothing to send.');
    return 0;
  }

  await getBoss('sender'); // this tool never runs maintenance, cron or a worker
  const result = await applyRedrive({ enqueuer: createPgBossEnqueuer() }, plan);
  console.log(`\nSent: ${JSON.stringify(result.byStatus)}${result.stoppedByDailyCap ? '   (stopped: ENRICHMENT_MAX_JOBS_PER_DAY reached)' : ''}`);
  return 0;
}

main()
  .then(async (code) => {
    await stopBoss().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('enrich:redrive failed:', (err as Error)?.message ?? err);
    await stopBoss().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
