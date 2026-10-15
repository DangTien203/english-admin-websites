/**
 * API keys never leave the process through a log line, an error message, a response, an admin_note or a database row
 * (docs/lookup-spec.md §12.5). Dummy keys with a recognizable shape are put into the environment, the upstreams are made to fail
 * in the ways that tend to leak (a network error whose text holds the URL, a provider that echoes the key back, an SDK error
 * with the key in its message), and EVERYTHING the process prints or returns is searched for them.
 */
import Anthropic from '@anthropic-ai/sdk';
import { bootLookupApp, fixtureWord, RUN, type LookupApp } from '../helpers/lookupApp';
import { configuredSecrets, maskKey, redactSecrets, REDACTED } from '../../utils/redact';
import { GoogleTranslateClient } from '../../services/upstream/googleTranslateClient';
import { classifyAnthropicError } from '../../services/upstream/anthropicEnrichClient';
import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';
import { EnrichmentWorker } from '../../services/queue/enrichmentWorker';
import { errMessage, logEvent } from '../../services/queue/log';
import { AnthropicEnrichClient } from '../../services/upstream/anthropicEnrichClient';
import pool from '../../config/db';
import * as Jobs from '../../models/EnrichmentJob';
import { createHaikuCaller } from '../../services/enrichment/haiku/client';
import { generateDraft } from '../../services/enrichment/draft';
import { createPipeline } from '../../services/enrichment/pipeline';
import { makeBundle, wrow } from '../enrichment/fixtures';

jest.setTimeout(120_000);

const GOOGLE_KEY = 'AIzaSyD-ThisIsAFakeGoogleKey0123456789';
const ANTHROPIC_KEY = 'sk-ant-api03-ThisIsAFakeAnthropicKey0123456789abc';
const SECRETS = [GOOGLE_KEY, ANTHROPIC_KEY];

/** Every console method of the process, captured as one string per call. */
function captureConsole() {
  const out: string[] = [];
  const grab = (...args: unknown[]) => void out.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(' '));
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(grab));
  return { out, restore: () => spies.forEach((s) => s.mockRestore()) };
}

const leaks = (text: string) => SECRETS.filter((s) => text.includes(s));

// ═════════════════════════════════════════════════════════════════════════════
describe('redactSecrets / maskKey', () => {
  const env = { GOOGLE_TRANSLATE_API_KEY: GOOGLE_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY, SESSION_SECRET: 'short', JWT_SECRET: 'a-very-long-jwt-secret-value-0123456789', DATABASE_URL: 'postgresql://user:p%40ssw0rd-123@host/db?sslmode=require' } as NodeJS.ProcessEnv;
  const secrets = configuredSecrets(env);

  it('knows the secrets of the environment, longest first, and ignores values too short to be one', () => {
    expect(secrets).toContain(GOOGLE_KEY);
    expect(secrets).toContain(ANTHROPIC_KEY);
    expect(secrets).toContain('p@ssw0rd-123'); // the database password
    expect(secrets).not.toContain('short');
    expect([...secrets].sort((a, b) => b.length - a.length)).toEqual(secrets);
  });

  it('removes the exact value wherever it appears', () => {
    const text = `GET https://x/y?foo=1 failed, key ${GOOGLE_KEY} twice ${GOOGLE_KEY}; auth ${ANTHROPIC_KEY}`;
    const clean = redactSecrets(text, secrets);
    expect(leaks(clean)).toEqual([]);
    expect(clean).toContain(REDACTED);
  });

  it.each([
    ['a key in a query string', 'GET https://translation.googleapis.com/v2?q=a&key=whatever123456&x=1', 'whatever123456'],
    ['key= after a question mark', 'https://h/p?key=AbCdEf123456', 'AbCdEf123456'],
    ['an x-goog-api-key header', 'headers: {"x-goog-api-key":"zzzzzzzzzzzzzzzz"}', 'zzzzzzzzzzzzzzzz'],
    ['an x-api-key header', 'invalid x-api-key: sk-ant-api03-other-secret-0000', 'other-secret-0000'],
    ['an Authorization header', 'Authorization: Bearer abcdefghijklmnop12345', 'abcdefghijklmnop12345'],
    ['an Anthropic-shaped key the process does not know', 'token sk-ant-api03-NotInTheEnv0123456789', 'NotInTheEnv0123456789'],
    ['a Google-shaped key the process does not know', 'token AIzaSyNotInTheEnvAtAll0123456789ab', 'NotInTheEnvAtAll'],
    ['a password in a connection string', 'connect postgresql://app:Sup3rS3cret@db.example.com/x failed', 'Sup3rS3cret'],
  ])('removes %s', (_label, text, secretPart) => {
    expect(redactSecrets(text, [])).not.toContain(secretPart);
  });

  it('leaves ordinary text alone', () => {
    const text = 'HTTP 429 rate limited, retry after 17 s (request req_abc123), word=serendipity, monkey business';
    expect(redactSecrets(text, [])).toBe(text);
  });

  it('is linear: a megabyte of near-matches takes milliseconds', () => {
    const started = Date.now();
    redactSecrets(('key=' + 'a'.repeat(50) + ' ').repeat(20_000) + 'sk-ant-' + '-'.repeat(500_000) + 'x'.repeat(500_000), []);
    redactSecrets('Bearer ' + ' '.repeat(500_000) + 'x', []);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('maskKey shows the last four characters only', () => {
    expect(maskKey(GOOGLE_KEY)).toBe('…' + GOOGLE_KEY.slice(-4));
    expect(maskKey(GOOGLE_KEY)).not.toContain(GOOGLE_KEY.slice(0, -4));
    expect(maskKey('')).toBe('(none)');
    expect(maskKey(undefined)).toBe('(none)');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the error classes carry no key, whatever text they are given', () => {
  let previous: Record<string, string | undefined>;
  beforeAll(() => {
    previous = { g: process.env.GOOGLE_TRANSLATE_API_KEY, a: process.env.ANTHROPIC_API_KEY };
    process.env.GOOGLE_TRANSLATE_API_KEY = GOOGLE_KEY;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
  });
  afterAll(() => {
    if (previous.g === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
    else process.env.GOOGLE_TRANSLATE_API_KEY = previous.g;
    if (previous.a === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous.a;
  });

  it('UpstreamUnavailable, UpstreamConfigError, BudgetExceeded', () => {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_KEY}`;
    const errors = [
      new UpstreamUnavailable('google_translate', 'network', { message: `request to ${url} failed` }),
      new UpstreamConfigError('google_translate', `HTTP 400 API key ${GOOGLE_KEY} not valid`, 400),
      new BudgetExceeded('anthropic', 'spend_limit', { message: `x-api-key: ${ANTHROPIC_KEY} reached its limit` }),
    ];
    for (const e of errors) {
      expect(leaks(`${e.message}\n${e.stack}\n${String(e)}\n${JSON.stringify({ message: e.message })}`)).toEqual([]);
    }
  });

  it('classifyAnthropicError when the provider echoes the key in its message', () => {
    const body = { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${ANTHROPIC_KEY}` } };
    const e: any = classifyAnthropicError(Anthropic.APIError.generate(401, body, undefined, new Headers({ 'request-id': 'req_1' })));
    expect(e).toBeInstanceOf(UpstreamConfigError);
    expect(leaks(`${e.message}\n${e.stack}`)).toEqual([]);
    expect(e.message).toContain('HTTP 401');
  });

  it('the Google client: a network error that mentions the URL with the key, and a 400 that echoes it', async () => {
    const mk = (fetchImpl: any) =>
      new GoogleTranslateClient(
        { apiKey: GOOGLE_KEY, baseUrl: 'https://translation.googleapis.com/language/translate/v2', monthlyCharLimit: 1_000_000, timeoutMs: 1000, maxAttempts: 1 },
        { usage: { reserve: async () => true, release: async () => undefined }, breaker: new CircuitBreaker('google_translate', { failureThreshold: 10, resetMs: 1000 }), fetchImpl }
      );

    const cause = Object.assign(new TypeError('fetch failed'), { cause: new Error(`connect ECONNREFUSED 142.250.1.1:443 for https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_KEY}`) });
    const network: any = await mk(async () => {
      throw cause;
    })
      .translate(['hello'])
      .catch((e) => e);
    expect(network).toBeInstanceOf(UpstreamUnavailable);
    expect(leaks(`${network.message}\n${network.stack}`)).toEqual([]);

    const echoing: any = await mk(async () => new Response(JSON.stringify({ error: { code: 400, message: `API key not valid: ${GOOGLE_KEY}`, status: 'INVALID_ARGUMENT' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .translate(['hello'])
      .catch((e) => e);
    expect(echoing).toBeInstanceOf(UpstreamConfigError);
    expect(leaks(`${echoing.message}\n${echoing.stack}`)).toEqual([]);
  });

  it('the Google client sends the key in a header and never in the URL', async () => {
    let seen: { url: string; headers: Headers } | undefined;
    const client = new GoogleTranslateClient(
      { apiKey: GOOGLE_KEY, baseUrl: 'https://translation.googleapis.com/language/translate/v2', monthlyCharLimit: 1_000_000, timeoutMs: 1000 },
      {
        usage: { reserve: async () => true, release: async () => undefined },
        breaker: new CircuitBreaker('google_translate', { failureThreshold: 10, resetMs: 1000 }),
        fetchImpl: async (url, init) => {
          seen = { url, headers: new Headers(init?.headers as any) };
          return new Response(JSON.stringify({ data: { translations: [{ translatedText: 'xin chào' }] } }), { status: 200 });
        },
      }
    );
    await client.translate(['hello']);
    expect(seen!.url).not.toContain(GOOGLE_KEY);
    expect(seen!.url).not.toMatch(/key=/i);
    expect(seen!.headers.get('x-goog-api-key')).toBe(GOOGLE_KEY);
  });

  it('the log helpers of the queue layer', () => {
    const grabbed = captureConsole();
    try {
      logEvent('error', 'enrich', { error: `HTTP 401: invalid x-api-key: ${ANTHROPIC_KEY}`, url: `https://x?key=${GOOGLE_KEY}` });
      expect(errMessage(new Error(`boom ${GOOGLE_KEY}`))).not.toContain(GOOGLE_KEY);
      expect(leaks(grabbed.out.join('\n'))).toEqual([]);
      expect(grabbed.out.join('\n')).toContain('"evt":"enrich"');
    } finally {
      grabbed.restore();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('over HTTP: failing upstreams, and everything the process prints or returns', () => {
  let a: LookupApp;
  let grabbed: ReturnType<typeof captureConsole>;
  const responses: string[] = [];
  const w = (tag: string) => fixtureWord(`secret${tag}`);

  const remember = (res: { status: number; headers: Record<string, unknown>; body: unknown; text: string }) => responses.push(`${res.status}\n${JSON.stringify(res.headers)}\n${res.text}`);

  beforeAll(async () => {
    grabbed = captureConsole();
    a = await bootLookupApp({
      env: { GOOGLE_TRANSLATE_API_KEY: GOOGLE_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY, UPSTREAM_BREAKER_FAILURE_THRESHOLD: '100' },
    });
  });
  afterAll(async () => {
    await a.close();
    grabbed.restore();
  });

  it('Google: the connection is cut (a network error), then a 400 that repeats the key, then a 5xx — and the lookups still answer', async () => {
    a.mock.setControl({ google: { mode: 'drop' } });
    remember(await a.lookup(w('a')));

    a.mock.setControl({ google: { mode: 'status', status: 400, echoKey: true } });
    const cfg = await a.lookup(w('b'));
    remember(cfg);
    expect(cfg.status).toBe(200); // Free Dictionary still answered: a partial answer, not an error page

    a.mock.setControl({ google: { mode: 'status', status: 503, echoKey: true } });
    remember(await a.lookup(w('c')));

    a.mock.setControl({ google: null, fd: { mode: 'status', status: 503 } });
    remember(await a.lookup(w('d')));
    remember(await a.lookup('not valid'));
  });

  it('the mock confirms the key only ever travelled in the X-Goog-Api-Key header', () => {
    const g = a.mock.stats().google;
    expect(g.requests).toBeGreaterThan(0);
    expect(g.keyInUrl).toBe(0);
    expect(g.keyHeaderSeen).toBe(g.requests);
  });

  it('a configuration error (the 400) is reported at the ERROR level, without the key', () => {
    const lines = grabbed.out.filter((l) => l.includes('upstream_config_error'));
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.parse(lines[0])).toMatchObject({ evt: 'upstream_config_error', provider: 'google_translate', http_status: 400 });
  });

  it('no console line of any level contains a key', () => {
    expect(grabbed.out.length).toBeGreaterThan(5);
    expect(leaks(grabbed.out.join('\n'))).toEqual([]);
  });

  it('no response (status, headers, body) contains a key', () => {
    expect(responses.length).toBeGreaterThan(3);
    expect(leaks(responses.join('\n'))).toEqual([]);
  });

  it('no database row of the tables the lookup touches contains a key', async () => {
    await new Promise((r) => setTimeout(r, 400)); // the word_lookups inserts are fire-and-forget
    for (const table of ['word_lookups', 'word_enrichment_jobs', 'api_usage_counters', 'entry_edit_history', 'user_reading_progress']) {
      for (const key of SECRETS) {
        const { rows } = await a.pool.query(`SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE '%' || $1 || '%'`, [key]);
        expect({ table, hits: rows[0].n }).toEqual({ table, hits: 0 });
      }
    }
    const { rows } = await a.pool.query(`SELECT count(*)::int AS n FROM dictionary_entries WHERE admin_note LIKE '%' || $1 || '%' OR admin_note LIKE '%' || $2 || '%'`, SECRETS);
    expect(rows[0].n).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the enrichment job: an SDK error that echoes the key, through the real worker', () => {
  const RUNWORD = `qzq${RUN}secretjob`;
  let previousKey: string | undefined;
  let grabbed: ReturnType<typeof captureConsole>;

  beforeAll(() => {
    previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
    grabbed = captureConsole();
  });
  afterAll(async () => {
    grabbed.restore();
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    await pool.query(`DELETE FROM word_enrichment_jobs WHERE word = $1`, [RUNWORD]);
    await pool.end();
  });

  async function runOnce(error: Error, retryCount = 0): Promise<{ row: any; thrown: unknown }> {
    const client = new AnthropicEnrichClient(
      { apiKey: ANTHROPIC_KEY, model: 'test-model', maxOutputTokens: 100, timeoutMs: 1000 },
      { breaker: new CircuitBreaker('anthropic', { failureThreshold: 50, resetMs: 1000 }), createMessage: async () => { throw error; } }
    );
    const haiku = createHaikuCaller(client);
    const run = createPipeline({
      ensureTopics: async () => new Map([['business_economy', 't']]),
      publishPolicy: () => 'review',
      findExisting: async () => null,
      collectSources: async (word) => makeBundle({ word, expectedLemma: word, wiktionaryRows: [wrow({ word, pos: 'noun' })] }),
      generateDraft: (bundle, { signal }) => generateDraft(bundle, { haiku, signal }),
      persist: async () => ({ status: 'created', entryId: null, rows: {} }) as any,
      linkForm: async () => ({ linked: true }),
    });
    await pool.query(`DELETE FROM word_enrichment_jobs WHERE word = $1`, [RUNWORD]);
    const id = (await Jobs.insertQueued(pool as any, { word: RUNWORD, requestedBy: null }))!;
    const worker = new EnrichmentWorker({ db: pool as any, runEnrichment: run, sleep: async () => undefined });
    let thrown: unknown;
    await worker.handle([{ id: 'pg', data: { word: RUNWORD, requestedBy: null, ebookId: null, jobRowId: id }, retryCount, retryLimit: 3 }]).catch((e) => (thrown = e));
    return { row: await Jobs.findById(pool as any, id), thrown };
  }

  it.each([
    ['401 whose message repeats the key (a configuration error)', () => Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${ANTHROPIC_KEY}` } }, undefined, new Headers())],
    ['429 spend limit whose message repeats the key (budget)', () => Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: `limit for ${ANTHROPIC_KEY}`, details: { error_code: 'enforced_spend_limit_reached' } } }, undefined, new Headers())],
    ['529 whose message repeats the key (retried, then failed)', () => Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: `Overloaded ${ANTHROPIC_KEY}` } }, undefined, new Headers())],
  ])('%s: the log lines, the thrown error and the job row are clean', async (_label, make) => {
    const before = grabbed.out.length;
    const { row, thrown } = await runOnce(make() as Error, _label.startsWith('529') ? 3 : 0);
    const printed = grabbed.out.slice(before).join('\n');
    expect(printed).toContain('"evt":"enrich'); // something was logged
    expect(leaks(printed)).toEqual([]);
    expect(leaks(String((thrown as Error)?.message ?? '') + String((thrown as Error)?.stack ?? ''))).toEqual([]);
    expect(leaks(JSON.stringify(row))).toEqual([]);
    expect(['failed', 'skipped', 'queued']).toContain(row.status);
  });
});
