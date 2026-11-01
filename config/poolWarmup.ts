import type { Pool } from 'pg';

/**
 * Opens `count` connections at the same time, right after the server starts listening, so the first visitors after a start or a deploy
 * do not each pay for opening a connection (TCP + TLS + authentication: ~700 ms to the remote database, against ~60 ms for a query).
 * Each connection runs one `SELECT 1` and goes back to the pool; the pool keeps them for DB_POOL_IDLE_TIMEOUT_MS (config/db.ts).
 *
 * Best effort and never throws: a database that is not there yet must not stop the server from starting (the first real request
 * reports the error the way it always did). Resolves with what happened, for the start-up log line.
 */
export async function warmPool(
  pool: Pick<Pool, 'query'>,
  count: number
): Promise<{ requested: number; opened: number; failed: number; ms: number }> {
  const requested = Math.max(0, Math.floor(count));
  const started = Date.now();
  const results = await Promise.allSettled(Array.from({ length: requested }, () => pool.query('SELECT 1')));
  const opened = results.filter((r) => r.status === 'fulfilled').length;
  return { requested, opened, failed: requested - opened, ms: Date.now() - started };
}
