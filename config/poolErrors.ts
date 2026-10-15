import type { Pool, PoolClient } from 'pg';

/**
 * Keeps a dropped connection from killing the process (docs/lookup-queue.md §12, docs/lookup-runbook.md).
 *
 * A Postgres server can drop a connection at any time: Neon suspends an idle compute, a failover, a restart, an
 * administrator terminating a backend. node-postgres reports it as an 'error' EVENT, and an 'error' event without a listener
 * is an uncaught exception that ends a long-running API or worker. Two cases, two listeners:
 *
 *   - an IDLE client in the pool  → pg-pool re-emits it on the pool: pool.on('error');
 *   - a client CHECKED OUT (pool.connect(), a transaction in progress) → pg-pool takes its own listener off while the client
 *     is in use, so nobody is listening unless we are: client.on('error'), attached when the client is created.
 *     (The query that was running gets the error as a normal rejection, as before; this only stops the extra event from
 *     being fatal. Code that uses pool.connect() still has to roll back and release the client, which it already does.)
 *
 * Both only LOG. The failed client is discarded by pg, and the next query opens a new connection.
 */

function line(evt: string, err: Error & { code?: string }, label?: string): string {
  return JSON.stringify({ evt, ...(label ? { pool: label } : {}), code: err.code ?? null, error: String(err.message).slice(0, 300) });
}

export function attachPoolErrorHandlers(pool: Pool, label?: string): void {
  pool.on('error', (err: Error & { code?: string; __logged?: boolean }) => {
    err.__logged = true; // the client-level listener below sees the same error object
    console.error(line('pg_pool_error', err, label));
  });

  pool.on('connect', (client: PoolClient) => {
    client.on('error', (err: Error & { code?: string; __logged?: boolean }) => {
      if (err.__logged) return; // an idle client: already reported by the pool listener
      console.error(line('pg_client_error', err, label));
    });
  });
}
