/**
 * Load test of POST /api/v1/ebooks/:id/lookup (docs/lookup-loadtest.md). No library: node's fetch, the mock upstream server
 * (scripts/mock-upstream, 127.0.0.1) and the real Express app running as a child process against the database in .env.
 *
 *   npm run loadtest:lookup                      # the full run
 *   npm run loadtest:lookup -- --same 200 --distinct 50 --window 10 --latency 300 --rounds 2
 *   npm run loadtest:lookup -- --deadline 60000  # LOOKUP_TOTAL_DEADLINE_MS of the app in scenario A (default 3000, the production default)
 *   npm run loadtest:lookup -- --skip-slow       # without the single-flight scenario (it waits ~15 s)
 *   npm run loadtest:lookup -- --send 30         # words of scenario D (default 30; --skip-send leaves the scenario out)
 *   npm run loadtest:lookup -- --only-send       # only scenario D (about a minute)
 *   npm run loadtest:lookup -- --json out.json   # also write the figures as JSON
 *
 * Scenarios (each prints PASS / FAIL lines; the exit code is 1 if any check fails):
 *   A  BASELINE   --same requests for ONE new word at the same instant, plus --distinct different new words spread over --window
 *                 seconds, the mock answering after --latency ms. Latency p50 / p95 / max, errors, flights per word, heap before
 *                 and after (the burst is repeated --rounds times to see whether memory keeps growing).
 *   B  SINGLE-FLIGHT  --same requests for one new word while ONE upstream flight is slow enough (10 s) to cover every arrival:
 *                 the mock must see exactly 1 Free Dictionary request and 1 Google request for that word (spec §5 F7).
 *   C  F6         one user asks for LOOKUP_MISS_RATE_LIMIT_PER_MIN + 5 new words at once: the first 20 are answered, the rest are 429
 *                 with Retry-After.
 *   D  ANSWER AND JOB SEND   --send new words one after the other with ENRICHMENT_ENABLED=true and the REAL pg-boss sender, in a private
 *                 schema (lt_<run>) with no worker, so no job is ever processed. Since spec 1.5 the job is sent after the answer:
 *                 the figures show the answer time and, next to it, what the visitor would have waited with the send in front of it.
 *                 Cleans up what it made: the ledger rows, the daily job counter it moved, the private schema.
 *
 * Every fixture (users, ebook) is named "lt<run>…" and removed at the end; the real Google character counter is restored.
 * Nothing real is called: the child's GOOGLE_TRANSLATE_BASE_URL / FREE_DICTIONARY_BASE_URL / DATAMUSE_BASE_URL point at the mock
 * and its API keys are dummies. Refuses to run with NODE_ENV=production.
 */
import 'dotenv/config';
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import jwt from 'jsonwebtoken';
import pool from '../../config/db';
import { currentPeriod } from '../../services/upstream/apiUsage';
import { startMockUpstream, type MockUpstream } from '../mock-upstream/server';

if (process.env.NODE_ENV === 'production') {
  console.error('the load test is for development databases only (NODE_ENV=production).');
  process.exit(2);
}

// ── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const num = (name: string, def: number): number => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} needs a number`);
  return v;
};
const SAME = num('same', 200);
const DISTINCT = num('distinct', 50);
const WINDOW_S = num('window', 10);
const LATENCY_MS = num('latency', 300);
const ROUNDS = Math.max(1, num('rounds', 2));
const SKIP_SLOW = argv.includes('--skip-slow');
/** Scenario D: how many new words are looked up one after the other with the real job sender (0 = leave the scenario out). */
const SEND = argv.includes('--skip-send') ? 0 : num('send', 30);
/** Only scenario D (the others take minutes and are not affected by where the job send happens). */
const ONLY_SEND = argv.includes('--only-send');
/** LOOKUP_TOTAL_DEADLINE_MS of the app in scenario A (default 3000 = the production default). */
const DEADLINE_MS = num('deadline', 3000);
const JSON_OUT = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : undefined;

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
/** i → letters only (the word cleaner rejects digits). */
const alpha = (i: number): string => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};
const word = (tag: string) => `qzq${RUN}${tag}`;

// ── small helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

function summarize(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.length ? s[s.length - 1] : NaN, mean: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : NaN };
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

const checks: Array<{ ok: boolean; text: string }> = [];
function check(ok: boolean, text: string): void {
  checks.push({ ok, text });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`);
}

// ── the app as a child process ───────────────────────────────────────────────

interface Heap {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
}

interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

interface AppProcess {
  base: string;
  warm(n: number): Promise<void>;
  pool(): Promise<PoolStats>;
  /** Waits until the app's pool has nothing queued and every connection is idle (the fire-and-forget inserts of the last burst are done). */
  drained(): Promise<number>;
  lookupLogs: Array<Record<string, any>>;
  /** The `lookup_enrich` lines (the real answer of each background job send, spec 1.5). */
  enrichLogs: Array<Record<string, any>>;
  heap(): Promise<Heap>;
  stop(): Promise<void>;
}

async function startApp(mock: MockUpstream, env: Record<string, string> = {}): Promise<AppProcess> {
  const child: ChildProcess = fork(path.resolve(__dirname, 'app-runner.ts'), [], {
    execArgv: ['--expose-gc', '--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ...mock.env,
      GOOGLE_TRANSLATE_API_KEY: 'loadtest-google-key-0000',
      ANTHROPIC_API_KEY: 'loadtest-anthropic-key-0000',
      ENRICHMENT_ENABLED: 'false',
      TRANSLATION_FALLBACK_ENABLED: 'true',
      LOOKUP_FAST_TRANSLATOR: 'google',
      FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN: '100000',
      GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT: '450000',
      UPSTREAM_BREAKER_FAILURE_THRESHOLD: '100',
      REFDATA_DATABASE_URL: '',
      ...env,
    },
  });

  const lookupLogs: Array<Record<string, any>> = [];
  const enrichLogs: Array<Record<string, any>> = [];
  let buffer = '';
  child.stdout!.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const target = line.startsWith('{"evt":"lookup"') ? lookupLogs : line.startsWith('{"evt":"lookup_enrich"') ? enrichLogs : null;
      if (!target) continue;
      try {
        target.push(JSON.parse(line));
      } catch {
        /* partial line */
      }
    }
  });
  const stderr: string[] = [];
  child.stderr!.on('data', (c) => stderr.push(String(c)));

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the app did not start in 60 s\n${stderr.join('').slice(-800)}`)), 60_000);
    child.once('exit', (code) => reject(new Error(`the app exited with code ${code}\n${stderr.join('').slice(-800)}`)));
    child.on('message', (m: any) => {
      if (m?.type === 'listening') {
        clearTimeout(timer);
        resolve(m.port);
      }
    });
  });

  const poolOf = () =>
    new Promise<PoolStats>((resolve) => {
      const onMessage = (m: any) => {
        if (m?.type === 'pool') {
          child.off('message', onMessage);
          resolve(m);
        }
      };
      child.on('message', onMessage);
      child.send({ type: 'pool' });
    });

  return {
    base: `http://127.0.0.1:${port}`,
    lookupLogs,
    enrichLogs,
    warm: (n) =>
      new Promise<void>((resolve) => {
        const onMessage = (m: any) => {
          if (m?.type === 'warm') {
            child.off('message', onMessage);
            resolve();
          }
        };
        child.on('message', onMessage);
        child.send({ type: 'warm', n });
      }),
    pool: () =>
      new Promise<PoolStats>((resolve) => {
        const onMessage = (m: any) => {
          if (m?.type === 'pool') {
            child.off('message', onMessage);
            resolve(m);
          }
        };
        child.on('message', onMessage);
        child.send({ type: 'pool' });
      }),
    drained: async () => {
      const t0 = Date.now();
      let calm = 0;
      while (Date.now() - t0 < 180_000) {
        const p = await poolOf();
        calm = p.waiting === 0 && p.idle === p.total ? calm + 1 : 0;
        if (calm >= 3) break;
        await sleep(500);
      }
      return Date.now() - t0;
    },
    heap: () =>
      new Promise<Heap>((resolve) => {
        const onMessage = (m: any) => {
          if (m?.type === 'heap') {
            child.off('message', onMessage);
            resolve(m);
          }
        };
        child.on('message', onMessage);
        child.send({ type: 'heap' });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.send({ type: 'shutdown' });
        setTimeout(() => {
          child.kill();
          resolve();
        }, 15_000).unref();
      }),
  };
}

// ── requests ─────────────────────────────────────────────────────────────────

interface Result {
  group: string;
  word: string;
  status: number;
  ms: number;
  partial: boolean | null;
  /** data.enrichment.status of the answer */
  enrichment: string | null;
  retryAfter: string | null;
  error?: string;
}

async function lookup(app: AppProcess, ebookId: string, token: string, w: string, group: string): Promise<Result> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${app.base}/api/v1/ebooks/${ebookId}/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ word: w }),
    });
    const body: any = await res.json().catch(() => null);
    return { group, word: w, status: res.status, ms: Math.round(performance.now() - t0), partial: body?.data?.partial ?? null, enrichment: body?.data?.enrichment?.status ?? null, retryAfter: res.headers.get('retry-after') };
  } catch (err) {
    return { group, word: w, status: 0, ms: Math.round(performance.now() - t0), partial: null, enrichment: null, retryAfter: null, error: String((err as Error).message) };
  }
}

const countStatuses = (rs: Result[]) => rs.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});

// ── fixtures ─────────────────────────────────────────────────────────────────

async function snapshotGoogleUsage() {
  return (await pool.query(`SELECT period, unit, used FROM api_usage_counters WHERE provider = 'google_translate'`)).rows as Array<{ period: string; unit: string; used: string }>;
}
async function restoreGoogleUsage(before: Array<{ period: string; unit: string; used: string }>) {
  const now = (await pool.query(`SELECT period, unit, used FROM api_usage_counters WHERE provider = 'google_translate'`)).rows as typeof before;
  for (const row of now) {
    const original = before.find((b) => b.period === row.period && b.unit === row.unit);
    if (!original) await pool.query(`DELETE FROM api_usage_counters WHERE provider = 'google_translate' AND period = $1 AND unit = $2`, [row.period, row.unit]);
    else if (original.used !== row.used) await pool.query(`UPDATE api_usage_counters SET used = $3 WHERE provider = 'google_translate' AND period = $1 AND unit = $2`, [row.period, row.unit, original.used]);
  }
}

// ── the scenarios ────────────────────────────────────────────────────────────

const report: Record<string, unknown> = {};

async function scenarioBaseline(mock: MockUpstream, ebookId: string, tokens: string[]): Promise<void> {
  console.log(`\nA · BASELINE   ${SAME} requests for one new word at once + ${DISTINCT} different new words over ${WINDOW_S} s, upstream latency ${LATENCY_MS} ms, ${ROUNDS} round(s)`);
  const app = await startApp(mock, DEADLINE_MS === 3000 ? {} : { LOOKUP_TOTAL_DEADLINE_MS: String(DEADLINE_MS), LOOKUP_UPSTREAM_TIMEOUT_MS: String(Math.min(30_000, DEADLINE_MS)) });
  try {
    console.log(`  app: LOOKUP_TOTAL_DEADLINE_MS=${DEADLINE_MS}, pg pool max 10 (the pg default), database as above`);
    mock.reset();
    mock.setControl({ google: { latencyMs: LATENCY_MS }, fd: { latencyMs: LATENCY_MS } });

    // warm-up: the pool's connections, the code paths, the JIT (not measured)
    await app.warm(10);
    for (let i = 0; i < 6; i++) await lookup(app, ebookId, tokens[i], word(`warm${alpha(i)}`), 'warm');
    mock.reset();
    mock.setControl({ google: { latencyMs: LATENCY_MS }, fd: { latencyMs: LATENCY_MS } });
    app.lookupLogs.length = 0;

    const heapBefore = await app.heap();
    console.log(`  heap before : used ${mb(heapBefore.heapUsed)} MB · rss ${mb(heapBefore.rss)} MB`);
    const heaps: Heap[] = [heapBefore];
    const roundReports: unknown[] = [];

    for (let round = 1; round <= ROUNDS; round++) {
      const shared = word(`shared${alpha(round)}`);
      const results: Result[] = [];
      const t0 = Date.now();
      const jobs: Promise<void>[] = [];
      let peakWaiting = 0;
      const sampler = setInterval(() => void app.pool().then((p) => (peakWaiting = Math.max(peakWaiting, p.waiting))), 400);

      // the burst: all at the same instant
      for (let i = 0; i < SAME; i++) jobs.push(lookup(app, ebookId, tokens[10 + i], shared, 'same').then((r) => void results.push(r)));
      // the trickle: DISTINCT words, one every WINDOW/DISTINCT seconds
      for (let i = 0; i < DISTINCT; i++) {
        jobs.push(
          sleep((i * WINDOW_S * 1000) / Math.max(1, DISTINCT)).then(() =>
            lookup(app, ebookId, tokens[10 + SAME + i], word(`r${alpha(round)}d${alpha(i)}`), 'distinct').then((r) => void results.push(r))
          )
        );
      }
      await Promise.all(jobs);
      const wall = Date.now() - t0;
      clearInterval(sampler);

      const same = results.filter((r) => r.group === 'same');
      const distinct = results.filter((r) => r.group === 'distinct');
      const all = summarize(results.map((r) => r.ms));
      const sLat = summarize(same.map((r) => r.ms));
      const dLat = summarize(distinct.map((r) => r.ms));

      console.log(`\n  round ${round}: ${results.length} requests in ${wall} ms · peak of requests waiting for a database connection: ${peakWaiting}`);
      console.table([
        { group: `same word (${same.length})`, p50: sLat.p50, p95: sLat.p95, p99: sLat.p99, max: sLat.max, statuses: JSON.stringify(countStatuses(same)) },
        { group: `distinct words (${distinct.length})`, p50: dLat.p50, p95: dLat.p95, p99: dLat.p99, max: dLat.max, statuses: JSON.stringify(countStatuses(distinct)) },
        { group: `all (${results.length})`, p50: all.p50, p95: all.p95, p99: all.p99, max: all.max, statuses: JSON.stringify(countStatuses(results)) },
      ]);

      check(results.every((r) => r.status === 200), `round ${round}: every request answered 200 (${JSON.stringify(countStatuses(results))})`);
      check(results.every((r) => r.partial === false), `round ${round}: every answer complete (partial=false)`);

      // flights for the shared word: what the mock saw vs what the app logged
      await sleep(500);
      const stats = mock.stats();
      const fd = stats.fd.byWord[shared]?.requests ?? 0;
      const gHead = stats.google.byWord[shared]?.headline ?? 0;
      const gDefs = stats.google.byWord[shared]?.definitions ?? 0;
      const logged = app.lookupLogs.filter((l) => l.word === shared);
      const flights = logged.filter((l) => l.shared === false).length;
      const joined = logged.filter((l) => l.shared === true).length;
      console.log(`  shared word: ${flights} flight(s) started, ${joined} request(s) joined one; mock saw Free Dictionary ${fd}, Google headline ${gHead}, Google definitions ${gDefs}`);
      check(fd === flights && gHead === flights && gDefs === flights, `round ${round}: every upstream request belongs to exactly one flight (FD ${fd} = headline ${gHead} = definitions ${gDefs} = flights ${flights}): no flight made a duplicate call`);
      check(flights + joined === SAME, `round ${round}: ${SAME} requests = ${flights} flights + ${joined} joiners`);
      const perWordFd = Object.entries(stats.fd.byWord).filter(([w]) => w.startsWith(word(`r${alpha(round)}d`)));
      check(perWordFd.length === DISTINCT && perWordFd.every(([, v]) => v.requests === 1), `round ${round}: each of the ${DISTINCT} different words reached Free Dictionary exactly once`);

      const flightLogs = app.lookupLogs.filter((l) => l.shared === false && typeof l.local_ms === 'number');
      if (flightLogs.length) {
        const local = summarize(flightLogs.map((l) => l.local_ms));
        const step1 = summarize(flightLogs.map((l) => l.translation_ms ?? 0));
        console.log(`  from the app's own log (${flightLogs.length} flights): local database work p50 ${local.p50} ms, p95 ${local.p95} ms · upstream step 1 p50 ${step1.p50} ms`);
      }
      roundReports.push({ round, peakWaiting, wallMs: wall, same: sLat, distinct: dLat, all, statuses: countStatuses(results), sharedWord: { flights, joined, fd, googleHeadline: gHead, googleDefinitions: gDefs } });
      const drainedMs = await app.drained();
      console.log(`  the pool drained ${drainedMs} ms after the last response (the fire-and-forget word_lookups / words_looked_up inserts)`);
      heaps.push(await app.heap());
      console.log(`  heap after round ${round}: used ${mb(heaps[round].heapUsed)} MB · rss ${mb(heaps[round].rss)} MB`);
    }

    const growth = mb(heaps[heaps.length - 1].heapUsed - heaps[0].heapUsed);
    const lastStep = mb(heaps[heaps.length - 1].heapUsed - heaps[heaps.length - 2].heapUsed);
    console.log(`  heap growth over ${ROUNDS} round(s): ${growth} MB (last round: ${lastStep} MB)`);
    check(growth < 40 && (ROUNDS < 2 || lastStep < 15), `heap did not grow abnormally (${growth} MB in total, ${lastStep} MB in the last round; thresholds 40 / 15 MB)`);
    report.baseline = { latencyMs: LATENCY_MS, rounds: roundReports, heapMB: heaps.map((h) => ({ used: mb(h.heapUsed), total: mb(h.heapTotal), rss: mb(h.rss) })) };

    await app.drained();
    // ── C · F6 on the same app ──
    console.log('\nC · F6 PER-USER LIMIT   one user asks for LOOKUP_MISS_RATE_LIMIT_PER_MIN + 5 new words at once');
    const limit = 20;
    const user = tokens[tokens.length - 1];
    const words = Array.from({ length: limit + 5 }, (_, i) => word(`six${alpha(i)}`));
    const six = await Promise.all(words.map((w) => lookup(app, ebookId, user, w, 'f6')));
    // "admitted" = got past the limiter (whether the upstream then answered in time is a different question)
    const admitted = six.filter((r) => r.status !== 429).length;
    const ok = six.filter((r) => r.status === 200).length;
    const limited = six.filter((r) => r.status === 429);
    console.log(`  ${admitted} admitted (${ok} answered 200; statuses ${JSON.stringify(countStatuses(six))}), ${limited.length} refused with 429 (Retry-After: ${[...new Set(limited.map((r) => r.retryAfter))].join(', ')})`);
    check(admitted === limit && limited.length === 5, `exactly ${limit} misses admitted, the other 5 refused with 429 (got ${admitted} and ${limited.length})`);
    check(limited.every((r) => Number.isInteger(Number(r.retryAfter)) && Number(r.retryAfter) >= 1 && Number(r.retryAfter) <= 60), 'every 429 carries an integer Retry-After between 1 and 60 seconds');
    const refusedAtUpstream = limited.filter((r) => (mock.stats().fd.byWord[r.word]?.requests ?? 0) > 0);
    check(refusedAtUpstream.length === 0, 'a refused request never reached Free Dictionary');
    const again = await lookup(app, ebookId, user, word('sixafter'), 'f6');
    check(again.status === 429, 'one more miss from the same user is still 429');
    const other = await lookup(app, ebookId, tokens[1], word('sixother'), 'f6');
    check(other.status === 200, 'another user is not affected');
    report.f6 = { limit, admitted, answered: ok, refused: limited.length, retryAfter: [...new Set(limited.map((r) => r.retryAfter))] };
  } finally {
    await app.stop();
  }
}

async function scenarioSingleFlight(mock: MockUpstream, ebookId: string, tokens: string[]): Promise<void> {
  console.log(`\nB · SINGLE-FLIGHT   ${SAME} requests for one new word while the one upstream flight takes 10 s (so every arrival lands inside it)`);
  const slow = word('slowflight');
  // timeouts raised so that a 10 s flight is a normal answer, and the second Google request (definitions) is off so that
  // "one Google request" is literal
  const app = await startApp(mock, { LOOKUP_UPSTREAM_TIMEOUT_MS: '30000', LOOKUP_TOTAL_DEADLINE_MS: '60000', LOOKUP_TRANSLATE_DEFINITIONS: 'false' });
  try {
    await app.warm(10);
    for (let i = 0; i < 4; i++) await lookup(app, ebookId, tokens[i], word(`sfwarm${alpha(i)}`), 'warm');
    mock.reset();
    mock.setControl({ rules: [{ provider: '*', words: [slow], behavior: { latencyMs: 10_000 } }] });
    app.lookupLogs.length = 0;

    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: SAME }, (_, i) => lookup(app, ebookId, tokens[10 + i], slow, 'same')));
    const wall = Date.now() - t0;
    const lat = summarize(results.map((r) => r.ms));
    const stats = mock.stats();
    const fd = stats.fd.byWord[slow]?.requests ?? 0;
    const g = stats.google.byWord[slow]?.requests ?? 0;
    const logged = app.lookupLogs.filter((l) => l.word === slow);
    const flights = logged.filter((l) => l.shared === false).length;
    console.log(`  ${results.length} requests in ${wall} ms · statuses ${JSON.stringify(countStatuses(results))} · latency p50 ${lat.p50} ms, p95 ${lat.p95} ms, max ${lat.max} ms`);
    console.log(`  the mock saw: Free Dictionary ${fd} request(s), Google ${g} request(s) · the app logged ${flights} flight(s) and ${logged.length - flights} joiner(s)`);
    check(results.every((r) => r.status === 200 && r.partial === false), 'all 200 requests answered 200 with a complete answer');
    check(fd === 1, `Free Dictionary received exactly 1 request for the shared word (got ${fd})`);
    check(g === 1, `Google received exactly 1 request for the shared word (got ${g})`);
    check(flights === 1 && logged.length === SAME, `the app logged 1 flight and ${SAME - 1} joiners (got ${flights} flight(s) among ${logged.length} lookups)`);
    report.singleFlight = { requests: SAME, wallMs: wall, latency: lat, freeDictionaryRequests: fd, googleRequests: g, flights };
  } finally {
    await app.stop();
  }
}

/**
 * D · what the visitor waits for, with the job send AFTER the answer (docs/lookup-spec.md §5, version 1.5). The real sender (pg-boss, role
 * "sender": it only inserts) works in a private schema nobody processes. Sequential on purpose: one request at a time, so the figures are
 * the cost of the code and of the database round trips, not of a queue of requests for a connection.
 */
async function scenarioJobSend(mock: MockUpstream, ebookId: string, tokens: string[]): Promise<void> {
  console.log(`\nD · ANSWER AND JOB SEND   ${SEND} new words one after the other, real pg-boss sender in schema lt_${RUN} (no worker), upstream latency ${LATENCY_MS} ms`);
  const schema = `lt_${RUN}`;
  const period = currentPeriod('day');
  const prefix = word('send');
  const counter = async () => (await pool.query(`SELECT used FROM api_usage_counters WHERE provider = 'enrichment' AND unit = 'jobs' AND period = $1`, [period])).rows[0];
  const counterBefore = await counter();
  const ledger = async () => Number((await pool.query(`SELECT COUNT(*)::int AS n FROM word_enrichment_jobs WHERE word LIKE $1`, [`${prefix}%`])).rows[0].n);
  const untilLedger = async (n: number, limitMs: number) => {
    const t0 = Date.now();
    while ((await ledger()) < n && Date.now() - t0 < limitMs) await sleep(400);
  };

  const app = await startApp(mock, { ENRICHMENT_ENABLED: 'true', ENRICHMENT_WORKER_ENABLED: 'false', PGBOSS_SCHEMA: schema });
  try {
    mock.reset();
    mock.setControl({ google: { latencyMs: LATENCY_MS }, fd: { latencyMs: LATENCY_MS } });
    await app.warm(10);
    // The first send starts pg-boss and creates its private schema (migrations over a far-away database): not measured.
    const warmWords = [0, 1, 2].map((i) => `${prefix}w${alpha(i)}`);
    for (const w of warmWords) await lookup(app, ebookId, tokens[0], w, 'warm');
    await untilLedger(warmWords.length, 180_000);
    app.enrichLogs.length = 0;

    const results: Result[] = [];
    // eight users take turns: the per-user limit (20 new words a minute) is not what is being measured
    for (let i = 0; i < SEND; i++) results.push(await lookup(app, ebookId, tokens[1 + (i % 8)], `${prefix}m${alpha(i)}`, 'send'));
    await untilLedger(warmWords.length + SEND, 120_000);
    await sleep(800); // the last log lines

    const sendLog = new Map(app.enrichLogs.map((l) => [l.word as string, l]));
    const sendMs = results.map((r) => sendLog.get(r.word)?.enqueue_ms).filter((v): v is number => typeof v === 'number');
    const answer = summarize(results.map((r) => r.ms));
    console.log(`  ${results.length} lookups; statuses ${JSON.stringify(countStatuses(results))}; the app logged ${app.enrichLogs.length} job sends (${sendMs.length} with a timing)`);
    const rows: Array<Record<string, unknown>> = [{ what: 'answer (the send runs after it)', n: answer.n, p50: answer.p50, p95: answer.p95, max: answer.max }];
    if (sendMs.length === results.length) {
      const withSend = summarize(results.map((r) => r.ms + (sendLog.get(r.word)!.enqueue_ms as number)));
      const alone = summarize(sendMs);
      rows.push({ what: 'answer + send (the visitor waited for the send, as before spec 1.5)', n: withSend.n, p50: withSend.p50, p95: withSend.p95, max: withSend.max });
      rows.push({ what: 'the job send alone (enqueue_ms)', n: alone.n, p50: alone.p50, p95: alone.p95, max: alone.max });
      report.jobSend = { latencyMs: LATENCY_MS, words: SEND, answer, answerPlusSend: withSend, sendAlone: alone, statuses: countStatuses(results) };
      check(withSend.p95 > answer.p95, `the answer is faster than answer + send (p95 ${answer.p95} ms against ${withSend.p95} ms)`);
    } else {
      report.jobSend = { latencyMs: LATENCY_MS, words: SEND, answer, statuses: countStatuses(results), note: 'no lookup_enrich lines: the app did not send in the background' };
    }
    console.table(rows);

    check(results.every((r) => r.status === 200 && r.partial === false), 'every answer is 200 and complete');
    check(results.every((r) => r.enrichment === 'queued'), `every answer says enrichment.status = "queued" (${JSON.stringify([...new Set(results.map((r) => r.enrichment))])})`);
    check((await ledger()) >= warmWords.length + SEND, `every word reached the job ledger (${await ledger()} rows for ${warmWords.length + SEND} words): the send really ran`);
    check(app.enrichLogs.every((l) => l.status === 'queued'), 'every background send was queued (none already_queued / skipped / failed)');
  } finally {
    await app.stop();
    // what scenario D made: ledger rows, the daily slot each of them took, the private pg-boss schema
    const made = await ledger();
    await pool.query(`DELETE FROM word_enrichment_jobs WHERE word LIKE $1`, [`${prefix}%`]);
    if (made > 0) await pool.query(`UPDATE api_usage_counters SET used = GREATEST(0, used - $1) WHERE provider = 'enrichment' AND unit = 'jobs' AND period = $2`, [made, period]);
    if (!counterBefore) await pool.query(`DELETE FROM api_usage_counters WHERE provider = 'enrichment' AND unit = 'jobs' AND period = $1 AND used = 0`, [period]);
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  console.log(`database : ${(() => { try { const u = new URL(process.env.DATABASE_URL ?? ''); return `${u.hostname}${u.pathname}`; } catch { return '(DATABASE_URL)'; } })()}`);
  console.log(`node ${process.version} · ${process.platform} · same=${SAME} distinct=${DISTINCT} window=${WINDOW_S}s latency=${LATENCY_MS}ms rounds=${ROUNDS}`);

  const mock = await startMockUpstream();
  const usageBefore = await snapshotGoogleUsage();
  const userCount = 10 + SAME + DISTINCT + 4;
  let ebookId = '';
  try {
    const { rows: users } = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, level)
       SELECT 'lt-' || $1 || '-' || g || '@example.com', 'not-a-real-hash', 'LT ' || g, 'beginner' FROM generate_series(1, $2) g
       RETURNING id, email`,
      [RUN, userCount]
    );
    const tokens = users.map((u) => jwt.sign({ userId: u.id, email: u.email }, process.env.JWT_SECRET as string, { expiresIn: '1h' }));
    const {
      rows: [ebook],
    } = await pool.query(`INSERT INTO ebooks (title, author, level, required_plan, status, epub_file_url) VALUES ($1, 'LT', 'beginner', 'free', 'published', '/lt.epub') RETURNING id`, [`LT ebook ${RUN}`]);
    ebookId = ebook.id;
    console.log(`fixtures : ${users.length} users, 1 ebook (run ${RUN})`);

    if (!ONLY_SEND) await scenarioBaseline(mock, ebookId, tokens);
    if (!ONLY_SEND && !SKIP_SLOW) await scenarioSingleFlight(mock, ebookId, tokens);
    if (SEND > 0) await scenarioJobSend(mock, ebookId, tokens);
  } finally {
    await sleep(500);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`lt-${RUN}-%`]);
    if (ebookId) await pool.query(`DELETE FROM ebooks WHERE id = $1`, [ebookId]);
    await restoreGoogleUsage(usageBefore);
    await mock.close();
    await pool.end();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? '; FAILED: ' + failed.map((f) => f.text).join(' | ') : ''}`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ args: { SAME, DISTINCT, WINDOW_S, LATENCY_MS, ROUNDS }, node: process.version, report, checks }, null, 2));
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('loadtest failed:', (err as Error)?.message ?? err);
    process.exit(1);
  });
