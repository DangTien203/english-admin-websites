/**
 * Anthropic fails in every way the spec names (docs/lookup-spec.md §11.3, §11.4), through the REAL queue: real PostgreSQL,
 * real pg-boss in a private schema, the real worker, the real Anthropic client + circuit breaker + draft code. Only the SDK
 * underneath is a fake that throws genuine Anthropic.APIError objects. Run with: npm run test:chaos
 */
import type { PgBoss } from 'pg-boss';
import pool from '../../config/db';
import { EnrichmentWorker, registerEnrichmentWorkers } from '../../services/queue/enrichmentWorker';
import { ENRICH_DLQ, ENRICH_QUEUE } from '../../services/queue/constants';
import { PgBossEnrichmentEnqueuer } from '../../services/queue/pgBossEnqueuer';
import {
  cleanFixtures, dropSchema, fakeSdk, overloaded529, pipelineOverFakeSdk, queueSettings, rateLimit429, RUN, rowsOf, silence, spendLimit429,
  startBoss, unauthorized401, usageLimit400, waitFor, word, type SdkStep,
} from './chaosKit';

jest.setTimeout(180_000);
pool.on('error', () => undefined);

/** A queue, a worker and a fake SDK of their own, so one scenario's open breaker cannot leak into the next. */
async function harness(tag: string, retryLimit = 2) {
  const settings = queueSettings(tag, { retryLimit });
  const boss: PgBoss = await startBoss(settings);
  const scripts = new Map<string, SdkStep[]>();
  const sdk = fakeSdk((w, n) => scripts.get(w)?.[n - 1]);
  const { run, breaker } = pipelineOverFakeSdk(sdk);
  const worker = new EnrichmentWorker({ db: pool, runEnrichment: run });
  await registerEnrichmentWorkers(boss, worker, { concurrency: 1, pollingIntervalSeconds: 0.5, dlqPollingIntervalSeconds: 0.5 });
  const provider = `enrichment_chaos_${tag}_${RUN}`;
  const enqueuer = new PgBossEnrichmentEnqueuer({ pool: pool as any, getBoss: async () => boss, maxJobsPerDay: 1000, usageProvider: provider });
  const pgJob = async (w: string) => (await boss.findJobs(ENRICH_QUEUE, { key: w }))[0];
  const dlq = async (w: string) => (await boss.findJobs(ENRICH_DLQ, { data: { word: w } })).length;
  return {
    boss, sdk, breaker, enqueuer, scripts, pgJob, dlq,
    script: (w: string, ...steps: SdkStep[]) => scripts.set(w, steps),
    async stop() {
      await boss.stop({ graceful: false, close: true });
      await dropSchema(settings.schema);
    },
    waitTerminal: (w: string) => waitFor(async () => (await rowsOf(w)).find((r) => ['succeeded', 'failed', 'skipped', 'rejected'].includes(r.status)), `a terminal row of ${w}`),
  };
}

beforeAll(() => silence());
afterAll(async () => {
  await cleanFixtures();
  await pool.end();
});

describe('429 with Retry-After: wait, then retry through pg-boss (spec §11.4)', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => void (h = await harness('ra')));
  afterAll(() => h.stop());

  it('the second attempt comes AFTER the time Anthropic asked for, and the job ends succeeded', async () => {
    const w = word('retryafter');
    h.script(w, rateLimit429(2)); // first call: 429, retry-after 2 s; then the default valid draft
    expect(await h.enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null })).toEqual({ status: 'queued' });

    const row = await h.waitTerminal(w);
    expect(row).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(h.sdk.calls.filter((c) => c.word === w)).toHaveLength(2);
    const [first, second] = h.sdk.calls.filter((c) => c.word === w);
    expect(second.at - first.at).toBeGreaterThanOrEqual(2000); // waited the Retry-After, then pg-boss's own backoff on top
    expect((await h.pgJob(w)).state).toBe('completed');
    expect(await h.dlq(w)).toBe(0);
  });

  it('a 429 without Retry-After retries on pg-boss backoff alone', async () => {
    const w = word('noretryafter');
    h.script(w, rateLimit429(undefined));
    await h.enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null });
    expect(await h.waitTerminal(w)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('overloaded (529) twice, then fine → the third attempt succeeds', async () => {
    const w = word('overloaded');
    h.script(w, overloaded529(), overloaded529());
    await h.enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null });
    expect(await h.waitTerminal(w)).toMatchObject({ status: 'succeeded', attempts: 3 });
    expect(h.sdk.calls.filter((c) => c.word === w)).toHaveLength(3);
  });

  it('retries run out → the row is failed / upstream_error and the job is in the dead letter queue', async () => {
    const w = word('alwaysdown');
    h.script(w, overloaded529(), overloaded529(), overloaded529(), overloaded529());
    await h.enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null });
    expect(await h.waitTerminal(w)).toMatchObject({ status: 'failed', reason: 'upstream_error', attempts: 3 });
    await waitFor(async () => (await h.dlq(w)) === 1, 'the dead letter');
  });
});

describe('the provider\'s spend limit: skipped / budget, never retried, circuit open at once', () => {
  it.each([
    ['429 enforced_spend_limit_reached', spendLimit429],
    ['HTTP 400 "You have reached your specified API usage limits"', usageLimit400],
  ])('%s', async (_label, makeError) => {
    const tag = _label.startsWith('429') ? 'sp429' : 'sp400';
    const h = await harness(tag);
    try {
      const error = jest.spyOn(console, 'error');
      const w = word(tag === 'sp429' ? 'spendlimit' : 'usagelimit'); // a word of its own: an older terminal row must not be mistaken for this run
      h.script(w, makeError());
      await h.enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null });

      const row = await h.waitTerminal(w);
      expect(row).toMatchObject({ status: 'skipped', reason: 'budget', attempts: 1 });
      expect(h.sdk.calls.filter((c) => c.word === w)).toHaveLength(1); // NOT retried
      expect((await h.pgJob(w)).state).toBe('completed'); // pg-boss is told the job is done, so it does not retry
      expect(await h.dlq(w)).toBe(0);
      expect(h.breaker.currentState()).toBe('open'); // later jobs do not knock on a closed door
      const levels = error.mock.calls.map((c) => String(c[0]));
      expect(levels.some((l) => l.includes('"evt":"enrich"') && l.includes('"reason":"budget"'))).toBe(true); // logged at error level
    } finally {
      await h.stop();
    }
  });

  it('the next job finds the circuit open: Anthropic is not called, and the job is retried later instead of burning the wall', async () => {
    const h = await harness('spnext', 1);
    try {
      const first = word('spendfirst');
      h.script(first, spendLimit429());
      await h.enqueuer.enqueue({ word: first, requestedBy: null, ebookId: null });
      await h.waitTerminal(first);
      const callsAfterFirst = h.sdk.calls.length;

      const second = word('spendsecond');
      await h.enqueuer.enqueue({ word: second, requestedBy: null, ebookId: null });
      const row = await h.waitTerminal(second);
      expect(h.sdk.calls.length).toBe(callsAfterFirst); // not a single call
      expect(row).toMatchObject({ status: 'failed', reason: 'upstream_error' }); // retries used up while the circuit stayed open
      await waitFor(async () => (await h.dlq(second)) === 1, 'the dead letter');
    } finally {
      await h.stop();
    }
  });
});

describe('a configuration error: failed / config_error, not retried', () => {
  it('401 (wrong key)', async () => {
    const h = await harness('cfg');
    try {
      const w = word('badkey');
      h.script(w, unauthorized401());
      await h.enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null });
      expect(await h.waitTerminal(w)).toMatchObject({ status: 'failed', reason: 'config_error', attempts: 1 });
      expect(h.sdk.calls.filter((c) => c.word === w)).toHaveLength(1);
      expect((await h.pgJob(w)).state).toBe('completed');
      expect(h.breaker.currentState()).toBe('open');
    } finally {
      await h.stop();
    }
  });
});
