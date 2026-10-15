module.exports = [
  {
    file: 'services/queue/constants.ts',
    edits: [
      [
        `export const ENRICH_DLQ = 'dictionary.enrich_word.dlq';`,
        `export const ENRICH_DLQ = 'dictionary.enrich_word.dlq';
/** Cron-driven housekeeping queue: one job every 10 minutes runs reconcileStaleJobs() (services/queue/reconcileSchedule.ts). */
export const RECONCILE_QUEUE = 'dictionary.enrich_word.reconcile';`,
      ],
    ],
  },
  {
    file: 'services/queue/boss.ts',
    edits: [
      [
        ` *   - 'sender' role: only inserts jobs, maintenance is switched off (\`supervise: false\`).
 *   - Cron scheduling (\`schedule\`) stays off: nothing uses it before P7.`,
        ` *   - 'sender' role: only inserts jobs, maintenance and cron are switched off (\`supervise: false\`, \`schedule: false\`).
 *   - Cron scheduling (\`schedule: true\`) belongs to the 'worker' role: it fires the 10-minute reconcile pass
 *     (services/queue/reconcileSchedule.ts). pg-boss claims each cron pass in the database, so several processes with
 *     \`schedule: true\` never create the same tick twice.`,
      ],
      [
        `    supervise: role === 'worker',
    schedule: false,`,
        `    supervise: role === 'worker',
    schedule: role === 'worker',`,
      ],
    ],
  },
  {
    file: 'services/queue/runtime.ts',
    edits: [
      [
        `import { EnrichmentWorker, registerEnrichmentWorkers } from './enrichmentWorker';`,
        `import { EnrichmentWorker, registerEnrichmentWorkers } from './enrichmentWorker';
import { registerReconcileSchedule } from './reconcileSchedule';`,
      ],
      [
        `    await registerEnrichmentWorkers(boss, worker, { concurrency: lookupConfig.queue.workerConcurrency });
  }`,
        `    await registerEnrichmentWorkers(boss, worker, { concurrency: lookupConfig.queue.workerConcurrency });
    // Every 10 minutes: rows stuck in queued / running with no pg-boss job behind them become failed / stale.
    await registerReconcileSchedule(boss, { pool: pool as any });
  }`,
      ],
    ],
  },
];
