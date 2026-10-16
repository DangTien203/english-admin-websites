import * as fs from 'fs';
import * as path from 'path';
import { WordLookupService, LookupServiceDeps } from '../../services/lookup/lookupService';
import { UserRateLimiter } from '../../services/lookup/rateLimiter';
import { SingleFlight } from '../../services/lookup/singleFlight';
import type { Db, LookupInput, UpstreamBundle } from '../../services/lookup/types';
import { UpstreamUnavailable } from '../../services/upstream/errors';
import { FdEntry, FdLookupResult, normalizeFreeDictionaryResponse } from '../../services/upstream/freeDictionaryClient';
import type { EnrichmentEnqueuer } from '../../services/lookup/enqueuer';
import { FastTranslator, GoogleFastTranslator } from '../../services/lookup/fastTranslator';

const FIXTURES = path.resolve(__dirname, '../fixtures/lookup/free-dictionary');

/** A real Free Dictionary entry (from the captured fixtures), normalized by the production code. */
export function realFdEntry(word: 'hello' | 'ubiquitous' | 'ran'): FdEntry {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${word}.json`), 'utf8'));
  return normalizeFreeDictionaryResponse(fx.body, word)!;
}

export const fdFound = (entry: FdEntry): FdLookupResult => ({ found: true, entry });
export const FD_404: FdLookupResult = { found: false };
export const downErr = (provider: 'google_translate' | 'free_dictionary' = 'free_dictionary') => new UpstreamUnavailable(provider, 'http_5xx', { status: 503 });

/**
 * In-memory database stand-in. Recognizes only the statements the lookup service issues and records
 * every SQL string so tests can assert what was (not) queried.
 */
export interface FakeDbOptions {
  /** Row returned by the F4 query for a given lowercase word, or undefined for a miss. */
  local?: (word: string) => any | undefined;
  /** ref_wiktionary_en rows for a word (F4b). Throw to simulate a missing table. */
  refWiktionary?: (word: string) => any[];
  refKnown?: (word: string) => boolean;
  /** Result of the "is ref_wiktionary_en non-empty" probe. Defaults to true when refWiktionary is given. */
  refPopulated?: boolean;
  refProbeThrows?: boolean;
  failInserts?: boolean;
  /** word_lookups inserts wait for this before they finish (a slow database). */
  insertGate?: Promise<unknown>;
}

export function makeDb(opts: FakeDbOptions = {}) {
  const sqls: string[] = [];
  const lookups: any[][] = [];
  const forms: any[][] = [];
  const probes: string[] = [];

  const db: Db = {
    async query(sql: string, params: any[] = []) {
      sqls.push(sql);
      if (sql.includes('e.published = TRUE')) {
        const row = opts.local?.(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('SELECT EXISTS (SELECT 1 FROM ref_wiktionary_en LIMIT 1)')) {
        probes.push(sql);
        if (opts.refProbeThrows) throw new Error('relation "ref_wiktionary_en" does not exist');
        return { rows: [{ populated: opts.refPopulated ?? Boolean(opts.refWiktionary) }] };
      }
      if (sql.includes('FROM ref_wiktionary_en WHERE word = $1 AND lemma_of IS NOT NULL')) {
        return { rows: opts.refWiktionary?.(params[0]) ?? [] };
      }
      if (sql.includes('FROM ref_wiktionary_en WHERE word = $1 LIMIT 1')) {
        return { rows: opts.refKnown?.(params[0]) ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('FROM ref_word_frequency')) return { rows: [] };
      if (sql.includes('INSERT INTO word_lookups')) {
        if (opts.failInserts) throw new Error('insert failed');
        if (opts.insertGate) await opts.insertGate;
        lookups.push(params);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO word_forms')) {
        forms.push(params);
        return { rows: [] };
      }
      throw new Error('FakeDb: unexpected SQL: ' + sql.slice(0, 80));
    },
  };
  return { db, sqls, lookups, forms, probes };
}

export interface Harness {
  service: WordLookupService;
  db: ReturnType<typeof makeDb>;
  google: jest.Mock;
  fd: jest.Mock;
  enqueue: jest.Mock;
  logs: Record<string, unknown>[];
}

export interface HarnessOptions {
  db?: FakeDbOptions;
  /** Called for every Google request; defaults to a plausible fake. */
  google?: (texts: string[], opts?: { deadlineAt?: number }) => Promise<string[]>;
  fd?: (word: string, opts?: { deadlineAt?: number }) => Promise<FdLookupResult>;
  config?: Partial<LookupServiceDeps['config']>;
  rateLimit?: number;
  now?: () => number;
  enqueueResult?: Awaited<ReturnType<EnrichmentEnqueuer['enqueue']>>;
  enqueueThrows?: boolean;
  /** The job send waits for this before it answers (a slow queue). */
  enqueueGate?: Promise<unknown>;
  limiter?: LookupServiceDeps['rateLimiter'];
  /** Builds the step-1 translator from the Google mock; default is the Google engine (LOOKUP_FAST_TRANSLATOR=google). */
  translator?: (google: HarnessGoogle) => FastTranslator;
}

type HarnessGoogle = jest.Mock<Promise<string[]>, [string[], ({ deadlineAt?: number } | undefined)?]>;

/** Default fake Google: headline "chào", and "gloss<i>: định nghĩa <i>" for prefixed queries. */
export const defaultGoogle = async (texts: string[]): Promise<string[]> =>
  texts.map((t, i) => (t.includes(': ') ? `Nghĩa ${i + 1}: Định nghĩa ${i + 1}` : 'Chào'));

export function makeHarness(opts: HarnessOptions = {}): Harness {
  const db = makeDb(opts.db);
  const google = jest.fn(opts.google ?? defaultGoogle);
  const fd = jest.fn(opts.fd ?? (async () => fdFound(realFdEntry('hello'))));
  const enqueue = jest.fn(async () => {
    if (opts.enqueueThrows) throw new Error('queue down');
    if (opts.enqueueGate) await opts.enqueueGate;
    return opts.enqueueResult ?? { status: 'queued' as const };
  });
  const logs: Record<string, unknown>[] = [];

  const service = new WordLookupService({
    db: db.db,
    refDb: db.db,
    translator: opts.translator ? opts.translator(google as HarnessGoogle) : new GoogleFastTranslator({ translate: google }),
    google: { translate: google },
    freeDictionary: { lookup: fd },
    enqueuer: { enqueue },
    rateLimiter: opts.limiter ?? new UserRateLimiter(opts.rateLimit ?? 1000),
    singleFlight: new SingleFlight<UpstreamBundle>(),
    config: {
      totalDeadlineMs: 3000,
      maxMeanings: 4,
      translateDefinitions: true,
      maxDefinitionChars: 160,
      translationFallbackEnabled: true,
      enrichmentEnabled: false,
      ...opts.config,
    },
    now: opts.now,
    log: (r) => logs.push(r),
  });
  return { service, db, google, fd, enqueue, logs };
}

export const input = (word: string, userId = 'user-1'): LookupInput => ({
  userId,
  ebookId: 'ebook-1',
  paragraphId: null,
  word: { normalized: word.toLowerCase(), display: word },
});

/** Lets fire-and-forget promises (word_lookups, word_forms) settle. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
