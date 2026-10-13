/**
 * Creates the ref_* lookup tables in the database named by REFDATA_DATABASE_URL.
 * Run: npm run db:migrate-refdata
 *
 * Only needed when REFDATA_DATABASE_URL is set (migration 33 skips these tables then).
 * Idempotent — safe to run any number of times. Never touches the main database.
 */
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { createRefTables } from './refdata/schema';

dotenv.config();

export const migrateRefdata = async (): Promise<void> => {
  const url = process.env.REFDATA_DATABASE_URL?.trim();
  if (!url) {
    console.error('REFDATA_DATABASE_URL is not set — nothing to do (ref_* tables live in the main DB via migration 33).');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: url,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await createRefTables(client);
    await client.query('COMMIT');
    console.log('✓ ref_wiktionary_en + ref_word_frequency ready in REFDATA_DATABASE_URL');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('❌ refdata migration failed:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

if (require.main === module) {
  migrateRefdata();
}
