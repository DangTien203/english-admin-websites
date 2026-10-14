import dotenv from 'dotenv';
import { Pool } from 'pg';
import mainPool from '../../../config/db';

dotenv.config();

/**
 * Database selection shared by every refdata script (docs/lookup-spec.md §2, docs/lookup-refdata.md):
 *   REFDATA_DATABASE_URL set → the ref_* tables live THERE;
 *   otherwise               → the main database (migration 33 created the tables there).
 * No new environment variable is introduced.
 */
export interface RefdataTarget {
  pool: Pool;
  /** Safe to print: host and database name only, never credentials. */
  label: string;
  close: () => Promise<void>;
}

/** "host/dbname" from a connection string, without user, password or query. */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

export function openRefdata(): RefdataTarget {
  // These scripts bulk-load hundreds of MB. They are for a dev / staging database, never for production.
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV=production. Reference data is loaded by hand on dev / staging.');
    process.exit(1);
  }

  const url = process.env.REFDATA_DATABASE_URL?.trim();
  if (url) {
    const pool = new Pool({ connectionString: url, max: 2 });
    return { pool, label: `REFDATA_DATABASE_URL → ${describeUrl(url)}`, close: () => pool.end() };
  }

  const main = process.env.DATABASE_URL?.trim();
  const label = main ? `main database → ${describeUrl(main)}` : `main database → ${process.env.DB_HOST ?? 'localhost'}/${process.env.DB_NAME ?? 'english_learning_app'}`;
  return { pool: mainPool, label, close: () => mainPool.end() };
}

/** Fails early with a useful message when the ref tables are missing in the target database. */
export async function assertRefTables(pool: Pool, tables: string[]): Promise<void> {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [tables]
  );
  const present = new Set(rows.map((r) => r.table_name as string));
  const missing = tables.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new Error(
      `missing table(s) in the target database: ${missing.join(', ')}. ` +
        `Run "npm run db:migrate" (main database) or "npm run db:migrate-refdata" (when REFDATA_DATABASE_URL is set).`
    );
  }
}

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '?';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
