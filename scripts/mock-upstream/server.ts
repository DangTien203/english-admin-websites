/**
 * Mock upstream server for development and tests ONLY (docs/lookup-loadtest.md, docs/lookup-runbook.md).
 *
 * One local HTTP server that imitates the three public services the lookup fast path and the enrichment job call:
 *
 *   Google Cloud Translation v2   POST /language/translate/v2
 *   Free Dictionary API           GET  /api/v2/entries/en/:word
 *   Datamuse                      GET  /words?rel_syn=<w> | rel_ant=<w>&max=<n>
 *
 * Answers come from the fixtures captured in P2/P3 (tests/fixtures/lookup/...); words without a fixture are synthesized
 * from them. Behaviour is switched at run time through /__control (latency, 5xx rate, 429 with or without Retry-After,
 * hang, HTML instead of JSON, wrong array length, 404 for chosen words) and observed through /__stats.
 *
 *   GET  /__control   current behaviour           POST /__control   change it (JSON body, see ControlConfig)
 *   GET  /__stats     request counters            POST /__reset     counters and behaviour back to the defaults
 *                                                 (?keep=control keeps the behaviour, ?keep=stats keeps the counters)
 *
 * Use it by pointing the existing variables at it (no new variable exists):
 *   GOOGLE_TRANSLATE_BASE_URL=http://127.0.0.1:<port>/language/translate/v2
 *   FREE_DICTIONARY_BASE_URL=http://127.0.0.1:<port>/api/v2/entries/en
 *   DATAMUSE_BASE_URL=http://127.0.0.1:<port>
 *
 * Safety: it listens on 127.0.0.1 only, answers 403 to any non-loopback peer, refuses to start when NODE_ENV=production,
 * keeps no API key (it only notes whether a key arrived in the header or, wrongly, in the URL), and lives under scripts/,
 * which tsconfig.json excludes from the production build.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export type ProviderId = 'google' | 'fd' | 'datamuse';

export type Mode =
  | 'ok' // the normal fixture-based answer
  | 'status' // answer with `status` (default 500) and a small error body
  | 'hang' // never answer; the socket stays open until the client gives up
  | 'drop' // close the connection without any answer (a network error for the client)
  | 'html' // an HTML page instead of JSON, `status` default 404 (the Free Dictionary CDN anomaly)
  | 'invalid_json' // 200 with a body that is not JSON
  | 'short_array' // google: one translation fewer than the texts sent
  | 'not_found'; // fd: the API's own JSON 404 ("No Definitions Found")

export interface Behavior {
  mode?: Mode;
  /** HTTP status for modes 'status' and 'html'. */
  status?: number;
  /** Retry-After header value (seconds or an HTTP date) sent with mode 'status'. */
  retryAfter?: number | string;
  /** Fixed delay before answering, in ms (any mode but 'hang'). */
  latencyMs?: number;
  /** Extra random delay in [0, jitterMs]. */
  jitterMs?: number;
  /** Probability [0..1] that a 5xx (errorStatus) is returned instead of the normal answer. */
  errorRate?: number;
  /** Status of the random errors, default 503. */
  errorStatus?: number;
  /** The first N matching requests fail with errorStatus, then the normal behaviour resumes. */
  failFirst?: number;
  /** google only: the error message repeats the API key the request carried (what a careless provider could do). */
  echoKey?: boolean;
}

export interface Rule {
  provider: ProviderId | '*';
  /** Exact words, or a prefix ending in "*" (e.g. "qzq*"). For google a request matches when ANY of its texts matches. */
  words: string[];
  behavior: Behavior;
}

export interface ControlConfig {
  google?: Behavior | null;
  fd?: Behavior | null;
  datamuse?: Behavior | null;
  /** Word-specific behaviour. Evaluated in order, the first matching rule wins over the provider default. */
  rules?: Rule[];
  /** What Free Dictionary says for a word without a fixture: a synthetic entry (default) or its 404. */
  unknownWord?: 'synthesize' | 'not_found';
  /** word → fixture word: the entry of "hello" is served for "zorp" when aliases = { zorp: 'hello' }. */
  aliases?: Record<string, string>;
  /** Seed of the generator behind errorRate and jitter. */
  seed?: number;
}

interface WordStats {
  requests: number;
  headline?: number;
  definitions?: number;
}

interface ProviderStats {
  requests: number;
  /** Peak number of requests being handled at the same moment (hung ones included). */
  maxConcurrent: number;
  statuses: Record<string, number>;
  byWord: Record<string, WordStats>;
  hung: number;
  /** google only: characters received in q, and how many requests were headline / definition requests. */
  chars?: number;
  headlineRequests?: number;
  definitionRequests?: number;
  /** Requests that carried the API key in the URL (a leak: the real clients never do that). */
  keyInUrl?: number;
  /** Requests that carried a key header (the value is never stored). */
  keyHeaderSeen?: number;
}

export interface MockStats {
  startedAt: string;
  total: number;
  google: ProviderStats;
  fd: ProviderStats;
  datamuse: ProviderStats;
}

export interface MockUpstream {
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  /** The three base URLs, ready for the existing environment variables. */
  env: { GOOGLE_TRANSLATE_BASE_URL: string; FREE_DICTIONARY_BASE_URL: string; DATAMUSE_BASE_URL: string };
  stats(): MockStats;
  control(): Required<Pick<ControlConfig, 'unknownWord' | 'seed'>> & ControlConfig;
  setControl(patch: ControlConfig): void;
  reset(keep?: 'control' | 'stats'): void;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'lookup');

// ── fixtures ─────────────────────────────────────────────────────────────────

interface GoogleFixture {
  word: string;
  headline: string;
  queries: string[];
  translations: string[];
}

function loadGoogleFixtures(): { headlines: Map<string, string>; prefixed: Map<string, string> } {
  const headlines = new Map<string, string>();
  const prefixed = new Map<string, string>();
  const dir = path.join(FIXTURES, 'google-prefix');
  if (!fs.existsSync(dir)) return { headlines, prefixed };
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const fx = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as GoogleFixture;
    if (fx.word && fx.headline) headlines.set(fx.word.toLowerCase(), fx.headline);
    (fx.queries ?? []).forEach((q, i) => {
      if (fx.translations?.[i]) prefixed.set(q, fx.translations[i]);
    });
  }
  return { headlines, prefixed };
}

function loadFreeDictionaryFixtures(): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  const dir = path.join(FIXTURES, 'free-dictionary');
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const fx = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (fx?.status === 200 && Array.isArray(fx.body)) out.set(String(fx.word).toLowerCase(), fx.body);
  }
  return out;
}

const NOT_FOUND_BODY = {
  title: 'No Definitions Found',
  message: "Sorry pal, we couldn't find definitions for the word you were looking for.",
  resolution: 'You can try the search again at later time or head to the web instead.',
};

/** A copy of `source` that talks about `word` instead of the fixture's own headword. */
function renameEntry(source: unknown[], from: string, to: string): unknown[] {
  const text = JSON.stringify(source).split(from).join(to).split(capitalize(from)).join(capitalize(to));
  return JSON.parse(text);
}
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ── deterministic randomness (errorRate, jitter) ─────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const emptyProvider = (kind: ProviderId): ProviderStats => ({
  requests: 0,
  maxConcurrent: 0,
  statuses: {},
  byWord: {},
  hung: 0,
  ...(kind === 'google' ? { chars: 0, headlineRequests: 0, definitionRequests: 0 } : {}),
  keyInUrl: 0,
  keyHeaderSeen: 0,
});

const wordMatches = (patterns: string[], word: string): boolean =>
  patterns.some((p) => (p.endsWith('*') ? word.startsWith(p.slice(0, -1)) : p === word));

// ── the server ───────────────────────────────────────────────────────────────

export async function startMockUpstream(opts: { port?: number } = {}): Promise<MockUpstream> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('the mock upstream server is for development and tests only; it refuses to start when NODE_ENV=production');
  }

  const googleFx = loadGoogleFixtures();
  const fdFx = loadFreeDictionaryFixtures();
  const hello = fdFx.get('hello');

  let control: ControlConfig = { unknownWord: 'synthesize', seed: 1 };
  let rng = mulberry32(1);
  let failed = new Map<string, number>();
  const newStats = (): MockStats => ({
    startedAt: new Date().toISOString(),
    total: 0,
    google: emptyProvider('google'),
    fd: emptyProvider('fd'),
    datamuse: emptyProvider('datamuse'),
  });
  let stats = newStats();
  const inflight: Record<ProviderId, number> = { google: 0, fd: 0, datamuse: 0 };

  /** Behaviour for this request: first matching rule, else the provider default, else normal. */
  function behaviorFor(provider: ProviderId, words: string[]): { behavior: Behavior; key: string } {
    for (const [i, rule] of (control.rules ?? []).entries()) {
      if ((rule.provider === provider || rule.provider === '*') && words.some((w) => wordMatches(rule.words, w))) {
        return { behavior: rule.behavior, key: `rule:${i}` };
      }
    }
    return { behavior: control[provider] ?? {}, key: `provider:${provider}` };
  }

  function record(provider: ProviderId, words: string[], kind: 'headline' | 'definitions' | 'other', status: number, chars = 0, keyInUrl = false, keyHeader = false) {
    const p = stats[provider];
    p.statuses[String(status)] = (p.statuses[String(status)] ?? 0) + 1;
    if (keyInUrl) p.keyInUrl = (p.keyInUrl ?? 0) + 1;
    if (keyHeader) p.keyHeaderSeen = (p.keyHeaderSeen ?? 0) + 1;
    if (provider === 'google') {
      p.chars = (p.chars ?? 0) + chars;
      if (kind === 'headline') p.headlineRequests = (p.headlineRequests ?? 0) + 1;
      if (kind === 'definitions') p.definitionRequests = (p.definitionRequests ?? 0) + 1;
    }
  }

  function countWords(provider: ProviderId, words: string[], kinds: Array<'headline' | 'definitions' | 'other'>) {
    const p = stats[provider];
    words.forEach((w, i) => {
      const s = (p.byWord[w] ??= { requests: 0 });
      s.requests += 1;
      if (provider === 'google') {
        if (kinds[i] === 'headline') s.headline = (s.headline ?? 0) + 1;
        if (kinds[i] === 'definitions') s.definitions = (s.definitions ?? 0) + 1;
      }
    });
  }

  /** Applies latency, hang and the failure modes common to all providers. Returns true when the request was fully answered here. */
  async function applyBehavior(
    provider: ProviderId,
    behavior: Behavior,
    key: string,
    res: http.ServerResponse,
    done: (status: number) => void,
    echo?: string
  ): Promise<boolean> {
    if (behavior.mode === 'hang') {
      stats[provider].hung += 1;
      return true; // the socket stays open; closeAllConnections() cleans up
    }

    const delay = (behavior.latencyMs ?? 0) + (behavior.jitterMs ? Math.floor(rng() * behavior.jitterMs) : 0);
    if (delay > 0) await sleep(delay);

    let failWith: number | undefined;
    if (behavior.failFirst && (failed.get(key) ?? 0) < behavior.failFirst) {
      failed.set(key, (failed.get(key) ?? 0) + 1);
      failWith = behavior.errorStatus ?? 503;
    } else if (behavior.errorRate && rng() < behavior.errorRate) {
      failWith = behavior.errorStatus ?? 503;
    } else if (behavior.mode === 'status') {
      failWith = behavior.status ?? 500;
    }

    if (failWith !== undefined) {
      const headers: Record<string, string> = { 'content-type': provider === 'fd' && failWith >= 500 ? 'text/plain' : 'application/json' };
      if (behavior.retryAfter !== undefined) headers['retry-after'] = String(behavior.retryAfter);
      const body =
        provider === 'fd' && failWith >= 500
          ? `error code: ${failWith}`
          : JSON.stringify({ error: { code: failWith, message: echo && behavior.echoKey ? `API key not valid: ${echo}` : `mock upstream error ${failWith}`, status: 'MOCK_ERROR' } });
      res.writeHead(failWith, headers).end(body);
      done(failWith);
      return true;
    }

    if (behavior.mode === 'drop') {
      stats[provider].statuses.dropped = (stats[provider].statuses.dropped ?? 0) + 1;
      res.socket?.destroy();
      return true;
    }
    if (behavior.mode === 'html') {
      const status = behavior.status ?? 404;
      res.writeHead(status, { 'content-type': 'text/html;charset=ISO-8859-1' }).end('<!DOCTYPE html><html><head><title>404 page</title></head><body><h1>404</h1></body></html>');
      done(status);
      return true;
    }
    if (behavior.mode === 'invalid_json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data": {"translations": [ this is not json');
      done(200);
      return true;
    }
    return false;
  }

  // ── Google ──
  function googleTranslate(text: string, index: number): string {
    const sep = text.indexOf(': ');
    if (sep < 0) {
      const w = text.trim().toLowerCase();
      return googleFx.headlines.get(w) ?? `dịch ${w}`;
    }
    const exact = googleFx.prefixed.get(text);
    if (exact) return exact;
    const w = text.slice(0, sep).trim().toLowerCase();
    return `nghĩa của ${w}: định nghĩa tiếng Việt số ${index + 1}`;
  }

  async function handleGoogle(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const bodyText = await readBody(req);
    let q: string[] = [];
    try {
      const parsed = JSON.parse(bodyText);
      q = Array.isArray(parsed?.q) ? parsed.q.map(String) : typeof parsed?.q === 'string' ? [parsed.q] : [];
    } catch {
      /* answered as a 400 below */
    }
    const keyInUrl = url.searchParams.has('key');
    const keyHeader = typeof req.headers['x-goog-api-key'] === 'string' && req.headers['x-goog-api-key'] !== '';
    const kinds = q.map((t) => (t.includes(': ') ? ('definitions' as const) : ('headline' as const)));
    const words = q.map((t) => (t.includes(': ') ? t.slice(0, t.indexOf(': ')) : t).trim().toLowerCase());
    const chars = q.reduce((n, t) => n + t.length, 0);
    const kind: 'headline' | 'definitions' | 'other' = kinds.every((k) => k === 'definitions') && kinds.length > 0 ? 'definitions' : kinds.includes('headline') ? 'headline' : 'other';
    countWords('google', [...new Set(words)], [...new Set(words)].map((w) => kinds[words.indexOf(w)]));

    const finish = (status: number) => record('google', words, kind, status, chars, keyInUrl, keyHeader);

    if (q.length === 0) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 400, message: 'Required: q', status: 'INVALID_ARGUMENT' } }));
      return finish(400);
    }
    if (!keyHeader && !keyInUrl) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }));
      return finish(400);
    }

    const { behavior, key } = behaviorFor('google', words);
    const echoed = typeof req.headers['x-goog-api-key'] === 'string' ? (req.headers['x-goog-api-key'] as string) : undefined;
    if (await applyBehavior('google', behavior, key, res, finish, echoed)) return;

    let translations = q.map((t, i) => ({ translatedText: googleTranslate(t, i), detectedSourceLanguage: 'en' }));
    if (behavior.mode === 'short_array') translations = translations.slice(0, Math.max(0, translations.length - 1));
    res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' }).end(JSON.stringify({ data: { translations } }));
    finish(200);
  }

  // ── Free Dictionary ──
  async function handleFreeDictionary(_req: http.IncomingMessage, res: http.ServerResponse, word: string, url: URL) {
    countWords('fd', [word], ['other']);
    const finish = (status: number) => record('fd', [word], 'other', status, 0, url.searchParams.has('key'));

    const { behavior, key } = behaviorFor('fd', [word]);
    if (await applyBehavior('fd', behavior, key, res, finish)) return;

    if (behavior.mode === 'not_found') {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(NOT_FOUND_BODY));
      return finish(404);
    }

    const aliasOf = control.aliases?.[word];
    let body: unknown[] | undefined = fdFx.get(aliasOf ?? word);
    if (body && aliasOf && aliasOf !== word) body = renameEntry(body, aliasOf, word);
    if (!body && (control.unknownWord ?? 'synthesize') === 'synthesize' && hello) body = renameEntry(hello, 'hello', word);

    if (!body) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(NOT_FOUND_BODY));
      return finish(404);
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    finish(200);
  }

  // ── Datamuse ──
  async function handleDatamuse(_req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const syn = url.searchParams.get('rel_syn');
    const ant = url.searchParams.get('rel_ant');
    const word = (syn ?? ant ?? '').toLowerCase();
    countWords('datamuse', [word], ['other']);
    const finish = (status: number) => record('datamuse', [word], 'other', status, 0, url.searchParams.has('key'));

    const { behavior, key } = behaviorFor('datamuse', [word]);
    if (await applyBehavior('datamuse', behavior, key, res, finish)) return;

    const max = Math.min(Number(url.searchParams.get('max') ?? 100) || 100, 1000);
    const list = syn !== null ? ['related', 'akin', 'similar', 'kindred'] : ['opposite', 'contrary'];
    const items = list.slice(0, max).map((w, i) => ({ word: w, score: 1000 - i * 100 }));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(items));
    finish(200);
  }

  // ── routing ──
  const server = http.createServer(async (req, res) => {
    const peer = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) {
      res.writeHead(403).end('loopback only');
      return;
    }

    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const route = url.pathname;
    const sendJson = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

    try {
      // control plane (never counted, never delayed)
      if (route === '/__health') return void sendJson(200, { ok: true });
      if (route === '/__stats') return void sendJson(200, stats);
      if (route === '/__control' && req.method === 'GET') return void sendJson(200, control);
      if (route === '/__control' && req.method === 'POST') {
        const patch = JSON.parse((await readBody(req)) || '{}') as ControlConfig;
        applyControl(patch);
        return void sendJson(200, control);
      }
      if (route === '/__reset' && req.method === 'POST') {
        const keep = url.searchParams.get('keep');
        reset(keep === 'control' || keep === 'stats' ? keep : undefined);
        return void sendJson(200, { ok: true });
      }

      let provider: ProviderId | undefined;
      if (route === '/language/translate/v2' && req.method === 'POST') provider = 'google';
      else if (route.startsWith('/api/v2/entries/en/') && req.method === 'GET') provider = 'fd';
      else if (route === '/words' && req.method === 'GET') provider = 'datamuse';
      if (!provider) return void sendJson(404, { error: 'unknown route' });

      stats.total += 1;
      stats[provider].requests += 1;
      inflight[provider] += 1;
      stats[provider].maxConcurrent = Math.max(stats[provider].maxConcurrent, inflight[provider]);
      res.on('close', () => {
        inflight[provider!] -= 1;
      });

      if (provider === 'google') await handleGoogle(req, res, url);
      else if (provider === 'fd') await handleFreeDictionary(req, res, decodeURIComponent(route.slice('/api/v2/entries/en/'.length)).toLowerCase(), url);
      else await handleDatamuse(req, res, url);
    } catch (err) {
      if (!res.headersSent) sendJson(500, { error: String((err as Error)?.message ?? err) });
    }
  });

  function applyControl(patch: ControlConfig): void {
    const next: ControlConfig = { ...control };
    for (const k of ['google', 'fd', 'datamuse'] as const) {
      if (k in patch) {
        if (patch[k] === null) delete next[k];
        else next[k] = patch[k] ?? undefined;
      }
    }
    if ('rules' in patch) next.rules = patch.rules ?? [];
    if ('unknownWord' in patch && patch.unknownWord) next.unknownWord = patch.unknownWord;
    if ('aliases' in patch) next.aliases = patch.aliases ?? {};
    if ('seed' in patch && typeof patch.seed === 'number') {
      next.seed = patch.seed;
      rng = mulberry32(patch.seed);
    }
    failed = new Map(); // a new behaviour starts counting failFirst from zero
    control = next;
  }

  function reset(keep?: 'control' | 'stats'): void {
    if (keep !== 'stats') {
      control = { unknownWord: 'synthesize', seed: 1 };
      rng = mulberry32(1);
      failed = new Map();
    }
    if (keep !== 'control') stats = newStats();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, HOST, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${HOST}:${port}`;

  return {
    url,
    port,
    env: {
      GOOGLE_TRANSLATE_BASE_URL: `${url}/language/translate/v2`,
      FREE_DICTIONARY_BASE_URL: `${url}/api/v2/entries/en`,
      DATAMUSE_BASE_URL: url,
    },
    stats: () => JSON.parse(JSON.stringify(stats)),
    control: () => JSON.parse(JSON.stringify(control)),
    setControl: applyControl,
    reset,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── command line: npm run mock:upstream [-- --port 4010] ─────────────────────

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 4010;
  startMockUpstream({ port })
    .then((mock) => {
      console.log(`mock upstream listening on ${mock.url} (loopback only; Ctrl+C to stop)\n`);
      console.log('Point the existing variables at it (for example in a throwaway shell, not in .env):');
      for (const [k, v] of Object.entries(mock.env)) console.log(`  ${k}=${v}`);
      console.log('\nControl:  POST /__control   Stats:  GET /__stats   Reset:  POST /__reset   (docs/lookup-loadtest.md)');
    })
    .catch((err) => {
      console.error(String(err?.message ?? err));
      process.exit(1);
    });
}
