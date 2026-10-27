/**
 * TCP keep-alive for every PostgreSQL connection of the application (config/db.ts, the reference-data pool, pg-boss's own pool).
 *
 * A connection that the network drops WITHOUT a reset (a laptop on Wi-Fi, a serverless database that moved) looks alive to the operating
 * system for about two hours (the Windows default), and a query on it simply never returns. That stalled the enrichment worker for
 * 1 h 50 min on 22/10/2026 (all four slots hung at once) and hung the command that sends words. With keep-alive the dead connection is
 * noticed within about 20 seconds and the query fails, which the retry logic already knows how to handle.
 *
 * Kept apart from config/db.ts because that module is `export = pool` and cannot carry another export.
 */
export const KEEP_ALIVE = { keepAlive: true, keepAliveInitialDelayMillis: 10_000 } as const;
