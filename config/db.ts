import { Pool } from 'pg';
import dotenv from 'dotenv';
import { attachPoolErrorHandlers } from './poolErrors';

dotenv.config();

const dbUrl = process.env.DATABASE_URL;

let pool: Pool;

if (dbUrl && (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://'))) {
  // Railway / Production: dùng connection string
  pool = new Pool({
    connectionString: dbUrl,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
  });
} else {
  // Local dev: dùng biến riêng lẻ
  pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'english_learning_app',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  });
}

// A server can drop a connection at any time (Neon suspends an idle compute, a failover, a restart). pg reports it as an 'error'
// EVENT, and an event without a listener is an uncaught exception that kills a long-running process (the API, the worker):
// for an idle client on the pool, and for a client checked out in the middle of a transaction. See config/poolErrors.ts.
attachPoolErrorHandlers(pool);

export = pool;
