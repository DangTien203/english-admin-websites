import { Pool, type PoolConfig } from 'pg';
import dotenv from 'dotenv';
import { attachPoolErrorHandlers } from './poolErrors';
import { KEEP_ALIVE } from './keepAlive';

dotenv.config();

const dbUrl = process.env.DATABASE_URL;

/** A non-negative whole number from the environment; anything else (unset, empty, text, negative) gives `fallback`. */
function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/**
 * How the pool treats connections. node-postgres' defaults (idle connections closed after 10 s, no limit on the wait for a connection)
 * suit a script, not a server whose database is a network hop away: opening a connection to the remote database (TCP + TLS +
 * authentication) took ~700 ms against ~60 ms for a query, and with a 10 s idle timeout a user who answers a flashcard every 15 s paid
 * that reconnect on EVERY request. So for the server:
 *   - idle connections are kept for 5 minutes (DB_POOL_IDLE_TIMEOUT_MS), just under the ~350 s after which NAT gateways and load
 *     balancers drop an idle TCP flow; pg-pool reuses the most recently used connection first, so a quiet server shrinks by itself;
 *   - waiting for a connection, or for the server to answer the connect, fails after 20 s (DB_CONNECT_TIMEOUT_MS) instead of hanging;
 *   - allowExitOnIdle: an idle pool never keeps a script alive (before, a script that forgot pool.end() lingered 10 s; now it would have
 *     lingered 5 minutes). The HTTP server and the queue worker keep their own process alive;
 *   - DB_QUERY_TIMEOUT_MS (off by default): a query that has not answered after that many ms fails with an error instead of hanging for
 *     good, e.g. on a lock that is never released. Off, because the same pool serves scripts whose queries are legitimately slow
 *     (a backup, an index on a big table); a good value for the API server is 60000.
 * Under NODE_ENV=test the defaults of node-postgres stay: every suite builds its own pool and most never end it, and a few hundred
 * connections that stay open for 5 minutes would exhaust the remote server's connection limit.
 */
const tuning: PoolConfig =
  process.env.NODE_ENV === 'test'
    ? {}
    : {
        max: envInt('DB_POOL_MAX', 10, 1),
        min: envInt('DB_POOL_MIN', 0),
        idleTimeoutMillis: envInt('DB_POOL_IDLE_TIMEOUT_MS', 300_000),
        connectionTimeoutMillis: envInt('DB_CONNECT_TIMEOUT_MS', 20_000),
        query_timeout: envInt('DB_QUERY_TIMEOUT_MS', 0),
        allowExitOnIdle: true,
      };

let pool: Pool;

if (dbUrl && (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://'))) {
  // Railway / Production: dùng connection string
  pool = new Pool({
    connectionString: dbUrl,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
    ...KEEP_ALIVE,
    ...tuning,
  });
} else {
  // Local dev: dùng biến riêng lẻ
  pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'english_learning_app',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ...KEEP_ALIVE,
    ...tuning,
  });
}

// A server can drop a connection at any time (Neon suspends an idle compute, a failover, a restart). pg reports it as an 'error'
// EVENT, and an event without a listener is an uncaught exception that kills a long-running process (the API, the worker):
// for an idle client on the pool, and for a client checked out in the middle of a transaction. See config/poolErrors.ts.
attachPoolErrorHandlers(pool);

export = pool;
