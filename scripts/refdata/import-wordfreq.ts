/**
 * Loads data/refdata/wordfreq-en.tsv into ref_word_frequency (docs/lookup-spec.md §2).
 *
 *   npm run refdata:wordfreq [-- --file path/to/wordfreq-en.tsv]
 *
 * - Streams the file line by line (never loads it whole).
 * - 5,000-row batches: INSERT ... SELECT ... FROM unnest(...) ON CONFLICT (word) DO UPDATE,
 *   so re-running gives the same table (idempotent).
 * - Target database: REFDATA_DATABASE_URL if set, otherwise the main database.
 * - Run it BEFORE import-wiktionary: the top-N words decide which Wiktionary rows are kept.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { Pool } from 'pg';
import { assertRefTables, fmtInt, openRefdata } from './lib/db';

export const BATCH_SIZE = 5000;
const DEFAULT_FILE = path.resolve(__dirname, '../../data/refdata/wordfreq-en.tsv');

export interface WordFreqRow {
  word: string;
  zipf: number;
  rank: number;
}

/** "word<TAB>zipf<TAB>rank" → row, or null for blank / malformed lines. */
export function parseWordFreqLine(line: string): WordFreqRow | null {
  const parts = line.split('\t');
  if (parts.length !== 3) return null;
  const [word, zipfText, rankText] = parts;
  const zipf = Number(zipfText);
  const rank = Number(rankText);
  if (!word || !Number.isFinite(zipf) || !Number.isInteger(rank) || rank < 1) return null;
  return { word, zipf, rank };
}

export async function upsertBatch(pool: Pool, rows: WordFreqRow[]): Promise<void> {
  if (rows.length === 0) return;
  // One word twice in a batch would make ON CONFLICT DO UPDATE fail ("cannot affect row a second time").
  const unique = new Map<string, WordFreqRow>();
  for (const r of rows) {
    const prev = unique.get(r.word);
    if (!prev || r.rank < prev.rank) unique.set(r.word, r);
  }
  const list = [...unique.values()];
  await pool.query(
    `INSERT INTO ref_word_frequency (word, zipf, rank)
     SELECT * FROM unnest($1::text[], $2::real[], $3::int[])
     ON CONFLICT (word) DO UPDATE SET zipf = EXCLUDED.zipf, rank = EXCLUDED.rank`,
    [list.map((r) => r.word), list.map((r) => r.zipf), list.map((r) => r.rank)]
  );
}

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args.indexOf('--file') >= 0 ? args[args.indexOf('--file') + 1] : undefined;
  const file = path.resolve(fileArg ?? DEFAULT_FILE);

  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}\nRun "npm run refdata:wordfreq:export" first.`);
    process.exit(1);
  }

  const target = openRefdata();
  console.log(`target : ${target.label}`);
  console.log(`file   : ${file}`);

  try {
    await assertRefTables(target.pool, ['ref_word_frequency']);
    const started = Date.now();
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

    let read = 0;
    let skipped = 0;
    let written = 0;
    let batch: WordFreqRow[] = [];

    for await (const line of rl) {
      read++;
      const row = parseWordFreqLine(line);
      if (!row) {
        skipped++;
        continue;
      }
      batch.push(row);
      if (batch.length >= BATCH_SIZE) {
        await upsertBatch(target.pool, batch);
        written += batch.length;
        batch = [];
      }
    }
    await upsertBatch(target.pool, batch);
    written += batch.length;

    const { rows } = await target.pool.query(`SELECT COUNT(*)::int AS n, MIN(rank) AS min_rank, MAX(rank) AS max_rank FROM ref_word_frequency`);
    await target.pool.query('ANALYZE ref_word_frequency');
    console.log(`read ${fmtInt(read)} lines · upserted ${fmtInt(written)} · skipped ${skipped} · ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log(`ref_word_frequency now holds ${fmtInt(rows[0].n)} rows (rank ${rows[0].min_rank} … ${rows[0].max_rank})`);
  } finally {
    await target.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('import-wordfreq failed:', err?.message ?? err);
    process.exit(1);
  });
}
