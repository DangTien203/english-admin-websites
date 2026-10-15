/**
 * Redrive on a REAL PostgreSQL + pg-boss: a job runs out of retries, lands in the dead letter queue (and our DLQ worker
 * completes it, which is why boss.redrive() has nothing to move), then planRedrive / applyRedrive send the word again.
 * Own schema pgboss_test_rd_<run>; fixture words qzq<run>…; the daily-cap counter is the test's own provider.
 */
import type { PgBoss } from 'pg-boss';
import pool from '../../config/db';
import { createStartedBoss, type QueueSettings } from '../../services/queue/boss';
import { ENRICH_DLQ } from '../../services/queue/constants';
import { EnrichmentWorker, registerEnrichmentWorkers } from '../../services/queue/enrichmentWorker';
import { PgBossEnrichmentEnqueuer } from '../../services/queue/pgBossEnqueuer';
import { applyRedrive, planRedrive } from '../../services/queue/redrive';
import { UpstreamUnavailable } from '../../services/upstream/errors';
import type { EnrichmentOutcome } from '../../services/enrichment/pipeline';

jest.setTimeout(90_000);

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const word = (tag: string) => `qzq${RUN}${tag}`;
const SETTINGS: QueueSettings = { schema: `pgboss_test_rd_${RUN}`, poolMax: 4, retryLimit: 0, retryDelaySeconds: 1, retryDelayMaxSeconds: 1, expireSeconds: 60 };
const PROVIDER = `enrichment_test_rd_${RUN}`;

pool.on('error', () => undefined);

async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, what: string, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const rows = async (w: string) => (await pool.query(`SELECT id, status, reason FROM word_enrichment_jobs WHERE word = $1 ORDER BY created_at`, [w])).rows;
const dlqCount = async (w: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${SETTINGS.schema}.job WHERE name = $1 AND data->>'word' = $2`, [ENRICH_DLQ, w])).rows[0].n as number;

let boss: PgBoss;
let enqueuer: PgBossEnrichmentEnqueuer;
let failing = true;

beforeAll(async () => {
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  boss = await createStartedBoss(SETTINGS, 'worker');
  enqueuer = new PgBossEnrichmentEnqueuer({ pool: pool as any, getBoss: async () => boss, maxJobsPerDay: 1000, usageProvider: PROVIDER });
  const worker = new EnrichmentWorker({
    db: pool,
    runEnrichment: async (): Promise<EnrichmentOutcome> => {
      if (failing) throw new UpstreamUnavailable('anthropic', 'http_5xx', { status: 503 });
      return { status: 'succeeded', model: 'fake', inputTokens: 1, outputTokens: 1 };
    },
  });
  await registerEnrichmentWorkers(boss, worker, { concurrency: 1, pollingIntervalSeconds: 0.5, dlqPollingIntervalSeconds: 0.5 });
});

afterAll(async () => {
  await boss?.stop({ graceful: false, close: true });
  await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM word_enrichment_jobs WHERE word LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM api_usage_counters WHERE provider = $1`, [PROVIDER]);
  await pool.query(`DROP SCHEMA IF EXISTS ${SETTINGS.schema} CASCADE`);
  await pool.end();
});

describe('redrive of a word whose job ended in the dead letter queue', () => {
  const w = word('dead');

  it('setup: the job runs out of retries → ledger failed / upstream_error and a job in the dead letter queue', async () => {
    expect(await enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null })).toEqual({ status: 'queued' });
    await waitFor(async () => (await rows(w))[0]?.status === 'failed', 'ledger row failed');
    await waitFor(async () => (await dlqCount(w)) === 1, 'the job in the dead letter queue');
    expect((await rows(w))[0]).toMatchObject({ status: 'failed', reason: 'upstream_error' });
  });

  it('the plan (= the dry run) selects it and changes nothing', async () => {
    const plan = await planRedrive({ db: pool, schema: SETTINGS.schema }, { words: [w] });
    expect(plan.scanned).toBe(1);
    expect(plan.items).toEqual([expect.objectContaining({ word: w, verdict: 'redrive', ledgerStatus: 'failed', ledgerReason: 'upstream_error' })]);

    await new Promise((r) => setTimeout(r, 1500));
    expect(await rows(w)).toHaveLength(1); // no new ledger row
    expect(await dlqCount(w)).toBe(1);
  });

  it('a selection that does not name the word does not touch it', async () => {
    const plan = await planRedrive({ db: pool, schema: SETTINGS.schema }, { words: [word('other')] });
    expect(plan.items).toEqual([]);
  });

  it('--confirm: the word goes through the enqueuer again, a fresh row runs and succeeds, the failed row stays as history', async () => {
    failing = false;
    const plan = await planRedrive({ db: pool, schema: SETTINGS.schema }, { words: [w] });
    const out = await applyRedrive({ enqueuer }, plan);
    expect(out).toMatchObject({ attempted: 1, byStatus: { queued: 1 } });

    await waitFor(async () => (await rows(w)).some((r) => r.status === 'succeeded'), 'the fresh row succeeded');
    const all = await rows(w);
    expect(all.map((r) => r.status)).toEqual(['failed', 'succeeded']);
    expect(all[0].reason).toBe('upstream_error');
  });

  it('once an entry exists for the word, the plan leaves it alone', async () => {
    await pool.query(`INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, published, source) VALUES ($1, $1, ARRAY['noun']::varchar[], 'thử', FALSE, 'wiktionary')`, [w]);
    const plan = await planRedrive({ db: pool, schema: SETTINGS.schema }, { words: [w] });
    expect(plan.items[0]).toMatchObject({ verdict: 'skip', skip: 'entry_exists' });
    expect(await applyRedrive({ enqueuer }, plan)).toMatchObject({ attempted: 0 });
  });
});
