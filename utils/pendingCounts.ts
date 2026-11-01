import pool from '../config/db';
import { TtlCache } from './ttlCache';

/**
 * The two numbers in the sidebar of a super admin — approval requests waiting for a review, payments waiting for a decision.
 * injectAdmin (middlewares/auth.ts) needs them on EVERY page, and they used to be two COUNT queries, two round trips to the database
 * (run side by side), in front of whatever the page itself reads. Now they are ONE statement, kept for 10 seconds, and the code that
 * changes them (models/Approval.ts, models/Subscription.ts, the checkout of the mobile API) calls invalidatePendingCounts(), so a
 * change made through this process shows on the next page; one made by another process shows after at most the TTL.
 */
export interface PendingCounts {
  approvals: number;
  transactions: number;
}

const cache = new TtlCache<PendingCounts>({ ttlMs: 10_000, max: 1 });

async function load(): Promise<PendingCounts> {
  const { rows } = await pool.query<{ approvals: number; transactions: number }>(
    `SELECT (SELECT COUNT(*)::int FROM approval_requests WHERE status = 'pending') AS approvals,
            (SELECT COUNT(*)::int FROM transactions WHERE status = 'pending')       AS transactions`
  );
  return { approvals: rows[0].approvals, transactions: rows[0].transactions };
}

export function getPendingCounts(): Promise<PendingCounts> {
  return cache.getOrLoad('counts', load);
}

export function invalidatePendingCounts(): void {
  cache.clear();
}
