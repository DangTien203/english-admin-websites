import type { ConstructorOptions, PgBoss, Queue } from 'pg-boss';
import pool from '../../config/db';
import { ENRICH_DLQ, ENRICH_QUEUE, SHUTDOWN_GRACE_MS, computeJobExpireSeconds } from './constants';
import { errMessage, logEvent } from './log';

/**
 * pg-boss 12 infrastructure: one PgBoss instance per process, started once and reused
 * (docs/lookup-queue.md has the API cross-check this code is written against).
 *
 *   - 'worker' role: runs pg-boss maintenance (expiring stuck jobs, deleting old ones).
 *   - 'sender' role: only inserts jobs, maintenance is switched off (`supervise: false`).
 *   - Cron scheduling (`schedule`) stays off: nothing uses it before P7.
 */

export type BossRole = 'sender' | 'worker';

export interface QueueSettings {
  /** PGBOSS_SCHEMA */
  schema: string;
  /** PGBOSS_POOL_MAX: connections of pg-boss's OWN pool (the app pool is separate). */
  poolMax: number;
  /** ENRICHMENT_JOB_RETRY_LIMIT: retries after the first run (retryLimit 3 = at most 4 runs). */
  retryLimit: number;
  /** ENRICHMENT_JOB_RETRY_DELAY_SECONDS */
  retryDelaySeconds: number;
  /** Upper bound of the exponential backoff delay. Unset in production; tests keep retries fast with it. */
  retryDelayMaxSeconds?: number;
  /** How long a job may stay `active` before pg-boss fails / retries it. */
  expireSeconds: number;
}

/** Connection fields pg-boss accepts, taken from the pool the app already uses (single source of truth). */
function connectionFromAppPool(): ConstructorOptions {
  const o: any = (pool as any).options ?? {};
  const out: ConstructorOptions = {};
  if (o.connectionString) out.connectionString = o.connectionString;
  if (o.host !== undefined) out.host = o.host;
  if (o.port !== undefined) out.port = Number(o.port);
  if (o.database !== undefined) out.database = o.database;
  if (o.user !== undefined) out.user = o.user;
  if (o.password !== undefined) out.password = o.password;
  if (o.ssl) out.ssl = o.ssl;
  return out;
}

export function buildBossOptions(settings: QueueSettings, role: BossRole, connection: ConstructorOptions = connectionFromAppPool()): ConstructorOptions {
  return {
    ...connection,
    schema: settings.schema,
    max: settings.poolMax,
    application_name: role === 'worker' ? 'wordygo-enrichment-worker' : 'wordygo-enrichment-sender',
    instanceName: role === 'worker' ? 'enrichment-worker' : 'enrichment-sender',
    supervise: role === 'worker',
    schedule: false,
  };
}

/** Options of the enrichment queue (docs/lookup-spec.md §7). */
export function enrichQueueOptions(settings: QueueSettings): Omit<Queue, 'name'> {
  return {
    policy: 'exclusive',
    deadLetter: ENRICH_DLQ,
    retryLimit: settings.retryLimit,
    retryDelay: settings.retryDelaySeconds,
    retryBackoff: true,
    ...(settings.retryDelayMaxSeconds !== undefined ? { retryDelayMax: settings.retryDelayMaxSeconds } : {}),
    expireInSeconds: settings.expireSeconds,
  };
}

/**
 * Creates the dead letter queue FIRST, then the main queue. Safe to run any number of times:
 * createQueue is a no-op for an existing queue, but it does NOT change the options of an existing
 * one, so changed settings (e.g. a new retry limit) are applied with updateQueue.
 */
export async function ensureQueues(boss: PgBoss, settings: QueueSettings): Promise<void> {
  await boss.createQueue(ENRICH_DLQ);

  const wanted = enrichQueueOptions(settings);
  await boss.createQueue(ENRICH_QUEUE, wanted);

  const actual: any = await boss.getQueue(ENRICH_QUEUE);
  if (actual && actual.policy !== 'exclusive') {
    // The policy cannot be changed after creation, and "one job per word" depends on it.
    throw new Error(`queue ${ENRICH_QUEUE} exists with policy "${actual.policy}", expected "exclusive". Delete the queue (pgboss.deleteQueue) so it can be re-created.`);
  }

  const drift =
    !actual ||
    actual.deadLetter !== wanted.deadLetter ||
    actual.retryLimit !== wanted.retryLimit ||
    actual.retryDelay !== wanted.retryDelay ||
    actual.retryBackoff !== wanted.retryBackoff ||
    actual.expireInSeconds !== wanted.expireInSeconds ||
    (actual.retryDelayMax ?? null) !== (wanted.retryDelayMax ?? null);
  if (drift) {
    const { policy: _policy, ...updatable } = wanted;
    await boss.updateQueue(ENRICH_QUEUE, { ...updatable, retryDelayMax: wanted.retryDelayMax ?? null });
    logEvent('info', 'queue_options_updated', { queue: ENRICH_QUEUE, retryLimit: wanted.retryLimit, retryDelay: wanted.retryDelay, expireInSeconds: wanted.expireInSeconds });
  }
}

/** Creates, starts and prepares a PgBoss instance (no singleton: tests and getBoss() build on this). */
export async function createStartedBoss(settings: QueueSettings, role: BossRole, connection?: ConstructorOptions): Promise<PgBoss> {
  // Loaded on demand: pg-boss is an ES module package, and processes that never use the queue should not pay for it.
  const { PgBoss: PgBossClass } = await import('pg-boss');
  const boss = new PgBossClass(buildBossOptions(settings, role, connection));

  // An 'error' event with no listener would crash the process.
  boss.on('error', (err) => logEvent('error', 'pgboss_error', { message: errMessage(err), queue: (err as any)?.queue }));
  boss.on('warning', (w) => logEvent('warn', 'pgboss_warning', { message: errMessage(w?.message) }));

  try {
    await boss.start({ attempts: 3 });
    await ensureQueues(boss, settings);
  } catch (err) {
    await boss.stop({ graceful: false, close: true }).catch(() => undefined);
    throw err;
  }
  return boss;
}

export async function settingsFromConfig(): Promise<QueueSettings> {
  // Lazy: importing this module must not validate the environment.
  const { lookupConfig } = await import('../../config/lookup');
  return {
    schema: lookupConfig.queue.schema,
    poolMax: lookupConfig.queue.poolMax,
    retryLimit: lookupConfig.queue.jobRetryLimit,
    retryDelaySeconds: lookupConfig.queue.jobRetryDelaySeconds,
    expireSeconds: computeJobExpireSeconds(lookupConfig.anthropic.timeoutMsEnrich),
  };
}

let current: Promise<PgBoss> | undefined;
let currentRole: BossRole | undefined;

/**
 * The process-wide PgBoss: started on first use, then reused. The role of the FIRST caller sticks
 * (default: 'worker' when ENRICHMENT_WORKER_ENABLED=true, else 'sender'). A failed start is not cached.
 */
export function getBoss(role?: BossRole): Promise<PgBoss> {
  if (!current) {
    const attempt = (async () => {
      const { lookupConfig } = await import('../../config/lookup');
      const resolved: BossRole = role ?? (lookupConfig.flags.enrichmentWorkerEnabled ? 'worker' : 'sender');
      currentRole = resolved;
      return createStartedBoss(await settingsFromConfig(), resolved);
    })();
    current = attempt;
    attempt.catch(() => {
      if (current === attempt) {
        current = undefined;
        currentRole = undefined;
      }
    });
  }
  return current;
}

export function currentBossRole(): BossRole | undefined {
  return currentRole;
}

export function bossIsStarted(): boolean {
  return current !== undefined;
}

/**
 * Graceful stop: no new jobs are fetched, running handlers get `graceMs` to finish, then the pool closes.
 * pg-boss fails whatever is still running after that, so the job is retried later instead of being lost.
 */
export async function stopBoss(graceMs: number = SHUTDOWN_GRACE_MS): Promise<void> {
  const pending = current;
  current = undefined;
  currentRole = undefined;
  if (!pending) return;
  let boss: PgBoss;
  try {
    boss = await pending;
  } catch {
    return; // never started
  }
  await boss.stop({ graceful: true, close: true, timeout: graceMs });
}
