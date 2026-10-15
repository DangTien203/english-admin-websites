import type { PgBoss } from 'pg-boss';
import type { EnrichmentJobDb } from '../../models/EnrichmentJob';
import { RECONCILE_QUEUE, STALE_AFTER_MINUTES } from './constants';
import { errMessage, incr, logEvent } from './log';
import { reconcileStaleJobs, type JobFinder, type ReconcileResult } from './reconcile';

/**
 * Runs reconcileStaleJobs() every 10 minutes on the worker (docs/lookup-queue.md §7, docs/lookup-runbook.md).
 *
 * Scheduling is pg-boss's own cron (schedule()): the queue RECONCILE_QUEUE gets a job at every tick. Only one place can run
 * a pass at a time, by three independent layers:
 *   1. the cron pass itself is claimed in the database (pg-boss `trySetCronTime`), so with several processes only one of
 *      them creates the job of a tick;
 *   2. the queue has the `exclusive` policy: while a pass is waiting or running, the next tick creates nothing;
 *   3. the pass takes a transaction-level advisory lock; a second pass that starts anyway (a manual call, a job that
 *      outlived its expiry) sees the lock taken and does nothing.
 * A pass is cheap and idempotent, so a skipped or repeated tick costs nothing.
 *
 * Only a process with the 'worker' pg-boss role evaluates the cron (`schedule: true` in buildBossOptions).
 */

/** Every 10 minutes. */
export const RECONCILE_CRON = '*/10 * * * *';

/** The advisory-lock key text; hashed to the bigint pg_try_advisory_xact_lock wants. Same style as the S6 lock ('enrich:' || lemma). */
export const RECONCILE_LOCK_KEY = 'enrich:reconcile';

export interface ReconcilePool extends EnrichmentJobDb {
  connect(): Promise<EnrichmentJobDb & { release(err?: Error | boolean): void }>;
}

export type LockedReconcileResult = { ran: true; result: ReconcileResult } | { ran: false; reason: 'lock_held' };

/** Narrowing helper: this project compiles without strictNullChecks, which stops `if (r.ran)` from narrowing the union. */
export const didRun = (r: LockedReconcileResult): r is { ran: true; result: ReconcileResult } => r.ran === true;

export interface LockedReconcileDeps {
  pool: ReconcilePool;
  boss: JobFinder;
  olderThanMinutes?: number;
  /** Maintenance on one word family only, and the integration tests (never the real rows of the database). */
  wordPrefix?: string;
  /** The queue the jobs live in (default: the enrichment queue). */
  queueName?: string;
}

/**
 * One pass under the advisory lock. The lock belongs to a transaction, so it is released at COMMIT / ROLLBACK or when the
 * connection dies — it can never be left behind, and it works behind a transaction-mode pooler.
 */
export async function runLockedReconcile(deps: LockedReconcileDeps): Promise<LockedReconcileResult> {
  const client = await deps.pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`, [RECONCILE_LOCK_KEY]);
    if (!rows[0]?.locked) {
      await client.query('ROLLBACK');
      return { ran: false, reason: 'lock_held' };
    }
    const result = await reconcileStaleJobs({
      db: client,
      boss: deps.boss,
      olderThanMinutes: deps.olderThanMinutes ?? STALE_AFTER_MINUTES,
      wordPrefix: deps.wordPrefix,
      queueName: deps.queueName,
    });
    await client.query('COMMIT');
    return { ran: true, result };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true; // unknown transaction state: do not pool this connection again
    });
    throw err;
  } finally {
    client.release(broken ? true : undefined);
  }
}

export interface ReconcileScheduleOptions {
  pool: ReconcilePool;
  /** Default RECONCILE_CRON. Tests use '* * * * *'. */
  cron?: string;
  queueName?: string;
  /** The enrichment queue whose jobs the pass looks up (default ENRICH_QUEUE; tests use their own schema's). */
  jobsQueueName?: string;
  wordPrefix?: string;
  olderThanMinutes?: number;
  /** Observer called after each pass (tests, metrics). Must not throw. */
  onPass?: (result: LockedReconcileResult) => void;
  pollingIntervalSeconds?: number;
}

/**
 * Creates the queue, (re)registers the schedule and starts the handler. Safe to call at every start-up and from any number
 * of processes: createQueue and schedule() are upserts.
 */
export async function registerReconcileSchedule(boss: PgBoss, opts: ReconcileScheduleOptions): Promise<{ workId: string; cron: string; queue: string }> {
  const queue = opts.queueName ?? RECONCILE_QUEUE;
  const cron = opts.cron ?? RECONCILE_CRON;

  await boss.createQueue(queue, {
    policy: 'exclusive', // a tick never piles up behind a pass that is still running
    retryLimit: 0, // the next tick is the retry
    expireInSeconds: 300,
    deleteAfterSeconds: 3600,
  });
  await boss.schedule(queue, cron, null);

  const workId = await boss.work(queue, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 30 }, async () => {
    try {
      const outcome = await runLockedReconcile({
        pool: opts.pool,
        boss,
        wordPrefix: opts.wordPrefix,
        olderThanMinutes: opts.olderThanMinutes,
        queueName: opts.jobsQueueName,
      });
      if (didRun(outcome)) {
        incr('reconcile.passes');
        if (outcome.result.markedStale > 0) incr('reconcile.marked_stale', outcome.result.markedStale);
        logEvent(outcome.result.markedStale > 0 ? 'warn' : 'info', 'enrich_reconcile', { ...outcome.result });
      } else {
        incr('reconcile.skipped_lock_held');
        logEvent('info', 'enrich_reconcile_skipped', { reason: 'lock_held' });
      }
      try {
        opts.onPass?.(outcome);
      } catch {
        /* an observer must never fail the pass */
      }
    } catch (err) {
      incr('reconcile.errors');
      logEvent('error', 'enrich_reconcile_failed', { error: errMessage(err) });
      throw err;
    }
  });
  logEvent('info', 'enrich_reconcile_scheduled', { queue, cron });
  return { workId, cron, queue };
}
