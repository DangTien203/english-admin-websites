/**
 * Streams the Wiktionary (wiktextract) dump into ref_wiktionary_en (docs/lookup-spec.md §2, §8, F4b).
 *
 *   npm run refdata:wiktionary -- [--file data/refdata/raw-wiktextract-data.jsonl.gz]
 *                                 [--top-n 150000] [--limit-lines N] [--reset] [--dry-run]
 *                                 [--strict-nonstandard]
 *
 *   --file        the .gz dump (default data/refdata/raw-wiktextract-data.jsonl.gz); never unpacked to disk
 *   --top-n       keep only words whose lowercase form has rank <= N in ref_word_frequency (default 150000)
 *   --limit-lines read only the first N lines of the dump (to time a run)
 *   --reset       TRUNCATE ref_wiktionary_en RESTART IDENTITY before loading
 *   --dry-run     run every filter and reduction, write nothing, print statistics and 5 sample records
 *   --strict-nonstandard
 *                 lemma_of is NULL as soon as ANY sense is misspelling/obsolete/archaic/nonstandard/dialectal/
 *                 rare/proscribed (default: only when ALL senses are — see deriveLemmaOf)
 *
 * Reads fs → gunzip → readline with `for await`, so a slow database slows the reader (backpressure) and
 * memory stays flat. English lines are recognised with a plain substring test before any JSON.parse.
 * Batches of 1,000 rows, one short transaction each. SIGINT finishes the current batch and exits cleanly.
 * Target: REFDATA_DATABASE_URL if set, otherwise the main database. Run ref_word_frequency FIRST.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { pipeline } from 'stream';
import * as zlib from 'zlib';
import type { Pool, PoolClient } from 'pg';
import { assertRefTables, fmtDuration, fmtInt, openRefdata } from './lib/db';
import { NonStandardRule, parseDumpLine, ReducedRow, reduceEntry } from './lib/wiktionary';

export const DEFAULT_FILE = path.resolve(__dirname, '../../data/refdata/raw-wiktextract-data.jsonl.gz');
export const DEFAULT_TOP_N = 150_000;
export const BATCH_SIZE = 1000;
export const PROGRESS_EVERY = 100_000;
/** rank thresholds used to estimate how big each --top-n would be */
export const RANK_THRESHOLDS = [25_000, 50_000, 100_000, 150_000, 200_000];

export interface RowWriter {
  writeBatch(rows: ReducedRow[]): Promise<void>;
}

export interface ImportOptions {
  file: string;
  /** lowercase word → rank, already limited to rank <= top-n */
  wordRanks: Map<string, number>;
  limitLines?: number;
  /** null/undefined = dry run: nothing is written */
  writer?: RowWriter | null;
  nonStandardRule?: NonStandardRule;
  batchSize?: number;
  progressEvery?: number;
  /** polled between lines; true = finish the current batch and stop */
  shouldStop?: () => boolean;
  log?: (message: string) => void;
}

export interface ImportStats {
  linesRead: number;
  prefilterPass: number;
  badLines: number;
  englishRows: number;
  missingWordOrPos: number;
  notInTopN: number;
  kept: number;
  written: number;
  withLemmaOf: number;
  dataBytesTotal: number;
  dataBytesMax: number;
  rowsOver8KB: number;
  perPos: Record<string, number>;
  byTopN: Record<string, { rows: number; bytes: number }>;
  samples: ReducedRow[];
  stoppedEarly: boolean;
  seconds: number;
}

const newStats = (): ImportStats => ({
  linesRead: 0, prefilterPass: 0, badLines: 0, englishRows: 0, missingWordOrPos: 0, notInTopN: 0, kept: 0, written: 0, withLemmaOf: 0,
  dataBytesTotal: 0, dataBytesMax: 0, rowsOver8KB: 0, perPos: {}, byTopN: Object.fromEntries(RANK_THRESHOLDS.map((t) => [String(t), { rows: 0, bytes: 0 }])),
  samples: [], stoppedEarly: false, seconds: 0,
});

export async function runImport(opts: ImportOptions): Promise<ImportStats> {
  const log = opts.log ?? (() => undefined);
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const progressEvery = opts.progressEvery ?? PROGRESS_EVERY;
  const stats = newStats();
  const started = Date.now();

  const fileSize = fs.statSync(opts.file).size;
  const raw = fs.createReadStream(opts.file);
  let compressedBytes = 0;
  raw.on('data', (chunk) => (compressedBytes += chunk.length));
  const gunzip = zlib.createGunzip();
  let streamError: Error | undefined;
  let intentionalStop = false;
  pipeline(raw, gunzip, (err) => {
    if (err && !intentionalStop) streamError = err;
  });
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });

  let batch: ReducedRow[] = [];
  let writerFailed = false;
  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    if (opts.writer) {
      try {
        await opts.writer.writeBatch(rows); // awaited: the reader waits for the database (backpressure)
      } catch (err) {
        writerFailed = true;
        throw err;
      }
      stats.written += rows.length;
    }
  };

  let readError: Error | undefined;
  try {
    for await (const line of rl) {
      if (opts.shouldStop?.()) {
        stats.stoppedEarly = true;
        break;
      }
      if (opts.limitLines !== undefined && stats.linesRead >= opts.limitLines) break;
      stats.linesRead++;

      if (stats.linesRead % progressEvery === 0) {
        const elapsed = (Date.now() - started) / 1000;
        const fraction = compressedBytes / fileSize;
        const eta = opts.limitLines !== undefined ? ((opts.limitLines - stats.linesRead) / (stats.linesRead / elapsed)) : elapsed / fraction - elapsed;
        log(
          `  ${fmtInt(stats.linesRead)} read · ${fmtInt(stats.kept)} kept · ${(stats.linesRead / elapsed / 1000).toFixed(1)}k lines/s · ` +
            `${opts.limitLines !== undefined ? ((stats.linesRead / opts.limitLines) * 100).toFixed(0) : (fraction * 100).toFixed(0)}% · ETA ${fmtDuration(eta)}`
        );
      }

      if (!line.includes('"lang_code": "en"')) continue; // cheapest possible test first
      stats.prefilterPass++;
      const parsed = parseDumpLine(line);
      if (parsed.kind === 'bad') {
        stats.badLines++;
        continue;
      }
      if (parsed.kind !== 'english') continue;
      stats.englishRows++;

      const reduced = reduceEntry(parsed.raw, { nonStandardRule: opts.nonStandardRule });
      if (!reduced) {
        stats.missingWordOrPos++;
        continue;
      }
      const rank = opts.wordRanks.get(reduced.word);
      if (rank === undefined) {
        stats.notInTopN++;
        continue;
      }

      stats.kept++;
      if (reduced.lemma_of) stats.withLemmaOf++;
      stats.perPos[reduced.pos] = (stats.perPos[reduced.pos] ?? 0) + 1;
      const bytes = JSON.stringify(reduced.data).length;
      stats.dataBytesTotal += bytes;
      if (bytes > stats.dataBytesMax) stats.dataBytesMax = bytes;
      if (bytes > 8 * 1024) stats.rowsOver8KB++;
      for (const t of RANK_THRESHOLDS) {
        if (rank <= t) {
          const bucket = stats.byTopN[String(t)];
          bucket.rows++;
          bucket.bytes += bytes;
        }
      }
      if (stats.samples.length < 5) stats.samples.push(reduced);

      batch.push(reduced);
      if (batch.length >= batchSize) await flush();
    }
  } catch (err) {
    if (writerFailed) throw err; // a database error is reported as it is
    readError = err as Error; // damaged / truncated .gz: keep what was read, report below
  } finally {
    intentionalStop = true;
    rl.close();
    raw.destroy();
    gunzip.destroy();
  }

  await flush(); // finish the batch that was being collected (also after SIGINT or a damaged file)
  const problem = readError ?? streamError;
  if (problem) throw new Error(`reading the dump failed: ${problem.message}`);
  stats.seconds = (Date.now() - started) / 1000;
  return stats;
}

// ── database writer ──────────────────────────────────────────────────────────

export class PgRowWriter implements RowWriter {
  private constructor(private readonly client: PoolClient) {}

  static async open(pool: Pool): Promise<PgRowWriter> {
    return new PgRowWriter(await pool.connect());
  }

  async reset(): Promise<void> {
    await this.client.query('TRUNCATE ref_wiktionary_en RESTART IDENTITY');
  }

  /** One short transaction per batch; unnest keeps it a single statement (no extra library). */
  async writeBatch(rows: ReducedRow[]): Promise<void> {
    try {
      await this.client.query('BEGIN');
      await this.client.query(
        `INSERT INTO ref_wiktionary_en (word, pos, etymology_number, lemma_of, data)
         SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::jsonb[])`,
        [
          rows.map((r) => r.word),
          rows.map((r) => r.pos),
          rows.map((r) => r.etymology_number),
          rows.map((r) => r.lemma_of),
          rows.map((r) => JSON.stringify(r.data)),
        ]
      );
      await this.client.query('COMMIT');
    } catch (err) {
      await this.client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  release(): void {
    this.client.release();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const value = (name: string) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : undefined);
  const num = (name: string, def?: number) => {
    const v = value(name);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} needs a non-negative number`);
    return n;
  };
  return {
    file: path.resolve(value('--file') ?? DEFAULT_FILE),
    topN: num('--top-n', DEFAULT_TOP_N)!,
    limitLines: num('--limit-lines'),
    reset: argv.includes('--reset'),
    dryRun: argv.includes('--dry-run'),
    strict: argv.includes('--strict-nonstandard'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function printStats(s: ImportStats, dryRun: boolean): void {
  const avg = s.kept > 0 ? s.dataBytesTotal / s.kept : 0;
  console.log('\n──────── result ────────');
  console.log(`lines read            ${fmtInt(s.linesRead)}${s.stoppedEarly ? '   (stopped early)' : ''}`);
  console.log(`prefilter passed      ${fmtInt(s.prefilterPass)}   (bad JSON: ${s.badLines})`);
  console.log(`English rows          ${fmtInt(s.englishRows)}`);
  console.log(`  missing word/pos    ${fmtInt(s.missingWordOrPos)}`);
  console.log(`  not in top-N        ${fmtInt(s.notInTopN)}`);
  console.log(`  KEPT                ${fmtInt(s.kept)}   (${dryRun ? 'would be written' : 'written ' + fmtInt(s.written)})`);
  console.log(`  with lemma_of       ${fmtInt(s.withLemmaOf)}`);
  console.log(`data column size      avg ${avg.toFixed(0)} B · max ${fmtInt(s.dataBytesMax)} B · rows over 8 KB: ${fmtInt(s.rowsOver8KB)}`);
  console.log(`speed                 ${fmtInt(s.linesRead / s.seconds)} lines/s · ${fmtDuration(s.seconds)}`);
  console.log('kept rows per pos     ' + Object.entries(s.perPos).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, n]) => `${p} ${fmtInt(n)}`).join(' · '));
  console.log('rows / data size if --top-n were:');
  for (const t of RANK_THRESHOLDS) {
    const b = s.byTopN[String(t)];
    console.log(`  ${String(t).padStart(7)}  ${fmtInt(b.rows).padStart(9)} rows  ${(b.bytes / 1024 / 1024).toFixed(0).padStart(5)} MB of JSON`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  if (!fs.existsSync(args.file)) {
    console.error(`File not found: ${args.file}\nPass the dump with --file <path to .jsonl.gz>.`);
    process.exit(1);
  }

  const target = openRefdata();
  console.log(`target   : ${target.label}${args.dryRun ? '   (DRY RUN: nothing is written)' : ''}`);
  console.log(`file     : ${args.file}`);
  console.log(`top-n    : ${fmtInt(args.topN)}${args.limitLines !== undefined ? ` · limit-lines ${fmtInt(args.limitLines)}` : ''}${args.reset ? ' · --reset' : ''}${args.strict ? ' · strict non-standard rule' : ''}`);

  let stop = false;
  process.on('SIGINT', () => {
    if (stop) process.exit(130); // second Ctrl-C: give up immediately
    stop = true;
    console.log('\nSIGINT: finishing the current batch, then exiting (press again to force) …');
  });

  let writer: PgRowWriter | undefined;
  try {
    await assertRefTables(target.pool, ['ref_word_frequency', 'ref_wiktionary_en']);

    const { rows: rankRows } = await target.pool.query<{ word: string; rank: number }>(
      `SELECT word, rank FROM ref_word_frequency WHERE rank <= $1`,
      [args.topN]
    );
    if (rankRows.length === 0) {
      console.error('ref_word_frequency is empty. Load it first:\n  npm run refdata:wordfreq:export\n  npm run refdata:wordfreq');
      process.exit(1);
    }
    const wordRanks = new Map(rankRows.map((r) => [r.word, r.rank]));
    console.log(`top-N set: ${fmtInt(wordRanks.size)} words (rank <= ${fmtInt(args.topN)})\n`);

    if (!args.dryRun) {
      writer = await PgRowWriter.open(target.pool);
      if (args.reset) {
        await writer.reset();
        console.log('ref_wiktionary_en truncated (RESTART IDENTITY)');
      }
    }

    const stats = await runImport({
      file: args.file,
      wordRanks,
      limitLines: args.limitLines,
      writer: writer ?? null,
      nonStandardRule: args.strict ? 'any' : 'all',
      shouldStop: () => stop,
      log: (m) => console.log(m),
    });
    printStats(stats, args.dryRun);

    if (args.dryRun) {
      console.log('\n5 sample records (data column shortened to 700 characters):');
      for (const r of stats.samples) {
        console.log(`  ${r.word} | ${r.pos} | etym# ${r.etymology_number ?? '-'} | lemma_of ${r.lemma_of ?? '-'}\n    ${JSON.stringify(r.data).slice(0, 700)}`);
      }
    } else {
      writer?.release();
      writer = undefined;
      await target.pool.query('ANALYZE ref_wiktionary_en');
      await target.pool.query('ANALYZE ref_word_frequency');
      const { rows: idx } = await target.pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'ref_wiktionary_en' ORDER BY 1`
      );
      const names = idx.map((r) => r.indexname as string);
      for (const need of ['idx_ref_wikt_en_word', 'idx_ref_wikt_en_lemma_of']) {
        console.log(`index ${need}: ${names.includes(need) ? 'present' : 'MISSING (re-run the migration)'}`);
      }
      const { rows: size } = await target.pool.query(
        `SELECT COUNT(*)::int AS n, pg_size_pretty(pg_total_relation_size('ref_wiktionary_en')) AS total FROM ref_wiktionary_en`
      );
      console.log(`ref_wiktionary_en: ${fmtInt(size[0].n)} rows · ${size[0].total} including indexes · ANALYZE done`);
      console.log('Next: npm run refdata:verify');
    }
    if (stop) process.exitCode = 130;
  } finally {
    writer?.release();
    await target.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('import-wiktionary failed:', err?.message ?? err);
    process.exit(1);
  });
}
