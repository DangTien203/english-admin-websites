/**
 * docs/lookup-spec.md §13.2: "migration runs twice without error". Migration 33 is run twice more on the real database, inside
 * a transaction that is rolled back (so the schema is untouched whatever happens), and the real runner (npm run db:migrate)
 * is run twice as a child process: every migration is already recorded, so each run must skip them all and succeed.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import pool from '../../config/db';
import { createRefTables } from '../../database/refdata/schema';

jest.setTimeout(180_000);

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '..', '..');

afterAll(async () => {
  await pool.end();
});

describe('migration 33 (lookup foundation)', () => {
  const migration33 = require('../../database/migrations/33_lookup_foundation') as (client: any) => Promise<void>;

  it('is registered, with a key that never changes, and the file exists', () => {
    const source = fs.readFileSync(path.join(ROOT, 'database', 'migrate.ts'), 'utf8');
    expect(source).toMatch(/key: '33_lookup_foundation'.*file: '\.\/migrations\/33_lookup_foundation'/);
    expect(fs.existsSync(path.join(ROOT, 'database', 'migrations', '33_lookup_foundation.ts'))).toBe(true);
  });

  it('runs twice in a row without error (everything is IF NOT EXISTS), and leaves the same objects behind', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const objects = async () =>
        (
          await client.query(
            `SELECT 'table:' || table_name AS o FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('ref_wiktionary_en', 'ref_word_frequency', 'word_enrichment_jobs', 'api_usage_counters')
             UNION ALL SELECT 'index:' || indexname FROM pg_indexes WHERE schemaname = 'public' AND (indexname LIKE 'idx_ref_wikt%' OR indexname LIKE 'idx_word_enrichment_jobs%' OR indexname IN ('idx_dict_headword_lower', 'idx_dict_lemma_lower', 'idx_word_forms_value_lower'))
             ORDER BY 1`
          )
        ).rows.map((r) => r.o);

      const before = await objects();
      await migration33(client);
      const afterFirst = await objects();
      await migration33(client);
      const afterSecond = await objects();
      expect(afterFirst).toEqual(before); // already applied on this database: nothing new
      expect(afterSecond).toEqual(before);
      expect(before).toEqual(
        expect.arrayContaining([
          'table:ref_wiktionary_en',
          'table:ref_word_frequency',
          'table:word_enrichment_jobs',
          'table:api_usage_counters',
          'index:idx_ref_wikt_en_word',
          'index:idx_ref_wikt_en_lemma_of',
          'index:idx_dict_headword_lower',
          'index:idx_dict_lemma_lower',
          'index:idx_word_forms_value_lower',
          'index:idx_word_enrichment_jobs_active_word',
        ])
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
      log.mockRestore();
    }
  });

  it('createRefTables (also used by db:migrate-refdata for a dedicated database) is idempotent too', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await createRefTables(client);
      await createRefTables(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('the real runner (npm run db:migrate), twice', () => {
  const migrate = async () => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', 'database/migrate.ts'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development' }, timeout: 150_000, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  };

  it('skips every migration it already recorded, on the first and on the second run: nothing runs, nothing fails', async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const out = await migrate();
      expect(out).toMatch(/Migration hoàn tất/);
      expect(out).toMatch(/Ran: 0\s+\|\s+Skipped: \d+/);
      expect(out).toContain('SKIP   33_lookup_foundation');
      expect(out).not.toMatch(/▶ RUN/);
    }
  });
});
