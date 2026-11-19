import type { PgBoss } from 'pg-boss';
import { abandonExpiredPracticeSessions, type ExpiryOptions, type ExpiryResult } from '../practiceSessionService';
import { PRACTICE_EXPIRY_QUEUE } from './constants';
import { errMessage, incr, logEvent } from './log';

/**
 * Every hour the worker abandons the practice sessions that nobody came back to (open, last activity older than 7 days), so the
 * correct answers they hold still reach Leitner and a stale session stops looking resumable (docs: MOBILE_API_ENDPOINTS.md,
 * "Practice Endpoints"). The work is abandonExpiredPracticeSessions(): the same close as POST /practice/session/abandon.
 *
 * Scheduling is pg-boss's own cron, exactly like the reconcile pass (reconcileSchedule.ts): the cron tick is claimed in the database,
 * the queue has the `exclusive` policy (a tick never piles up behind a run that is still going), and a run that starts anyway is
 * harmless: every close is an atomic claim, so a session is never applied twice. Only a process with the 'worker' pg-boss role
 * evaluates the cron.
 */

/** Hourly, on the hour. */
export const PRACTICE_EXPIRY_CRON = '0 * * * *';

export interface PracticeExpiryScheduleOptions {
  /** Default PRACTICE_EXPIRY_CRON. */
  cron?: string;
  queueName?: string;
  /** Passed to the pass (batch size, number of batches, test scoping). */
  pass?: ExpiryOptions;
  /** Observer called after each pass (tests, metrics). Must not throw. */
  onPass?: (result: ExpiryResult) => void;
  pollingIntervalSeconds?: number;
}

/**
 * Creates the queue, (re)registers the schedule and starts the handler. Safe to call at every start-up and from any number of
 * processes: createQueue and schedule() are upserts.
 */
export async function registerPracticeExpirySchedule(
  boss: PgBoss,
  opts: PracticeExpiryScheduleOptions = {}
): Promise<{ workId: string; cron: string; queue: string }> {
  const queue = opts.queueName ?? PRACTICE_EXPIRY_QUEUE;
  const cron = opts.cron ?? PRACTICE_EXPIRY_CRON;

  await boss.createQueue(queue, {
    policy: 'exclusive',
    retryLimit: 0, // the next tick is the retry
    expireInSeconds: 1800, // a backlog is worked off in bounded runs (50 × 20 sessions)
    deleteAfterSeconds: 3600,
  });
  await boss.schedule(queue, cron, null);

  const workId = await boss.work(queue, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 30 }, async () => {
    try {
      const result = await abandonExpiredPracticeSessions(opts.pass);
      incr('practice_expiry.passes');
      if (result.abandoned > 0) incr('practice_expiry.abandoned', result.abandoned);
      if (result.failed > 0) incr('practice_expiry.failed', result.failed);
      logEvent(result.failed > 0 ? 'warn' : 'info', 'practice_expiry', { ...result });
      try {
        opts.onPass?.(result);
      } catch {
        /* an observer must never fail the pass */
      }
    } catch (err) {
      incr('practice_expiry.errors');
      logEvent('error', 'practice_expiry_failed', { error: errMessage(err) });
      throw err;
    }
  });
  logEvent('info', 'practice_expiry_scheduled', { queue, cron });
  return { workId, cron, queue };
}
