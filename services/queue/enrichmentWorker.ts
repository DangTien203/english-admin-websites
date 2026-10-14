import type { JobWithMetadata, PgBoss, WorkWithMetadataHandler } from 'pg-boss';
import * as Jobs from '../../models/EnrichmentJob';
import type { EnrichmentJobDb, EnrichmentJobRow } from '../../models/EnrichmentJob';
import { OUTCOME_STATUSES, type EnrichmentOutcome, type RunEnrichment } from '../enrichment/pipeline';
import { BudgetExceeded, UpstreamConfigError } from '../upstream/errors';
import { ENRICH_DLQ, ENRICH_QUEUE, type EnrichJobData } from './constants';
import { errMessage, incr, logEvent } from './log';

/**
 * Worker side of the enrichment queue (docs/lookup-spec.md §8, §11; lifecycle in docs/lookup-queue.md).
 *
 * Invariant: when pg-boss gives a job up (retries used, expired, dead-lettered) the word_enrichment_jobs
 * row is never left `queued` / `running`. Every exit path below either finishes the row, or hands the
 * job back to pg-boss with the row `queued` (a retry is coming), or — on the last attempt — fails the
 * row before throwing so the job moves to the dead letter queue.
 */

/** The parts of a pg-boss job (fetched with includeMetadata) this worker reads. */
export interface WorkerJob {
  id: string;
  data: EnrichJobData;
  retryCount: number;
  retryLimit: number;
  signal?: AbortSignal;
}

export interface EnrichmentWorkerDeps {
  db: EnrichmentJobDb;
  runEnrichment: RunEnrichment;
}

export class EnrichmentWorker {
  /** Rows (ids) whose handler is running in THIS process: requeued if the process has to stop early. */
  readonly inFlight = new Set<string>();

  constructor(private readonly deps: EnrichmentWorkerDeps) {}

  /** pg-boss handler for ENRICH_QUEUE. pg-boss always passes an array; we register with batchSize 1. */
  handle = async (jobs: WorkerJob[]): Promise<void> => {
    for (const job of jobs) await this.process(job);
  };

  /** pg-boss handler for ENRICH_DLQ. */
  handleDeadLetter = async (jobs: WorkerJob[]): Promise<void> => {
    for (const job of jobs) {
      const { word, jobRowId } = job.data ?? ({} as EnrichJobData);
      const row = jobRowId ? await Jobs.findById(this.deps.db, jobRowId) : null;
      const changed = jobRowId ? await Jobs.failIfActive(this.deps.db, jobRowId, 'dead_letter') : false;
      incr('job.dead_letter');
      logEvent('error', 'enrich_dead_letter', {
        word,
        job_id: jobRowId,
        row_status_before: row?.status ?? 'missing',
        row_changed: changed,
        reason_before: row?.reason ?? null,
      });
    }
  };

  /** Shutdown: running rows whose handler did not get to finish go back to `queued` (their pg-boss job is retried). */
  async requeueInFlight(): Promise<string[]> {
    const ids = [...this.inFlight];
    if (ids.length === 0) return [];
    const changed = await Jobs.requeueRunning(this.deps.db, ids);
    if (changed.length > 0) logEvent('warn', 'enrich_requeued_on_shutdown', { count: changed.length, job_ids: changed });
    return changed;
  }

  // ── one job ────────────────────────────────────────────────────────────────

  private async process(job: WorkerJob): Promise<void> {
    const data = job.data;
    if (!data?.jobRowId || !data?.word) {
      // A payload we did not write. Retrying cannot fix it.
      logEvent('error', 'enrich_bad_payload', { pg_job_id: job.id });
      return;
    }

    const row = await this.claim(job);
    if (!row) return;

    const started = Date.now();
    let outcome: EnrichmentOutcome | undefined;
    let error: unknown;
    this.inFlight.add(row.id);
    try {
      outcome = await this.deps.runEnrichment({
        word: data.word,
        requestedBy: data.requestedBy ?? null,
        ebookId: data.ebookId ?? null,
        jobRowId: row.id,
        attempt: row.attempts,
        signal: job.signal,
      });
    } catch (err) {
      error = err;
    }

    try {
      // pg-boss already gave up on THIS attempt (shutdown grace expired, or the job outlived its expiry) and
      // handles its retry / dead-lettering itself. Report nothing as a result; make sure a retry sees `queued`.
      if (job.signal?.aborted) {
        await Jobs.markQueued(this.deps.db, row.id, null);
        logEvent('warn', 'enrich_aborted', { word: data.word, job_id: row.id, attempt: row.attempts });
        return;
      }

      if (error === undefined) {
        try {
          await this.finishWithOutcome(row, outcome, Date.now() - started);
          return;
        } catch (err) {
          error = err; // an invalid outcome or a failed write: same path as a thrown error, so the row never stays `running`
        }
      }
      await this.onError(job, row, error);
    } finally {
      this.inFlight.delete(row.id);
    }
  }

  /** a) load the row (re-create it if it vanished), b) running + attempts + 1. Null = nothing to do for this job. */
  private async claim(job: WorkerJob): Promise<EnrichmentJobRow | null> {
    const { db } = this.deps;
    const { word, jobRowId, requestedBy } = job.data;

    let row = await Jobs.findById(db, jobRowId);
    if (!row) {
      row = await Jobs.recreateQueued(db, { id: jobRowId, word, requestedBy: requestedBy ?? null });
      if (!row) {
        logEvent('warn', 'enrich_row_conflict', { word, job_id: jobRowId, note: 'another queued/running row exists for this word' });
        return null;
      }
      logEvent('warn', 'enrich_row_recreated', { word, job_id: jobRowId });
    }

    try {
      return await Jobs.markRunning(db, jobRowId);
    } catch (err: any) {
      if (err?.code === '23505') {
        // This row was already closed, and a newer queued/running row for the same word took its place.
        logEvent('warn', 'enrich_row_conflict', { word, job_id: jobRowId, note: 'word has another active row' });
        return null;
      }
      throw err;
    }
  }

  /** d) a returned outcome (succeeded / rejected / skipped / failed): record it and complete the job. Never retried. */
  private async finishWithOutcome(row: EnrichmentJobRow, outcome: EnrichmentOutcome | undefined, durationMs: number): Promise<void> {
    if (!outcome || !OUTCOME_STATUSES.includes(outcome.status)) {
      // A pipeline bug, not an upstream problem: treat it like any unexpected error (retry, then dead letter).
      throw new Error(`pipeline returned an invalid outcome: ${JSON.stringify(outcome)?.slice(0, 120)}`);
    }

    await Jobs.finish(this.deps.db, row.id, {
      status: outcome.status,
      reason: outcome.reason ?? null,
      entryId: outcome.entryId ?? null,
      model: outcome.model ?? null,
      inputTokens: outcome.inputTokens ?? null,
      outputTokens: outcome.outputTokens ?? null,
    });
    incr(`job.${outcome.status}`);
    logEvent('info', 'enrich', {
      word: row.word,
      job_id: row.id,
      status: outcome.status,
      reason: outcome.reason ?? null,
      attempt: row.attempts,
      duration_ms: durationMs,
      input_tokens: outcome.inputTokens ?? null,
      output_tokens: outcome.outputTokens ?? null,
    });
  }

  /** e) – g) the pipeline threw. */
  private async onError(job: WorkerJob, row: EnrichmentJobRow, err: unknown): Promise<void> {
    const { db } = this.deps;

    // f) configuration problem: a retry cannot help
    if (err instanceof UpstreamConfigError) {
      await Jobs.finish(db, row.id, { status: 'failed', reason: 'config_error' });
      incr('job.failed');
      logEvent('error', 'enrich', { word: row.word, job_id: row.id, status: 'failed', reason: 'config_error', provider: err.provider, http_status: err.status ?? null, error: errMessage(err) });
      return;
    }

    // g) spend limit reached: do not retry (a retry would only hit the same wall)
    if (err instanceof BudgetExceeded) {
      await Jobs.finish(db, row.id, { status: 'skipped', reason: 'budget' });
      incr('job.skipped');
      logEvent('error', 'enrich', { word: row.word, job_id: row.id, status: 'skipped', reason: 'budget', provider: err.provider, budget_reason: err.reason, error: errMessage(err) });
      return;
    }

    // e) UpstreamUnavailable or anything unexpected: retry through pg-boss
    const lastAttempt = job.retryCount >= job.retryLimit;
    if (lastAttempt) {
      // Fail the row BEFORE throwing: the throw sends the job to the dead letter queue.
      await Jobs.failIfActive(db, row.id, 'upstream_error');
      incr('job.failed');
      logEvent('error', 'enrich', { word: row.word, job_id: row.id, status: 'failed', reason: 'upstream_error', attempt: row.attempts, retry_count: job.retryCount, retry_limit: job.retryLimit, error: errMessage(err) });
    } else {
      await Jobs.markQueued(db, row.id, 'upstream_error');
      incr('job.retry');
      logEvent('warn', 'enrich_retry', { word: row.word, job_id: row.id, attempt: row.attempts, retry_count: job.retryCount, retry_limit: job.retryLimit, error: errMessage(err) });
    }
    throw err;
  }
}

export interface RegisterWorkerOptions {
  /** ENRICHMENT_WORKER_CONCURRENCY */
  concurrency: number;
  /** How often an idle worker polls for a job (pg-boss minimum 0.5). */
  pollingIntervalSeconds?: number;
  dlqPollingIntervalSeconds?: number;
}

/** Idle polling is a query every N seconds per worker; background enrichment does not need to be quicker. */
export const DEFAULT_POLLING_SECONDS = 5;
export const DEFAULT_DLQ_POLLING_SECONDS = 30;

export async function registerEnrichmentWorkers(boss: PgBoss, worker: EnrichmentWorker, opts: RegisterWorkerOptions): Promise<{ workId: string; dlqWorkId: string }> {
  const workId = await boss.work(
    ENRICH_QUEUE,
    {
      localConcurrency: opts.concurrency,
      batchSize: 1,
      includeMetadata: true,
      pollingIntervalSeconds: opts.pollingIntervalSeconds ?? DEFAULT_POLLING_SECONDS,
    },
    asMetadataHandler(worker.handle)
  );
  const dlqWorkId = await boss.work(
    ENRICH_DLQ,
    {
      localConcurrency: 1,
      batchSize: 1,
      includeMetadata: true,
      pollingIntervalSeconds: opts.dlqPollingIntervalSeconds ?? DEFAULT_DLQ_POLLING_SECONDS,
    },
    asMetadataHandler(worker.handleDeadLetter)
  );
  return { workId, dlqWorkId };
}

/**
 * pg-boss types the handler of a queue worked with `includeMetadata: true` as JobWithMetadata<T>[].
 * WorkerJob is the subset this worker reads (and that tests can build by hand), so one cast lives here.
 */
function asMetadataHandler(fn: (jobs: WorkerJob[]) => Promise<void>): WorkWithMetadataHandler<EnrichJobData> {
  return fn as unknown as (jobs: JobWithMetadata<EnrichJobData>[]) => Promise<void>;
}
