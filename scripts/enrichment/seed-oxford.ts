/**
 * Sends the Oxford 5000 words that the dictionary does not have through the enrichment pipeline, as ordinary jobs
 * (docs/lookup-runbook.md §13). Oxford gives only the word list, the part of speech and the CEFR level; the pipeline writes the content.
 *
 *   npm run enrich:seed-oxford -- --file "P:\Personal\WordyGo_Full\oxford_5000.json" --sample 50            # dry run (default)
 *   npm run enrich:seed-oxford -- --file … --only-cefr A1,A2 --limit 500 --offset 0                          # dry run of a slice
 *   npm run enrich:seed-oxford -- --file … --sample 50 --confirm                                             # SENDS (checks first)
 *   npm run enrich:seed-oxford -- --file … --report [--worker-log <file>]                                    # writes docs/lookup-oxford-seed-report.md
 *
 * Options: --limit N · --offset N · --only-cefr A1,A2 · --sample N (stratified, replaces --limit/--offset) · --dry-run · --confirm ·
 * --report · --worker-log <file> (for --report) · --allow-auto (see below).
 * Nothing is sent without --confirm. With --confirm the tool first checks: ENRICHMENT_ENABLED=true, the 30 topic tags, a worker of THIS
 * machine alive and no other worker, ENRICHMENT_PUBLISH_POLICY=review (refused when it is "auto" unless --allow-auto is also given).
 * It stops at the first daily_cap; run it again the next UTC day and it continues where it stopped, without duplicates.
 * The logic is services/enrichment/oxford/run.ts; this file only builds the real database, queue and configuration.
 */
import 'dotenv/config';
import os from 'node:os';
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { loadTopicIds } from '../../services/enrichment/topics';
import { runSeed } from '../../services/enrichment/oxford/run';
import { getRefDb } from '../../services/lookup/refDb';
import { createPgBossEnqueuer, stopBoss } from '../../services/queue';
import { getBoss } from '../../services/queue/boss';

async function main(): Promise<number> {
  return runSeed(process.argv.slice(2), {
    db: pool as any,
    refDb: getRefDb() as any,
    config: {
      enrichmentEnabled: lookupConfig.flags.enrichmentEnabled,
      publishPolicy: lookupConfig.flags.enrichmentPublishPolicy,
      model: lookupConfig.anthropic.modelEnrich,
      concurrency: lookupConfig.queue.workerConcurrency,
      dailyCap: lookupConfig.queue.maxJobsPerDay,
      schema: lookupConfig.queue.schema,
    },
    hostname: os.hostname(),
    loadTopics: () => loadTopicIds(pool as any),
    createEnqueuer: async () => {
      await getBoss('sender'); // the role of the first caller sticks: this tool never runs maintenance or a worker
      return createPgBossEnqueuer();
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}

if (require.main === module) {
  main()
    .then(async (code) => {
      await stopBoss().catch(() => undefined);
      await pool.end().catch(() => undefined);
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('enrich:seed-oxford failed:', err?.message ?? err);
      await stopBoss().catch(() => undefined);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
