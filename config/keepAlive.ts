/**
 * TCP keep-alive for every PostgreSQL connection of the application (config/db.ts, the reference-data pool, pg-boss's own pool).
 *
 * A connection that the network drops WITHOUT a reset (a laptop on Wi-Fi, a serverless database that moved) looks alive to the operating
 * system for about two hours (the Windows default), and a query on it simply never returns. That stalled the enrichment worker for
 * 1 h 50 min on 22/10/2026 (all four slots hung at once) and hung the command that sends words. With keep-alive the OS probes an idle
 * connection after 10 s of silence and gives up on a dead one; how soon that is depends on the OS, because only the FIRST probe's delay
 * is set here: about 20 seconds on Windows (probes 1 s apart), about 11 minutes with the Linux defaults (75 s apart, 9 probes — lower
 * net.ipv4.tcp_keepalive_intvl on the host to shorten it). The query then fails, which the retry logic already knows how to handle.
 *
 * Keep-alive says nothing about a query that hangs on a connection that is fine (a lock that is never released, a stuck backend):
 * bound those with DB_QUERY_TIMEOUT_MS (config/db.ts, off by default).
 *
 * Kept apart from config/db.ts because that module is `export = pool` and cannot carry another export.
 */
export const KEEP_ALIVE = { keepAlive: true, keepAliveInitialDelayMillis: 10_000 } as const;
