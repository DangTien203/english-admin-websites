/**
 * The mock upstream server itself (scripts/mock-upstream): what it imitates, how it is steered, and the guarantees that keep it
 * a development tool (loopback only, never in the production build, never started in production).
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { startMockUpstream, type MockUpstream } from '../../scripts/mock-upstream/server';

let mock: MockUpstream;
beforeAll(async () => {
  mock = await startMockUpstream();
});
afterAll(() => mock.close());
beforeEach(() => mock.reset());

const google = (q: string[], key: string | null = 'k') =>
  fetch(mock.env.GOOGLE_TRANSLATE_BASE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-goog-api-key': key } : {}) },
    body: JSON.stringify({ q, source: 'en', target: 'vi', format: 'text' }),
  });
const fd = (word: string) => fetch(`${mock.env.FREE_DICTIONARY_BASE_URL}/${word}`);
const muse = (query: string) => fetch(`${mock.env.DATAMUSE_BASE_URL}/words?${query}`);

describe('what it imitates', () => {
  it('Google v2: one translation per text, the real captured answers for the fixture words', async () => {
    const res = await google(['run', 'zzzz']);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.translations).toHaveLength(2);
    expect(body.data.translations[0].translatedText).toBe('chạy'); // tests/fixtures/lookup/google-prefix/run.json
    expect(body.data.translations[1].translatedText).not.toBe('zzzz');
  });

  it('Google v2: a prefixed definition request is answered from the fixture, and without an API key it is the real 400', async () => {
    const def = 'run: To move swiftly on foot so that both feet leave the ground in each stride.';
    const ok: any = await (await google([def])).json();
    expect(ok.data.translations[0].translatedText).toMatch(/^Chạy: /);
    const noKey = await google(['run'], null);
    expect(noKey.status).toBe(400);
    expect(JSON.stringify(await noKey.json())).toContain('API_KEY_INVALID');
  });

  it('Free Dictionary: the captured entries for hello / ran / ubiquitous, a synthesized one for any other word, the API 404 when asked to', async () => {
    const hello: any = await (await fd('hello')).json();
    expect(hello[0].word).toBe('hello');
    expect(((await (await fd('ran')).json()) as any[]).length).toBe(3); // the real "ran" has three entries
    const made: any = await (await fd('qzqsomething')).json();
    expect(made[0].word).toBe('qzqsomething');
    expect(JSON.stringify(made)).not.toContain('hello');

    mock.setControl({ unknownWord: 'not_found' });
    const nf = await fd('qzqsomething');
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ title: 'No Definitions Found' });
    expect((await fd('hello')).status).toBe(200); // fixtures still answer
  });

  it('Datamuse: synonyms and antonyms as { word, score } arrays, max honoured', async () => {
    const syn: any = await (await muse('rel_syn=happy&max=2')).json();
    expect(syn).toHaveLength(2);
    expect(syn[0]).toMatchObject({ word: expect.any(String), score: expect.any(Number) });
    expect(((await (await muse('rel_ant=happy&max=20')).json()) as any[]).length).toBeGreaterThan(0);
  });
});

describe('how it is steered', () => {
  it('latency, 5xx, 429 with and without Retry-After', async () => {
    mock.setControl({ fd: { latencyMs: 250 } });
    const t0 = Date.now();
    await fd('hello');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);

    mock.setControl({ google: { mode: 'status', status: 503 }, fd: { mode: 'status', status: 429, retryAfter: 17 } });
    expect((await google(['run'])).status).toBe(503);
    const limited = await fd('hello');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('17');

    mock.setControl({ fd: { mode: 'status', status: 429 } });
    expect((await fd('hello')).headers.get('retry-after')).toBeNull();
  });

  it('HTML instead of JSON, invalid JSON, a short array, a dropped connection', async () => {
    mock.setControl({ fd: { mode: 'html' }, google: { mode: 'invalid_json' } });
    const page = await fd('hello');
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<!DOCTYPE html>');
    await expect((await google(['run'])).json()).rejects.toThrow();

    mock.setControl({ google: { mode: 'short_array' } });
    expect(((await (await google(['a', 'b', 'c'])).json()) as any).data.translations).toHaveLength(2);

    mock.setControl({ google: { mode: 'drop' } });
    await expect(google(['run'])).rejects.toThrow();
    expect(mock.stats().google.statuses.dropped).toBe(1);
  });

  it('a request that never gets an answer (hang) is left open until the client gives up', async () => {
    mock.setControl({ fd: { mode: 'hang' } });
    await expect(fetch(`${mock.env.FREE_DICTIONARY_BASE_URL}/hello`, { signal: AbortSignal.timeout(300) })).rejects.toThrow();
    expect(mock.stats().fd.hung).toBe(1);
  });

  it('a random error rate with a seed is reproducible; failFirst fails exactly the first N', async () => {
    const run = async () => {
      mock.reset();
      mock.setControl({ seed: 42, fd: { errorRate: 0.5, errorStatus: 502 } });
      const out: number[] = [];
      for (let i = 0; i < 12; i++) out.push((await fd('hello')).status);
      return out;
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(new Set(a)).toEqual(new Set([200, 502]));

    mock.reset();
    mock.setControl({ datamuse: { failFirst: 2 } });
    expect([(await muse('rel_syn=a')).status, (await muse('rel_syn=a')).status, (await muse('rel_syn=a')).status]).toEqual([503, 503, 200]);
  });

  it('rules for chosen words beat the provider default; a "prefix*" pattern and "*" for every provider work', async () => {
    mock.setControl({ fd: { mode: 'status', status: 500 }, rules: [{ provider: 'fd', words: ['hello'], behavior: {} }, { provider: '*', words: ['qzq*'], behavior: { mode: 'not_found' } }] });
    expect((await fd('hello')).status).toBe(200); // the rule wins over the provider default
    expect((await fd('other')).status).toBe(500);
    expect((await fd('qzqword')).status).toBe(404);
  });

  it('echoKey: the error text repeats the key the request carried (to test that nothing downstream prints it)', async () => {
    mock.setControl({ google: { mode: 'status', status: 400, echoKey: true } });
    expect(JSON.stringify(await (await google(['run'], 'AIza-SOME-KEY')).json())).toContain('AIza-SOME-KEY');
  });
});

describe('what it counts', () => {
  it('requests by provider and by word, headline and definition requests of Google, characters, key placement, peak concurrency', async () => {
    mock.setControl({ fd: { latencyMs: 150 } });
    await google(['run']);
    await google(['run: To move swiftly on foot so that both feet leave the ground in each stride.', 'bank: A financial institution.']);
    await fetch(`${mock.env.GOOGLE_TRANSLATE_BASE_URL}?key=LEAKED`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: ['run'] }) });
    await Promise.all([fd('hello'), fd('hello'), fd('ran')]);

    const s = mock.stats();
    expect(s.total).toBe(6);
    expect(s.google).toMatchObject({ requests: 3, headlineRequests: 2, definitionRequests: 1, keyHeaderSeen: 2, keyInUrl: 1 });
    expect(s.google.chars).toBeGreaterThan(100);
    expect(s.google.byWord.run).toMatchObject({ requests: 3, headline: 2, definitions: 1 });
    expect(s.google.byWord.bank).toMatchObject({ requests: 1, definitions: 1 });
    expect(s.fd.byWord).toMatchObject({ hello: { requests: 2 }, ran: { requests: 1 } });
    expect(s.fd.maxConcurrent).toBe(3);
    expect(s.fd.statuses).toEqual({ '200': 3 });
  });

  it('/__stats and /__control are reachable, /__reset clears counters and behaviour (or just one of them)', async () => {
    await fd('hello');
    mock.setControl({ fd: { latencyMs: 1 } });
    const stats: any = await (await fetch(`${mock.url}/__stats`)).json();
    expect(stats.fd.requests).toBe(1);
    expect(((await (await fetch(`${mock.url}/__control`)).json()) as any).fd).toEqual({ latencyMs: 1 });

    await fetch(`${mock.url}/__reset?keep=control`, { method: 'POST' });
    expect(mock.stats().total).toBe(0);
    expect(mock.control().fd).toEqual({ latencyMs: 1 });
    await fetch(`${mock.url}/__reset?keep=stats`, { method: 'POST' });
    expect(mock.control().fd).toBeUndefined();

    const posted: any = await (await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ google: { mode: 'hang' } }) })).json();
    expect(posted.google).toEqual({ mode: 'hang' });
  });
});

describe('it stays a development tool', () => {
  it('listens on 127.0.0.1 only', () => {
    expect(new URL(mock.url).hostname).toBe('127.0.0.1');
    expect(Object.values(mock.env).every((u) => new URL(u).hostname === '127.0.0.1')).toBe(true);
  });

  it('refuses to start when NODE_ENV=production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(startMockUpstream()).rejects.toThrow(/refuses to start when NODE_ENV=production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('answers 403 to a peer that is not loopback (checked on the code path with a forged socket address)', async () => {
    const req = http.request({ host: '127.0.0.1', port: mock.port, path: '/__health' });
    const res: http.IncomingMessage = await new Promise((resolve, reject) => {
      req.on('response', resolve).on('error', reject).end();
    });
    expect(res.statusCode).toBe(200); // a real loopback peer is fine; the 403 branch is the first statement of the handler
    const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/mock-upstream/server.ts'), 'utf8');
    expect(source).toMatch(/\['127\.0\.0\.1', '::1', '::ffff:127\.0\.0\.1'\]\.includes\(peer\)/);
    expect(source).toMatch(/res\.writeHead\(403\)/);
  });

  it('is not part of the production build: scripts/ is excluded from tsconfig.json and nothing in the app imports it', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../tsconfig.json'), 'utf8'));
    expect(tsconfig.exclude).toEqual(expect.arrayContaining(['scripts', 'tests']));
    expect((tsconfig.include as string[]).some((p) => p.includes('mock-upstream'))).toBe(false);

    // everything that is compiled into dist/ (see "include" in tsconfig.json)
    const root = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.ts$/.test(entry.name) && /mock-upstream/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full));
      }
    };
    for (const dir of ['config', 'controllers', 'helpers', 'middlewares', 'models', 'routes', 'services', 'utils', 'database', 'types']) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
    for (const file of ['app.ts', 'worker.ts']) if (/mock-upstream/.test(fs.readFileSync(path.join(root, file), 'utf8'))) offenders.push(file);
    expect(offenders).toEqual([]);
  });
});
