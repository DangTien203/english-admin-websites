/**
 * The process holding a job disappears (docs/lookup-spec.md §11.8: "the worker stops cleanly so as not to abandon a job"):
 * a REAL child process runs the worker; the parent stops it politely or kills it, and the job must not be lost.
 * Real PostgreSQL, real pg-boss in a private schema. Run with: npm run test:chaos
 */
import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { PgBoss } from 'pg-boss';
import pool from '../../config/db';
import { buildBossOptions, ensureQueues, type QueueSettings } from '../../services/queue/boss';
import { ENRICH_QUEUE } from '../../services/queue/constants';
import { EnrichmentWorker, registerEnrichmentWorkers } from '../../services/queue/enrichmentWorker';
import { PgBossEnrichmentEnqueuer } from '../../services/queue/pgBossEnqueuer';
import { cleanFixtures, dropSchema, queueSettings, RUN, rowsOf, silence, sleep, startBoss, waitFor, word } from './chaosKit';

jest.setTimeout(180_000);
pool.on('error', () => undefined);

const CHILD = path.resolve(__dirname, 'fixtures', 'worker-child.ts');

function spawnWorker(settings: QueueSettings, graceMs = 2000) {
  const lines: string[] = [];
  const child: ChildProcess = fork(CHILD, [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, CHAOS_SETTINGS: JSON.stringify(settings), CHAOS_GRACE_MS: String(graceMs), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let buffer = '';
  child.stdout!.on('data', (chunk) => {
    buffer += String(chunk);
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    lines.push(...parts.map((l) => l.trim()).filter(Boolean));
  });
  const stderr: string[] = [];
  child.stderr!.on('data', (c) => stderr.push(String(c)));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return {
    child,
    lines,
    stderr,
    exited,
    ready: () => waitFor(() => lines.includes('READY') || (stderr.join('').includes('child failed') ? Promise.reject(new Error(stderr.join(''))) : false), 'the child to be READY', 90_000),
    started: (w: string) => waitFor(() => lines.includes(`JOB_STARTED ${w}`), `the child to start ${w}`, 60_000),
  };
}

const spawned: ChildProcess[] = [];
beforeAll(() => silence());
afterAll(async () => {
  for (const c of spawned) if (c.exitCode === null) c.kill('SIGKILL');
  await cleanFixtures();
  await pool.end();
});

/** A parent-side worker (in this process) that finishes jobs at once: the "other server" that picks the job up. */
async function recoveringWorker(settings: QueueSettings, superviseSeconds?: number) {
  const boss = superviseSeconds
    ? new PgBoss({ ...buildBossOptions(settings, 'worker'), superviseIntervalSeconds: superviseSeconds, monitorIntervalSeconds: superviseSeconds })
    : await startBoss(settings);
  if (superviseSeconds) {
    boss.on('error', () => undefined);
    await boss.start();
    await ensureQueues(boss, settings);
  }
  const worker = new EnrichmentWorker({ db: pool, runEnrichment: async () => ({ status: 'succeeded', model: 'recovery', inputTokens: 1, outputTokens: 1 }) });
  await registerEnrichmentWorkers(boss, worker, { concurrency: 1, pollingIntervalSeconds: 0.5, dlqPollingIntervalSeconds: 5 });
  return boss;
}

describe('the process is stopped politely while a job is running', () => {
  const settings = queueSettings('stop', { retryLimit: 3, expireSeconds: 120 });
  let parent: PgBoss;
  let enqueuer: PgBossEnrichmentEnqueuer;

  beforeAll(async () => {
    parent = await startBoss(settings);
    enqueuer = new PgBossEnrichmentEnqueuer({ pool: pool as any, getBoss: async () => parent, maxJobsPerDay: 1000, usageProvider: `enrichment_chaos_stop_${RUN}` });
  });
  afterAll(async () => {
    await parent.stop({ graceful: false, close: true });
    await dropSchema(settings.schema);
  });

  it('the job goes back to queued (not lost), and another worker finishes it', async () => {
    const w = word('politestop');
    const c = spawnWorker(settings, 1500);
    spawned.push(c.child);
    await c.ready();

    expect(await enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null })).toEqual({ status: 'queued' });
    await c.started(w);
    expect((await rowsOf(w))[0]).toMatchObject({ status: 'running', attempts: 1 });

    c.child.send('shutdown'); // what SIGTERM triggers in worker.ts
    expect(await c.exited).toBe(0);

    // not lost: the row says queued (a retry is coming) and pg-boss still holds the job
    expect((await rowsOf(w))[0]).toMatchObject({ status: 'queued', attempts: 1 });
    const [job] = await parent.findJobs(ENRICH_QUEUE, { key: w });
    expect(['retry', 'created']).toContain(job.state);

    // a worker on another server takes it over
    const other = await recoveringWorker(settings);
    try {
      const row = await waitFor(async () => (await rowsOf(w)).find((r) => r.status === 'succeeded'), 'the job to finish elsewhere');
      expect(row.attempts).toBe(2);
      expect((await parent.findJobs(ENRICH_QUEUE, { key: w }))[0].state).toBe('completed');
    } finally {
      await other.stop({ graceful: false, close: true });
    }
  });
});

describe('the process is killed outright (power loss, OOM kill) while a job is running', () => {
  const settings = queueSettings('kill', { retryLimit: 3, expireSeconds: 5 });
  let parent: PgBoss;
  let enqueuer: PgBossEnrichmentEnqueuer;

  beforeAll(async () => {
    parent = await startBoss(settings);
    enqueuer = new PgBossEnrichmentEnqueuer({ pool: pool as any, getBoss: async () => parent, maxJobsPerDay: 1000, usageProvider: `enrichment_chaos_kill_${RUN}` });
  });
  afterAll(async () => {
    await parent.stop({ graceful: false, close: true });
    await dropSchema(settings.schema);
  });

  it('nobody can tidy up, yet the job is not lost: pg-boss notices the expiry and hands it to another worker', async () => {
    const w = word('hardkill');
    const c = spawnWorker(settings);
    spawned.push(c.child);
    await c.ready();

    await enqueuer.enqueue({ word: w, requestedBy: null, ebookId: null });
    await c.started(w);
    c.child.kill('SIGKILL');
    await c.exited;

    // the dead process could not touch anything: the row still says running, the pg-boss job is still "active"
    expect((await rowsOf(w))[0]).toMatchObject({ status: 'running' });
    expect((await parent.findJobs(ENRICH_QUEUE, { key: w }))[0].state).toBe('active');

    // another server (maintenance every 2 s) sees the job outlive its expiry (5 s), retries it, and the ledger recovers
    const other = await recoveringWorker(settings, 2);
    try {
      const row = await waitFor(async () => (await rowsOf(w)).find((r) => r.status === 'succeeded'), 'the killed job to be retried and finish', 90_000);
      expect(row.attempts).toBe(2);
      expect((await rowsOf(w)).filter((r) => r.status === 'running' || r.status === 'queued')).toEqual([]); // nothing left hanging
      expect((await parent.findJobs(ENRICH_QUEUE, { key: w }))[0].state).toBe('completed');
    } finally {
      await other.stop({ graceful: false, close: true });
    }
  });

  it('and if the job never comes back (its pg-boss record is gone), the reconcile pass closes the hanging row', async () => {
    const { reconcileStaleJobs } = await import('../../services/queue/reconcile');
    const w = word('orphan');
    const { rows } = await pool.query(
      `INSERT INTO word_enrichment_jobs (word, status, created_at, updated_at) VALUES ($1, 'running', NOW() - interval '1 hour', NOW() - interval '1 hour') RETURNING id`,
      [w]
    );
    await sleep(50);
    const result = await reconcileStaleJobs({ db: pool as any, boss: parent, wordPrefix: w });
    expect(result).toMatchObject({ checked: 1, markedStale: 1 });
    expect((await rowsOf(w))[0]).toMatchObject({ id: rows[0].id, status: 'failed', reason: 'stale' });
  });
});
