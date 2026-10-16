/**
 * Chaos scenarios for the lookup fast path and the enrichment sources (docs/lookup-spec.md §11, docs/lookup-chaos.md).
 * Real Express app + real PostgreSQL + the mock upstream server, whose behaviour is changed while the app is running.
 * Run with: npm run test:chaos
 */
import { bootLookupApp, fixtureWord, RUN, type LookupApp } from '../helpers/lookupApp';
import type { BossSender } from '../../services/queue/pgBossEnqueuer';
import { PgBossEnrichmentEnqueuer } from '../../services/queue/pgBossEnqueuer';
import { startMockUpstream } from '../../scripts/mock-upstream/server';
import { DatamuseClient } from '../../services/upstream/datamuseClient';
import { FreeDictionaryClient } from '../../services/upstream/freeDictionaryClient';
import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { TokenBucket } from '../../services/upstream/tokenBucket';
import { collectSources } from '../../services/enrichment/sources';
import { createPipeline } from '../../services/enrichment/pipeline';
import { EnrichmentWorker } from '../../services/queue/enrichmentWorker';
import * as Jobs from '../../models/EnrichmentJob';
import { makeDraft } from '../enrichment/fixtures';
import pool from '../../config/db';

jest.setTimeout(120_000);

const logs: Array<Record<string, any>> = [];
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation((line: unknown) => {
    try {
      logs.push(JSON.parse(String(line)));
    } catch {
      /* not JSON */
    }
  });
});
afterAll(() => jest.restoreAllMocks());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lookupLog = (word: string) => logs.filter((l) => l.evt === 'lookup' && l.word === word).pop();

// ═════════════════════════════════════════════════════════════════════════════
describe('Google answers 500 in a row: the circuit breaker opens, stays open, probes, closes (spec §11.2)', () => {
  let a: LookupApp;
  const THRESHOLD = 3;
  const RESET_MS = 1500;
  const w = (tag: string) => fixtureWord(`brk${tag}`);

  beforeAll(async () => {
    a = await bootLookupApp({ env: { UPSTREAM_BREAKER_FAILURE_THRESHOLD: String(THRESHOLD), UPSTREAM_BREAKER_RESET_MS: String(RESET_MS) } });
  });
  afterAll(() => a.close());

  const google = () => a.upstream().breakers.google_translate;

  it('opens after UPSTREAM_BREAKER_FAILURE_THRESHOLD failures, and then nobody calls Google', async () => {
    a.mock.setControl({ google: { mode: 'status', status: 500 } });

    for (let i = 0; i < THRESHOLD; i++) {
      expect(google().currentState()).toBe('closed');
      const res = await a.lookup(w(['a', 'b', 'c'][i]));
      expect(res.status).toBe(200); // Free Dictionary still answers: F, not G
      expect(res.body.data).toMatchObject({ partial: true, translation_vi: null });
    }
    expect(a.mock.stats().google.requests).toBe(THRESHOLD);
    expect(google().currentState()).toBe('open');

    // from now on the call is skipped: no request reaches the mock, the answer is the same partial one, at once
    const before = a.mock.stats().google.requests;
    for (const tag of ['d', 'e', 'f']) {
      const res = await a.lookup(w(tag));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ partial: true, translation_vi: null });
      expect(lookupLog(w(tag))!.google).toBe('error:breaker_open');
    }
    expect(a.mock.stats().google.requests).toBe(before);
  });

  it('after UPSTREAM_BREAKER_RESET_MS it is half-open and lets ONE probe through; a probe that fails opens it again', async () => {
    await sleep(RESET_MS + 150);
    expect(google().currentState()).toBe('half_open');

    const before = a.mock.stats().google.requests;
    const res = await a.lookup(w('probefail'));
    expect(res.status).toBe(200);
    expect(a.mock.stats().google.requests).toBe(before + 1); // exactly the probe
    expect(google().currentState()).toBe('open');

    const after = a.mock.stats().google.requests;
    await a.lookup(w('stillopen'));
    expect(a.mock.stats().google.requests).toBe(after); // open again: skipped
  });

  it('a probe that succeeds closes it, and Google is called again for every lookup', async () => {
    await sleep(RESET_MS + 150);
    expect(google().currentState()).toBe('half_open');
    a.mock.setControl({ google: null }); // Google is healthy again

    const before = a.mock.stats().google.requests;
    const res = await a.lookup(w('probeok'));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ partial: false });
    expect(res.body.data.translation_vi).toEqual(expect.any(String));
    expect(a.mock.stats().google.requests).toBeGreaterThan(before);
    expect(google().currentState()).toBe('closed');

    const mid = a.mock.stats().google.requests;
    await a.lookup(w('closedagain'));
    expect(a.mock.stats().google.requests).toBeGreaterThan(mid);
  });

  it('while it was open the other source kept working and the dictionary hits were never affected', async () => {
    const stats = a.mock.stats();
    expect(stats.fd.requests).toBeGreaterThan(0);
    expect(stats.fd.statuses['200']).toBe(stats.fd.requests); // Free Dictionary never failed
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Free Dictionary: 429 and an empty token bucket (spec §11.5)', () => {
  it('429 with and without Retry-After → G and FDerr: 200 partial; five of them in a row open ITS breaker only', async () => {
    const a = await bootLookupApp({ env: { UPSTREAM_BREAKER_FAILURE_THRESHOLD: '3', UPSTREAM_BREAKER_RESET_MS: '30000' } });
    try {
      a.mock.setControl({ fd: { mode: 'status', status: 429, retryAfter: 2 } });
      const first = await a.lookup(fixtureWord('fdrlone'));
      expect(first.status).toBe(200);
      expect(first.body.data).toMatchObject({ partial: true });
      expect(first.body.data.missing).toEqual(expect.arrayContaining(['pos', 'definition_en', 'ipa', 'audio_url']));
      expect(first.body.data.translation_vi).toEqual(expect.any(String)); // Google answered
      expect(lookupLog(fixtureWord('fdrlone'))!.fd).toBe('error:rate_limited');

      a.mock.setControl({ fd: { mode: 'status', status: 429 } }); // no Retry-After this time
      await a.lookup(fixtureWord('fdrltwo'));
      await a.lookup(fixtureWord('fdrlthree'));
      expect(a.upstream().breakers.free_dictionary.currentState()).toBe('open');
      expect(a.upstream().breakers.google_translate.currentState()).toBe('closed');

      const before = a.mock.stats().fd.requests;
      const res = await a.lookup(fixtureWord('fdrlfour'));
      expect(res.status).toBe(200);
      expect(a.mock.stats().fd.requests).toBe(before); // skipped
      expect(lookupLog(fixtureWord('fdrlfour'))!.fd).toBe('error:breaker_open');
    } finally {
      await a.close();
    }
  });

  it('FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN used up → no request leaves, the answer is G and FDerr, the breaker is not touched', async () => {
    const a = await bootLookupApp({ env: { FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN: '3', UPSTREAM_BREAKER_FAILURE_THRESHOLD: '2' } });
    try {
      for (const tag of ['one', 'two', 'three']) expect((await a.lookup(fixtureWord(`bk${tag}`))).body.data.partial).toBe(false);
      expect(a.mock.stats().fd.requests).toBe(3);

      for (const tag of ['four', 'five', 'six', 'seven']) {
        const res = await a.lookup(fixtureWord(`bk${tag}`));
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ partial: true });
        expect(res.body.data.missing).toEqual(expect.arrayContaining(['pos', 'definition_en', 'ipa', 'audio_url']));
        expect(lookupLog(fixtureWord(`bk${tag}`))!.fd).toBe('error:local_rate_limit');
      }
      expect(a.mock.stats().fd.requests).toBe(3); // the bucket held back every one of them
      expect(a.upstream().breakers.free_dictionary.currentState()).toBe('closed'); // our own limit is not an outage
    } finally {
      await a.close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Google character budget exhausted (spec §11.6)', () => {
  it('the lookup is answered without Google: no translation, a partial answer, Google is not called and its breaker stays closed', async () => {
    const a = await bootLookupApp({ env: { GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT: '1000', UPSTREAM_BREAKER_FAILURE_THRESHOLD: '2' } });
    try {
      const month = new Date().toISOString().slice(0, 7);
      // 999 of 1000 characters used this month (the helper restores the real counter when it closes)
      await a.pool.query(
        `INSERT INTO api_usage_counters (provider, period, unit, used) VALUES ('google_translate', $1, 'chars', 999)
         ON CONFLICT (provider, period, unit) DO UPDATE SET used = 999`,
        [month]
      );

      for (const tag of ['a', 'b', 'c']) {
        const word = fixtureWord(`budget${tag}`);
        const res = await a.lookup(word);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ partial: true, translation_vi: null, meanings_vi: [] });
        expect(res.body.data.missing).toContain('translation_vi');
        expect(res.body.data.pos_list.length).toBeGreaterThan(0); // Free Dictionary still answered
        expect(lookupLog(word)!.google).toBe('error:budget_monthly_chars');
      }
      expect(a.mock.stats().google.requests).toBe(0);
      expect(a.upstream().breakers.google_translate.currentState()).toBe('closed'); // our own cap says nothing about Google's health
      const { rows } = await a.pool.query(`SELECT used FROM api_usage_counters WHERE provider = 'google_translate' AND period = $1 AND unit = 'chars'`, [month]);
      expect(Number(rows[0].used)).toBe(999); // nothing was reserved

      // and a word Free Dictionary does not know either is a plain 404 (nobody can translate it)
      const unknown = fixtureWord('budgetnf');
      a.mock.setControl({ rules: [{ provider: 'fd', words: [unknown], behavior: { mode: 'not_found' } }] });
      expect((await a.lookup(unknown)).status).toBe(404);
    } finally {
      await a.close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the daily job cap (ENRICHMENT_MAX_JOBS_PER_DAY, spec §11.7), through the real enqueuer', () => {
  const PROVIDER = `enrichment_chaos_${RUN}`;
  const sent: string[] = [];
  const boss: BossSender = {
    send: async (_name, data: any) => {
      sent.push(data.word);
      return `boss-${sent.length}`;
    },
  };
  let a: LookupApp;

  beforeAll(async () => {
    a = await bootLookupApp({ env: { ENRICHMENT_ENABLED: 'true' } });
    a.setEnqueuer(new PgBossEnrichmentEnqueuer({ pool: a.pool as any, getBoss: async () => boss, maxJobsPerDay: 2, usageProvider: PROVIDER }));
  });
  afterAll(async () => {
    await a.pool.query(`DELETE FROM word_enrichment_jobs WHERE word LIKE $1`, [`qzq${RUN}%`]);
    await a.pool.query(`DELETE FROM api_usage_counters WHERE provider = $1`, [PROVIDER]);
    await a.close();
  });

  // Spec 1.5: the job is sent after the answer, so the answer says "queued" (decided before the send) and what the cap did is in the
  // ledger, in what was sent to pg-boss and in the `lookup_enrich` log line.
  const enrichLines: Array<Record<string, any>> = [];
  let infoSpy: jest.SpyInstance;
  beforeAll(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation((line: unknown) => {
      try {
        const parsed = JSON.parse(String(line));
        if (parsed.evt === 'lookup_enrich') enrichLines.push(parsed);
      } catch {
        /* not a JSON log line */
      }
    });
  });
  afterAll(() => infoSpy.mockRestore());

  it('the third word of the day is answered normally, no job exists for it, and the log says it hit the daily cap', async () => {
    const words = ['capa', 'capb', 'capc'].map(fixtureWord);
    const answers = [];
    for (const word of words) {
      answers.push((await a.lookup(word)).body.data.enrichment);
      await a.settle(); // one after the other, so the order in which the cap is used up is the order of the words
    }

    expect(answers).toEqual([{ status: 'queued' }, { status: 'queued' }, { status: 'queued' }]);
    expect(sent).toEqual([words[0], words[1]]);
    const { rows } = await a.pool.query(`SELECT word FROM word_enrichment_jobs WHERE word = ANY($1::text[]) ORDER BY word`, [words]);
    expect(rows.map((r) => r.word)).toEqual([words[0], words[1]]);
    expect(enrichLines.filter((l) => words.includes(l.word)).map((l) => [l.word, l.status, l.reason])).toEqual([
      [words[0], 'queued', null],
      [words[1], 'queued', null],
      [words[2], 'skipped', 'daily_cap'],
    ]);
  });

  it('the lookup itself is unaffected by the cap (complete answer, nothing missing)', async () => {
    const word = fixtureWord('capd');
    const res = await a.lookup(word);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ partial: false, enrichment: { status: 'queued' } });
    await a.settle();
    expect(enrichLines.find((l) => l.word === word)).toMatchObject({ status: 'skipped', reason: 'daily_cap' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Datamuse is down: the enrichment job still completes (spec §8 S1)', () => {
  const word = fixtureWord('dmuse');
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  const rowIds: string[] = [];

  beforeAll(async () => {
    mock = await startMockUpstream();
    await pool.query(`INSERT INTO ref_word_frequency (word, zipf, rank) VALUES ($1, 3.0, 888888) ON CONFLICT (word) DO NOTHING`, [word]);
    await pool.query(
      `INSERT INTO ref_wiktionary_en (word, pos, etymology_number, lemma_of, data) VALUES ($1, 'noun', NULL, NULL, $2::jsonb)`,
      [word, JSON.stringify({ word, pos: 'noun', senses: [{ glosses: ['A made-up thing used by a test.'], tags: ['countable'] }] })]
    );
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM word_enrichment_jobs WHERE word LIKE $1`, [`qzq${RUN}%`]);
    await pool.query(`DELETE FROM ref_wiktionary_en WHERE word LIKE $1`, [`qzq${RUN}%`]);
    await pool.query(`DELETE FROM ref_word_frequency WHERE word LIKE $1`, [`qzq${RUN}%`]);
    await mock.close();
    await pool.end();
  });

  /** The real sources and the real Datamuse client over HTTP to the mock; Haiku and the write are fakes. */
  function pipelineWith(datamuseTimeoutMs: number) {
    const breaker = new CircuitBreaker('datamuse', { failureThreshold: 5, resetMs: 30_000 });
    const datamuse = new DatamuseClient({ enabled: true, baseUrl: mock.url, timeoutMs: datamuseTimeoutMs, maxAttempts: 1 }, { breaker });
    const freeDictionary = new FreeDictionaryClient(
      { baseUrl: mock.env.FREE_DICTIONARY_BASE_URL, timeoutMs: 1000, maxAttempts: 1 },
      { breaker: new CircuitBreaker('free_dictionary', { failureThreshold: 5, resetMs: 30_000 }), bucket: new TokenBucket({ capacity: 100, windowMs: 60_000 }) }
    );
    const seen: any[] = [];
    const run = createPipeline({
      ensureTopics: async () => new Map([['business_economy', 'tag']]),
      publishPolicy: () => 'review',
      findExisting: async () => null,
      collectSources: async (w, { signal }) => {
        const bundle = await collectSources(w, { refDb: pool as any, freeDictionary, datamuse, signal });
        seen.push(bundle);
        return bundle;
      },
      generateDraft: async (bundle) => ({
        ok: true,
        draft: makeDraft({ headword: bundle.word, lemma: bundle.word }),
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, calls: 1 },
        repaired: false,
        firstIssues: [],
        model: 'fake',
        requestIds: [],
        callMs: [1],
      }),
      persist: async () => ({ status: 'created', entryId: null, rows: {} }) as any,
      linkForm: async () => ({ linked: true }),
    });
    return { run, seen };
  }

  async function runThroughWorker(w: string, behavior: Parameters<typeof mock.setControl>[0], datamuseTimeoutMs: number) {
    mock.reset();
    mock.setControl(behavior);
    const id = await Jobs.insertQueued(pool as any, { word: w, requestedBy: null });
    rowIds.push(id!);
    const { run, seen } = pipelineWith(datamuseTimeoutMs);
    const worker = new EnrichmentWorker({ db: pool as any, runEnrichment: run });
    await worker.handle([{ id: 'pg-1', data: { word: w, requestedBy: null, ebookId: null, jobRowId: id! }, retryCount: 0, retryLimit: 3 }]);
    const row = await Jobs.findById(pool as any, id!);
    return { row: row!, bundle: seen[0], stats: mock.stats() };
  }

  it.each([
    ['answers 503', { datamuse: { mode: 'status' as const, status: 503 } }, 1500],
    ['answers 429 with Retry-After', { datamuse: { mode: 'status' as const, status: 429, retryAfter: 30 } }, 1500],
    ['never answers (timeout)', { datamuse: { mode: 'hang' as const } }, 400],
    ['answers HTML', { datamuse: { mode: 'html' as const, status: 200 } }, 1500],
  ])('Datamuse %s → the job still ends succeeded, the draft just has no candidates', async (_label, control, timeoutMs) => {
    const w = fixtureWord(`dm${_label.replace(/[^a-z]/gi, '').slice(0, 8).toLowerCase()}`);
    await pool.query(`INSERT INTO ref_word_frequency (word, zipf, rank) VALUES ($1, 3.0, 888888) ON CONFLICT (word) DO NOTHING`, [w]);
    await pool.query(`INSERT INTO ref_wiktionary_en (word, pos, data) VALUES ($1, 'noun', $2::jsonb)`, [w, JSON.stringify({ word: w, pos: 'noun', senses: [{ glosses: ['A thing.'], tags: [] }] })]);

    const { row, bundle, stats } = await runThroughWorker(w, control, timeoutMs);
    expect(row).toMatchObject({ status: 'succeeded', reason: null, attempts: 1 });
    expect(stats.datamuse.requests).toBeGreaterThan(0); // it did try
    expect(bundle.datamuse === null || bundle.datamuse.degraded === true).toBe(true);
    expect(bundle.datamuse?.synonyms ?? []).toEqual([]);
    expect(bundle.wiktionaryRows.length).toBe(1); // everything else was collected
  });

  it('control: with Datamuse healthy the candidates are there', async () => {
    const w = fixtureWord('dmgood');
    await pool.query(`INSERT INTO ref_word_frequency (word, zipf, rank) VALUES ($1, 3.0, 888888) ON CONFLICT (word) DO NOTHING`, [w]);
    await pool.query(`INSERT INTO ref_wiktionary_en (word, pos, data) VALUES ($1, 'noun', $2::jsonb)`, [w, JSON.stringify({ word: w, pos: 'noun', senses: [{ glosses: ['A thing.'], tags: [] }] })]);
    const { row, bundle } = await runThroughWorker(w, {}, 1500);
    expect(row.status).toBe('succeeded');
    expect(bundle.datamuse.synonyms.length).toBeGreaterThan(0);
  });
});
