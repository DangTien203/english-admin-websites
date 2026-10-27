import { Pool } from 'pg';
import pool from '../../config/db';
import { attachPoolErrorHandlers } from '../../config/poolErrors';
import { KEEP_ALIVE } from '../../config/keepAlive';
import { lookupConfig } from '../../config/lookup';
import type { Db } from './types';

let refPool: Pool | undefined;

/**
 * The database that holds ref_wiktionary_en and ref_word_frequency: the main pool, or a small dedicated pool when
 * REFDATA_DATABASE_URL puts the ref_* tables elsewhere. Shared by the lookup fast path and the enrichment job.
 */
export function getRefDb(): Db {
  const url = lookupConfig.refdata.databaseUrl;
  if (!url) return pool;
  refPool ??= new Pool({
    connectionString: url,
    max: 3,
    ...KEEP_ALIVE,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  // Same reason as config/db.ts: a dropped connection must not be an uncaught exception.
  attachPoolErrorHandlers(refPool, 'refdata');
  return refPool;
}
