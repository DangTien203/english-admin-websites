/**
 * Integration tests on a REAL PostgreSQL (the same database the other suites use; see CLAUDE.md "Tests"):
 * real pg-boss in its own schemas (pgboss_test_<run>, pgboss_test_stop_<run>; dropped at the end), real
 * word_enrichment_jobs rows, a fake enrichment pipeline. Nothing here talks to an external service.
 *
 * Everything is namespaced by a random per-run code, so two runs at the same time (or a run next to a
 * developer's own data) never touch each other: fixture words are "qzq<run>…", the daily-cap counters use
 * providers "enrichment_test_<run>…" (the real `enrichment` counter is never touched) and the schemas carry
 * the run code. A run that crashes leaves its schemas / rows behind: drop `pgboss_test_*` schemas and
 * delete `qzq%` rows by hand.
 */
import type { PgBoss } from 'pg-boss';
import pool from '../../config/db';
import * as Jobs from '../../models/EnrichmentJob';
import { createStartedBoss, ensureQueues, type QueueSettings } from '../../services/queue/boss';
import { ENRICH_DLQ, ENRICH_QUEUE } from '../../services/queue/constants';
import { EnrichmentWorker, registerEnrichmentWorkers } from '../../services/queue/enrichmentWorker';
import { PgBossEnrichmentEnqueuer } from '../../services/queue/pgBossEnqueuer';
import { reconcileStaleJobs } from '../../services/queue/reconcile';
import { ApiUsage, currentPeriod } from '../../services/upstream/apiUsage';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';
import type { EnrichmentJob, EnrichmentOutcome } from '../../services/enrichment/pipeline';

jest.setTimeout(90_000);

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
/** A unique, letters-only word (digits are not valid words for the fast-path cleaner). */
const fx = (tag: string) => `qzq${RUN}${tag}`;

const MAIN: QueueSettings = { schema: `pgboss_test_${RUN}`, poolMax: 4, retryLimit: 2, retryDelaySeconds: 1, retryDelayMaxSeconds: 2, expireSeconds: 60 };
const STOP: QueueSettings = { ...MAIN, schema: `pgboss_test_stop_${RUN}` };
const PROVIDER = `enrichment_test_${RUN}`;

const quiet = () => {
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
};

async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, what: string, timeoutMs = 30_000, everyMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const rowOf = async (word: string) => (await pool.query(`SELECT * FROM word_enrichment_jobs WHERE word = $1 ORDER BY created_at DESC LIMIT 1`, [word])).rows[0] as Jobs.EnrichmentJobRow | undefined;
const rowsOf = async (word: string) => (await pool.query(`SELECT * FROM word_enrichment_jobs WHERE word = $1`, [word])).rows as Jobs.EnrichmentJobRow[];
const used = (provider: string) => new ApiUsage(pool).getUsed(provider, 'jobs', currentPeriod('day'));

async function cleanup() {
  await pool.query(`DELETE FROM word_enrichment_jobs WHERE word LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM api_usage_counters WHERE provider LIKE $1`, [`${PROVIDER}%`]);
}
async function dropSchemas() {
  await pool.query(`DROP SCHEMA IF EXISTS ${MAIN.schema} CASCADE`);
  await pool.query(`DROP SCHEMA IF EXISTS ${STOP.schema} CASCADE`);
}

function enqueuerFor(boss: PgBoss, usageProvider = PROVIDER, maxJobsPerDay = 1000) {
  return new PgBossEnrichmentEnqueuer({ pool: pool as any, getBoss: async () => boss, maxJobsPerDay, usageProvider });
}

type Behavior = (job: EnrichmentJob) => Promise<EnrichmentOutcome>;

// A server-side drop of an idle connection (Neon) must not crash the test run, see services/queue/runtime.ts.
pool.on('error', () => undefined);

/** Opens `n` connections at once, in small waves: a burst of new TLS connections can make Neon time out authentication. */
async function warmPool(n: number, wave = 4) {
  for (let done = 0; done < n; done += wave) {
    const clients = await Promise.all(Array.from({ length: Math.min(wave, n - done) }, () => pool.connect()));
    clients.forEach((c) => c.release());
    await new Promise((r) => setTimeout(r, 150));
  }
}

afterAll(async () => {
  await cleanup();
  await dropSchemas();
});

// ═════════════════════════════════════════════════════════════════════════════
describe('queue on real PostgreSQL + pg-boss', () => {
  let boss: PgBoss;
  let enqueuer: PgBossEnrichmentEnqueuer;
  const behaviors = new Map<string, Behavior>();
  const calls = new Map<string, number>();

  beforeAll(async () => {
    quiet();
    boss = await createStartedBoss(MAIN, 'worker');
    enqueuer = enqueuerFor(boss);

    const worker = new EnrichmentWorker({
      db: pool,
      runEnrichment: async (job) => {
        calls.set(job.word, (calls.get(job.word) ?? 0) + 1);
        const custom = behaviors.get(job.word);
        return custom ? custom(job) : { status: 'succeeded', model: 'fake-model', inputTokens: 10, outputTokens: 5 };
      },
    });
    await registerEnrichmentWorkers(boss, worker, { concurrency: 2, pollingIntervalSeconds: 0.5, dlqPollingIntervalSeconds: 0.5 });
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false, close: true });
  });

  it('creates the schema, both queues, with the exclusive policy and the dead letter queue', async () => {
    const q = (await boss.getQueue(ENRICH_QUEUE)) as any;
    expect(q).toMatchObject({ policy: 'exclusive', deadLetter: ENRICH_DLQ, retryLimit: 2, retryDelay: 1, retryBackoff: true, expireInSeconds: 60 });
    expect(await boss.getQueue(ENRICH_DLQ)).not.toBeNull();
    const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [MAIN.schema]);
    expect(rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(['job', 'queue', 'version']));
  });

  it('send → worker → row ends succeeded with the outcome fields, attempts 1; the pg-boss job completes', async () => {
    const word = fx('ok');
    await expect(enqueuer.enqueue({ word, requestedBy: null, ebookId: null })).resolves.toEqual({ status: 'queued' });

    const row = await waitFor(async () => {
      const r = await rowOf(word);
      return r?.status === 'succeeded' ? r : false;
    }, 'row succeeded');
    expect(row).toMatchObject({ attempts: 1, model: 'fake-model', input_tokens: 10, output_tokens: 5, reason: null });
    expect(row.finished_at).not.toBeNull();

    // The ledger row is written by the handler; pg-boss marks the job completed a moment AFTER the handler returns (on a database
    // that is far away that is a visible gap), so wait for it instead of reading the state once.
    const job = await waitFor(async () => {
      const [j] = await boss.findJobs(ENRICH_QUEUE, { key: word });
      return j?.state === 'completed' ? j : false;
    }, 'the pg-boss job to complete');
    expect(job.state).toBe('completed');
    expect(job.data).toEqual({ word, requestedBy: null, ebookId: null, jobRowId: row.id }); // exactly the four fields
  });

  it('the result of the real pipeline code (with fake sources) reaches the row: rejected / unknown_word', async () => {
    const word = fx('stub');
    const { createPipeline } = await import('../../services/enrichment/pipeline');
    const pipeline = createPipeline({
      ensureTopics: async () => new Map(),
      publishPolicy: () => 'review',
      findExisting: async () => null,
      collectSources: async (w) =>
        ({ word: w, expectedLemma: null, formLemmas: [], variantTargets: [], wiktionaryRows: [], lemmaRows: [], freeDictionary: { status: 'not_found' }, frequency: null, datamuse: null,
          flags: { onlyFormRows: false, onlyVariantRows: false, onlyProperNounRows: false, noSourceRecognizesWord: true }, strayRows: 0, sourceErrors: {}, timingsMs: {} }) as any,
      generateDraft: async () => { throw new Error('Haiku must not be called for an unknown word'); },
      persist: async () => { throw new Error('nothing to write'); },
      linkForm: async () => { throw new Error('nothing to link'); },
    });
    behaviors.set(word, (job) => pipeline(job));
    await enqueuer.enqueue({ word, requestedBy: null, ebookId: null });
    const row = await waitFor(async () => ((await rowOf(word))?.status === 'rejected' ? await rowOf(word) : false), 'row rejected');
    expect(row!.reason).toBe('unknown_word');
  });

  it('10 parallel enqueues of the same word produce ONE row, ONE pg-boss job and ONE daily slot', async () => {
    const word = fx('ten');
    let release!: () => void;
    behaviors.set(word, async () => {
      await new Promise<void>((r) => (release = r)); // keep the job alive while the 10 calls race
      return { status: 'succeeded' };
    });
    const before = await used(PROVIDER);
    await warmPool(10);

    try {
      const results = await Promise.all(Array.from({ length: 10 }, () => enqueuer.enqueue({ word, requestedBy: null, ebookId: null })));

      expect(results.filter((r) => r.status === 'queued')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'already_queued')).toHaveLength(9);
      expect(await rowsOf(word)).toHaveLength(1);
      expect(await boss.findJobs(ENRICH_QUEUE, { key: word })).toHaveLength(1);
      expect((await used(PROVIDER)) - before).toBe(1);

      await waitFor(async () => (await rowOf(word))?.status === 'running', 'row running');
      // while it runs, another enqueue is still already_queued
      await expect(enqueuer.enqueue({ word, requestedBy: null, ebookId: null })).resolves.toEqual({ status: 'already_queued' });
    } finally {
      release?.();
    }
    await waitFor(async () => (await rowOf(word))?.status === 'succeeded', 'row succeeded');
    expect(calls.get(word)).toBe(1);
  });

  it('UpstreamUnavailable twice, then success: the row goes back to queued in between and ends succeeded with attempts = 3', async () => {
    const word = fx('flaky');
    behaviors.set(word, async () => {
      if ((calls.get(word) ?? 0) <= 2) throw new UpstreamUnavailable('anthropic', 'http_5xx', { status: 503 });
      return { status: 'succeeded', model: 'fake-model' };
    });

    await enqueuer.enqueue({ word, requestedBy: null, ebookId: null });

    const seen = new Set<string>();
    const row = await waitFor(async () => {
      const r = await rowOf(word);
      if (r) seen.add(`${r.status}:${r.attempts}:${r.reason ?? '-'}`);
      return r?.status === 'succeeded' ? r : false;
    }, 'row succeeded after retries', 60_000, 50);

    expect(row.attempts).toBe(3);
    expect(calls.get(word)).toBe(3);
    expect(seen).toContain('queued:1:upstream_error'); // back to queued after the 1st failure, attempts kept
    expect(seen).toContain('queued:2:upstream_error');
    const [job] = await boss.findJobs(ENRICH_QUEUE, { key: word });
    expect(job).toMatchObject({ state: 'completed', retryCount: 2 });
  });

  it('a pipeline that always fails: after the last attempt the row is failed / upstream_error and the job is in the dead letter queue', async () => {
    const word = fx('dead');
    behaviors.set(word, async () => {
      throw new UpstreamUnavailable('anthropic', 'timeout');
    });

    await enqueuer.enqueue({ word, requestedBy: null, ebookId: null });

    const row = await waitFor(async () => {
      const r = await rowOf(word);
      return r?.status === 'failed' ? r : false;
    }, 'row failed', 60_000, 50);
    expect(row).toMatchObject({ reason: 'upstream_error', attempts: 3 }); // retryLimit 2 → 3 runs
    expect(row.finished_at).not.toBeNull();

    // the row is failed BEFORE the handler throws, so give pg-boss a moment to record the failure of the job itself
    const original = await waitFor(async () => {
      const [j] = await boss.findJobs(ENRICH_QUEUE, { key: word });
      return j?.state === 'failed' ? j : false;
    }, 'pg-boss job failed');
    expect(original.retryCount).toBe(2);

    // pg-boss copied the job into the dead letter queue; its worker looks at it and the row stays failed
    const dead = await waitFor(async () => {
      const jobs = await boss.findJobs(ENRICH_DLQ, { data: { jobRowId: row.id } });
      return jobs[0]?.state === 'completed' ? jobs[0] : false;
    }, 'dead letter job handled');
    expect(dead.sourceName).toBe(ENRICH_QUEUE);
    expect((await rowOf(word))!.reason).toBe('upstream_error');

    // and the word can be enqueued again later (the failed row no longer blocks it)
    behaviors.delete(word);
    await expect(enqueuer.enqueue({ word, requestedBy: null, ebookId: null })).resolves.toEqual({ status: 'queued' });
    await waitFor(async () => (await rowOf(word))?.status === 'succeeded', 'second life of the word');
  });

  it('the dead letter worker closes a row that is still queued / running with reason dead_letter', async () => {
    const word = fx('dlq');
    const id = (await pool.query(`INSERT INTO word_enrichment_jobs (word, status) VALUES ($1, 'running') RETURNING id`, [word])).rows[0].id;
    await boss.send(ENRICH_DLQ, { word, requestedBy: null, ebookId: null, jobRowId: id });
    const row = await waitFor(async () => ((await rowOf(word))?.status === 'failed' ? await rowOf(word) : false), 'row failed by the dead letter worker');
    expect(row).toMatchObject({ reason: 'dead_letter' });
    expect(row!.finished_at).not.toBeNull();
  });

  it('UpstreamConfigError → failed / config_error, run once; BudgetExceeded → skipped / budget, run once', async () => {
    const cfg = fx('cfg');
    const bud = fx('bud');
    behaviors.set(cfg, async () => { throw new UpstreamConfigError('anthropic', 'invalid x-api-key', 401); });
    behaviors.set(bud, async () => { throw new BudgetExceeded('anthropic', 'spend_limit'); });
    await enqueuer.enqueue({ word: cfg, requestedBy: null, ebookId: null });
    await enqueuer.enqueue({ word: bud, requestedBy: null, ebookId: null });

    await waitFor(async () => (await rowOf(cfg))?.status === 'failed' && (await rowOf(bud))?.status === 'skipped', 'both rows closed');
    expect(await rowOf(cfg)).toMatchObject({ status: 'failed', reason: 'config_error', attempts: 1 });
    expect(await rowOf(bud)).toMatchObject({ status: 'skipped', reason: 'budget', attempts: 1 });
    await new Promise((r) => setTimeout(r, 3500)); // longer than any retry delay: nothing may run again
    expect(calls.get(cfg)).toBe(1);
    expect(calls.get(bud)).toBe(1);
    expect((await boss.findJobs(ENRICH_QUEUE, { key: cfg }))[0].state).toBe('completed');
  });

  it('a pg-boss job whose ledger row has disappeared is processed anyway: the row is re-created under the same id', async () => {
    const word = fx('lost');
    // send straight to pg-boss with a row id that does not exist
    const jobRowId = '00000000-0000-4000-8000-000000000042';
    await pool.query(`DELETE FROM word_enrichment_jobs WHERE id = $1`, [jobRowId]);
    await boss.send(ENRICH_QUEUE, { word, requestedBy: null, ebookId: null, jobRowId }, { singletonKey: word });
    const row = await waitFor(async () => {
      const r = (await pool.query(`SELECT * FROM word_enrichment_jobs WHERE id = $1`, [jobRowId])).rows[0];
      return r?.status === 'succeeded' ? r : false;
    }, 're-created row succeeded');
    expect(row).toMatchObject({ word, attempts: 1 });
  });

  it('startAfterSeconds delays the job (it stays queued and is not run)', async () => {
    const word = fx('later');
    await expect(enqueuer.enqueue({ word, requestedBy: null, ebookId: null, startAfterSeconds: 3600 })).resolves.toEqual({ status: 'queued' });
    const [job] = await boss.findJobs(ENRICH_QUEUE, { key: word });
    expect(job.state).toBe('created');
    expect(job.startAfter.getTime() - Date.now()).toBeGreaterThan(3500 * 1000);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await rowOf(word))!.status).toBe('queued');
    expect(calls.get(word)).toBeUndefined();
  });

  it('daily cap: the slot after the limit is skipped / daily_cap and leaves no row and no job', async () => {
    const capped = enqueuerFor(boss, `${PROVIDER}_cap`, 2);
    const words = [fx('capa'), fx('capb'), fx('capc')];
    const results = [];
    for (const word of words) results.push(await capped.enqueue({ word, requestedBy: null, ebookId: null, startAfterSeconds: 3600 }));
    expect(results.map((r) => r.status === 'skipped' ? r.reason : r.status)).toEqual(['queued', 'queued', 'daily_cap']);
    expect(await rowsOf(words[2])).toHaveLength(0);
    expect(await boss.findJobs(ENRICH_QUEUE, { key: words[2] })).toHaveLength(0);
    expect(await used(`${PROVIDER}_cap`)).toBe(2);
  });

  it('a word already in the dictionary is skipped / exists and costs no slot', async () => {
    const word = fx('known');
    const entry = (await pool.query(
      `INSERT INTO dictionary_entries (headword, lemma, meaning_vi, source, published) VALUES ($1, $1, 'x', 'manual', FALSE) RETURNING id`,
      [word]
    )).rows[0];
    try {
      const before = await used(PROVIDER);
      await expect(enqueuer.enqueue({ word: word.toUpperCase(), requestedBy: null, ebookId: null })).resolves.toEqual({ status: 'skipped', reason: 'exists' });
      expect(await used(PROVIDER)).toBe(before);
    } finally {
      await pool.query(`DELETE FROM dictionary_entries WHERE id = $1`, [entry.id]);
    }
  });

  it('send() reports a duplicate when pg-boss already holds a job but no row is active: audit row skipped / duplicate, slot given back', async () => {
    const word = fx('orphan');
    await boss.send(ENRICH_QUEUE, { word, requestedBy: null, ebookId: null, jobRowId: '00000000-0000-4000-8000-0000000000aa' }, { singletonKey: word, startAfter: 3600 });
    const before = await used(PROVIDER);
    await expect(enqueuer.enqueue({ word, requestedBy: null, ebookId: null })).resolves.toEqual({ status: 'already_queued' });
    expect(await rowOf(word)).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(await used(PROVIDER)).toBe(before);
  });

  it('queue creation and pg-boss schema installation are repeatable: a second instance starts, ensureQueues twice, changed settings are applied', async () => {
    const second = await createStartedBoss(MAIN, 'sender'); // schema already installed + queues already exist
    try {
      await ensureQueues(second, MAIN);
      await ensureQueues(second, MAIN);
      expect(await second.getQueue(ENRICH_QUEUE)).toMatchObject({ policy: 'exclusive', retryLimit: 2 });

      await ensureQueues(second, { ...MAIN, retryLimit: 4 });
      expect(await second.getQueue(ENRICH_QUEUE)).toMatchObject({ policy: 'exclusive', retryLimit: 4 });
      await ensureQueues(second, MAIN); // back to what the other tests rely on
      expect(await second.getQueue(ENRICH_QUEUE)).toMatchObject({ retryLimit: 2 });
    } finally {
      await second.stop({ graceful: false, close: true });
    }
  });

  it('reconcileStaleJobs: a row with no pg-boss job becomes failed / stale; a row with a live job is left alone', async () => {
    const orphan = fx('stale');
    await pool.query(`INSERT INTO word_enrichment_jobs (word, status) VALUES ($1, 'running')`, [orphan]);
    const live = fx('later'); // enqueued above with startAfter 1 h: queued, job still `created`

    const result = await reconcileStaleJobs({ db: pool, boss, olderThanMinutes: 0, wordPrefix: `qzq${RUN}` });

    expect(result.markedStale).toBeGreaterThanOrEqual(1);
    expect(await rowOf(orphan)).toMatchObject({ status: 'failed', reason: 'stale' });
    expect((await rowOf(live))!.status).toBe('queued');
  });

  it('nothing is left queued / running by the tests above except rows that still have a live job', async () => {
    const { rows } = await pool.query(`SELECT word FROM word_enrichment_jobs WHERE word LIKE $1 AND status IN ('queued','running') ORDER BY word`, [`qzq${RUN}%`]);
    // the three startAfter words: later, capa, capb
    expect(rows.map((r) => r.word)).toEqual([fx('capa'), fx('capb'), fx('later')].sort());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('stopping a worker', () => {
  const started: PgBoss[] = [];
  const stopAll = async () => {
    for (const b of started.splice(0)) await b.stop({ graceful: false, close: true }).catch(() => undefined);
  };

  beforeAll(async () => {
    quiet();
  });
  afterAll(stopAll);

  const startWorker = async (run: Behavior) => {
    const boss = await createStartedBoss(STOP, 'worker');
    started.push(boss);
    const worker = new EnrichmentWorker({ db: pool, runEnrichment: async (job) => run(job) });
    await registerEnrichmentWorkers(boss, worker, { concurrency: 1, pollingIntervalSeconds: 0.5, dlqPollingIntervalSeconds: 5 });
    return { boss, worker };
  };

  it('a job that finishes within the grace period completes normally', async () => {
    const word = fx('graceok');
    const { boss, worker } = await startWorker(async () => {
      await new Promise((r) => setTimeout(r, 700));
      return { status: 'succeeded' };
    });
    await enqueuerFor(boss).enqueue({ word, requestedBy: null, ebookId: null });
    await waitFor(async () => (await rowOf(word))?.status === 'running', 'row running');

    await boss.stop({ graceful: true, close: true, timeout: 10_000 });
    await worker.requeueInFlight();

    expect(await rowOf(word)).toMatchObject({ status: 'succeeded', attempts: 1 });
    started.splice(started.indexOf(boss), 1);
  });

  it('a job cut off by the end of the grace period is not lost: the row goes back to queued, the job is retried by another worker', async () => {
    const word = fx('cut');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = await startWorker(async () => {
      await gate; // never finishes in time
      return { status: 'succeeded' };
    });
    await enqueuerFor(first.boss).enqueue({ word, requestedBy: null, ebookId: null });
    await waitFor(async () => (await rowOf(word))?.status === 'running', 'row running');
    expect(first.worker.inFlight.size).toBe(1);

    // SIGTERM path (services/queue/runtime.ts): pg-boss stop with a 1 s grace, then requeue what is still running
    await first.boss.stop({ graceful: true, close: true, timeout: 1000 });
    const requeued = await first.worker.requeueInFlight();
    started.splice(started.indexOf(first.boss), 1);

    expect(requeued).toHaveLength(1);
    expect(await rowOf(word)).toMatchObject({ status: 'queued', attempts: 1 });
    const { rows: [pgJob] } = await pool.query(`SELECT state, retry_count FROM ${STOP.schema}.job WHERE name = $1 AND singleton_key = $2`, [ENRICH_QUEUE, word]);
    expect(pgJob.state).toBe('retry'); // pg-boss kept the job for another attempt

    // a new worker process takes it over
    await startWorker(async () => ({ status: 'succeeded', model: 'second-worker' }));
    const row = await waitFor(async () => ((await rowOf(word))?.status === 'succeeded' ? await rowOf(word) : false), 'job finished by the second worker', 60_000);
    expect(row).toMatchObject({ attempts: 2, model: 'second-worker' });

    // the abandoned handler of the first worker wakes up late: it must not undo the result
    release();
    await new Promise((r) => setTimeout(r, 500));
    expect(await rowOf(word)).toMatchObject({ status: 'succeeded', model: 'second-worker' });
  });
});
