import * as Jobs from '../../models/EnrichmentJob';
import type { EnrichmentJobDb } from '../../models/EnrichmentJob';
import { ENRICH_QUEUE, STALE_AFTER_MINUTES } from './constants';
import { logEvent } from './log';

/** The slice of pg-boss this needs: look a job up by its payload. */
export interface JobFinder {
  findJobs(name: string, options: { data: object }): Promise<Array<{ state: string }>>;
}

export interface ReconcileResult {
  checked: number;
  markedStale: number;
  stillLive: number;
}

/** pg-boss states in which a job can still run (created / retry = waiting, active = running). */
const LIVE_STATES = new Set(['created', 'retry', 'active']);

/**
 * Safety net for the ledger: rows that are queued / running for more than STALE_AFTER_MINUTES although
 * pg-boss no longer has a live job for them (the job was deleted, or its retention ran out) are set to
 * failed / stale, so they cannot block the word forever (the partial unique index allows one active
 * row per word).
 *
 * NOT scheduled in P5 — P7 attaches it to a timer. Safe to run at any time and from several processes.
 */
export async function reconcileStaleJobs(deps: {
  db: EnrichmentJobDb;
  boss: JobFinder;
  olderThanMinutes?: number;
  /** Only rows whose word starts with this (maintenance on one word family, and the integration tests). */
  wordPrefix?: string;
  queueName?: string;
}): Promise<ReconcileResult> {
  const minutes = deps.olderThanMinutes ?? STALE_AFTER_MINUTES;
  const queue = deps.queueName ?? ENRICH_QUEUE;
  const candidates = await Jobs.findActiveOlderThan(deps.db, minutes, deps.wordPrefix);

  const result: ReconcileResult = { checked: candidates.length, markedStale: 0, stillLive: 0 };
  for (const row of candidates) {
    const jobs = await deps.boss.findJobs(queue, { data: { jobRowId: row.id } });
    if (jobs.some((j) => LIVE_STATES.has(j.state))) {
      result.stillLive++;
      continue;
    }
    if (await Jobs.failIfActive(deps.db, row.id, 'stale')) {
      result.markedStale++;
      logEvent('warn', 'enrich_stale', { word: row.word, job_id: row.id, status_before: row.status, age_minutes_min: minutes });
    }
  }
  return result;
}
