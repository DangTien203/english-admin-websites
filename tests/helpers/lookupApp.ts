/**
 * Boots the REAL Express app (routes, middleware, real PostgreSQL) against the mock upstream server, for the HTTP tests
 * in tests/e2e and tests/chaos. Nothing here talks to a real external service:
 *
 *   - GOOGLE_TRANSLATE_BASE_URL / FREE_DICTIONARY_BASE_URL / DATAMUSE_BASE_URL point at scripts/mock-upstream (127.0.0.1)
 *   - the API keys are dummies, so a missed override can never spend real money
 *   - ENRICHMENT_ENABLED defaults to false (no pg-boss); a test that needs the hook installs a recording enqueuer
 *
 * lookupConfig is validated and frozen when config/lookup.ts is first imported, so the environment has to be right BEFORE
 * the app is loaded. Each boot loads a private copy of the app (jest.isolateModules) with its own pool and config, and puts
 * the environment back afterwards.
 *
 * Shared dev database: every fixture row is named "qzq<run>…", users are "e2e-<run>-…@example.com", and close() removes
 * them. The real Google character counter (api_usage_counters, google_translate) is restored to its value from before the
 * boot, because the real ApiUsage books the characters the mock "translated".
 */
import 'dotenv/config';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import { startMockUpstream, type MockUpstream } from '../../scripts/mock-upstream/server';
import type { EnrichmentEnqueuer } from '../../services/lookup/enqueuer';
import type { UpstreamClients } from '../../services/upstream';

export const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
/** A unique, letters-only word (the word cleaner rejects digits). */
export const fixtureWord = (tag: string): string => `qzq${RUN}${tag}`.toLowerCase();

export interface BootOptions {
  /** Environment overrides applied before the app is loaded (they win over the defaults below). */
  env?: Record<string, string>;
  /** An already running mock (shared between boots). A private one is started, and stopped by close(), otherwise. */
  mock?: MockUpstream;
}

export interface LookupApp {
  app: Express;
  pool: Pool;
  mock: MockUpstream;
  ebookId: string;
  user: { id: string; email: string; token: string };
  /** More users (rate limits are per user). */
  createUser(tag: string): Promise<{ id: string; email: string; token: string }>;
  /** Replaces the enrichment hook (only used by the service when ENRICHMENT_ENABLED=true). */
  setEnqueuer(enqueuer: EnrichmentEnqueuer): void;
  /** The upstream clients (and their circuit breakers) THIS app uses. */
  upstream(): UpstreamClients;
  /** POST /api/v1/ebooks/:id/lookup */
  lookup(word: string, opts?: { token?: string; paragraphId?: string }): Promise<import('supertest').Response>;
  /** Waits until `fn` returns something truthy. */
  waitFor<T>(fn: () => Promise<T | false | null | undefined>, what: string, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

const DEFAULT_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  GOOGLE_TRANSLATE_API_KEY: 'test-google-key-0000',
  ANTHROPIC_API_KEY: 'test-anthropic-key-0000',
  DATAMUSE_ENABLED: 'true',
  DATAMUSE_API_KEY: '',
  TRANSLATION_FALLBACK_ENABLED: 'true',
  ENRICHMENT_ENABLED: 'false',
  ENRICHMENT_WORKER_ENABLED: 'false',
  LOOKUP_FAST_TRANSLATOR: 'google',
  LOOKUP_TRANSLATE_DEFINITIONS: 'true',
  LOOKUP_UPSTREAM_TIMEOUT_MS: '2500',
  // Generous on purpose: the dev database is far away and the deadline also covers the local queries, so a tight value would
  // make the tests about answers flaky. The deadline tests ask for 3000 themselves.
  LOOKUP_TOTAL_DEADLINE_MS: '15000',
  LOOKUP_MAX_MEANINGS: '4',
  // The per-user limit is exercised on purpose in its own test; elsewhere it must not get in the way.
  LOOKUP_MISS_RATE_LIMIT_PER_MIN: '1000',
  GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT: '450000',
  FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN: '100000',
  UPSTREAM_BREAKER_FAILURE_THRESHOLD: '5',
  UPSTREAM_BREAKER_RESET_MS: '30000',
  // ref_* tables live in the main database
  REFDATA_DATABASE_URL: '',
};

interface UsageRow {
  provider: string;
  period: string;
  unit: string;
  used: string;
}

async function snapshotGoogleUsage(pool: Pool): Promise<UsageRow[]> {
  const { rows } = await pool.query(`SELECT provider, period, unit, used FROM api_usage_counters WHERE provider = 'google_translate'`);
  return rows;
}

async function restoreGoogleUsage(pool: Pool, before: UsageRow[]): Promise<void> {
  const { rows } = await pool.query(`SELECT provider, period, unit, used FROM api_usage_counters WHERE provider = 'google_translate'`);
  for (const row of rows) {
    const original = before.find((b) => b.period === row.period && b.unit === row.unit);
    if (!original) await pool.query(`DELETE FROM api_usage_counters WHERE provider = $1 AND period = $2 AND unit = $3`, [row.provider, row.period, row.unit]);
    else if (original.used !== row.used) await pool.query(`UPDATE api_usage_counters SET used = $4 WHERE provider = $1 AND period = $2 AND unit = $3`, [row.provider, row.period, row.unit, original.used]);
  }
}

/** Opens n connections (in small waves: a burst of new TLS connections can make a serverless Postgres time out), then returns them. */
export async function warmPool(pool: Pool, n: number, wave = 3): Promise<void> {
  for (let done = 0; done < n; done += wave) {
    const clients = await Promise.all(Array.from({ length: Math.min(wave, n - done) }, () => pool.connect()));
    clients.forEach((c) => c.release());
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Tests never reach a real service: while a boot is open, global fetch refuses every host except the loopback one the mock
 * listens on. (Only the host is reported: a URL could carry a query string.)
 */
function installNetworkGuard(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input?.url ?? String(input));
    const host = new URL(raw).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error(`network guard: a test tried to reach ${host}`);
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export async function bootLookupApp(opts: BootOptions = {}): Promise<LookupApp> {
  const supertest = (await import('supertest')).default;
  const removeGuard = installNetworkGuard();
  const ownMock = !opts.mock;
  const mock = opts.mock ?? (await startMockUpstream());

  const env: Record<string, string> = { ...DEFAULT_ENV, ...mock.env, ...(opts.env ?? {}) };
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }

  let app!: Express;
  let pool!: Pool;
  let lookupModule!: typeof import('../../services/lookup');
  let upstreamModule!: typeof import('../../services/upstream');
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pool = require('../../config/db');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      app = require('../../app').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      lookupModule = require('../../services/lookup');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      upstreamModule = require('../../services/upstream');
    });
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  // A server-side drop of an idle connection must not crash the test run.
  pool.on('error', () => undefined);
  await warmPool(pool, 6);

  const usageBefore = await snapshotGoogleUsage(pool);
  const emails: string[] = [];

  const createUser = async (tag: string) => {
    const email = `e2e-${RUN}-${tag}@example.com`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, level) VALUES ($1, 'not-a-real-hash', $2, 'beginner') RETURNING id`,
      [email, `E2E ${tag}`]
    );
    emails.push(email);
    const token = jwt.sign({ userId: rows[0].id, email }, process.env.JWT_SECRET as string, { expiresIn: '1h' });
    return { id: rows[0].id as string, email, token };
  };

  const user = await createUser('main');
  const {
    rows: [ebook],
  } = await pool.query(
    `INSERT INTO ebooks (title, author, level, required_plan, status, epub_file_url) VALUES ($1, 'E2E', 'beginner', 'free', 'published', '/e2e.epub') RETURNING id`,
    [`E2E ebook ${RUN}`]
  );

  const waitFor = async <T>(fn: () => Promise<T | false | null | undefined>, what: string, timeoutMs = 15_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  return {
    app,
    pool,
    mock,
    ebookId: ebook.id,
    user,
    createUser,
    setEnqueuer: (enqueuer) => lookupModule.setEnrichmentEnqueuer(enqueuer),
    upstream: () => upstreamModule.getUpstreamClients(),
    lookup: (word, o = {}) =>
      supertest(app)
        .post(`/api/v1/ebooks/${ebook.id}/lookup`)
        .set('Authorization', `Bearer ${o.token ?? user.token}`)
        .send({ word, ...(o.paragraphId ? { paragraph_id: o.paragraphId } : {}) }),
    waitFor,
    async close() {
      await new Promise((r) => setTimeout(r, 300)); // let the fire-and-forget inserts of the last lookup finish
      try {
        await pool.query(`DELETE FROM word_forms WHERE form_value LIKE $1`, [`qzq${RUN}%`]);
        await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1 OR lemma LIKE $1`, [`qzq${RUN}%`]);
        await pool.query(`DELETE FROM ref_wiktionary_en WHERE word LIKE $1`, [`qzq${RUN}%`]);
        await pool.query(`DELETE FROM ref_word_frequency WHERE word LIKE $1`, [`qzq${RUN}%`]);
        await pool.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [emails]);
        await pool.query(`DELETE FROM ebooks WHERE id = $1`, [ebook.id]);
        await restoreGoogleUsage(pool, usageBefore);
      } finally {
        await pool.end();
        if (ownMock) await mock.close();
        removeGuard();
      }
    },
  };
}
