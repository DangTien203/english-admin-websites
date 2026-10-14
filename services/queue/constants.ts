/**
 * Names and fixed numbers of the enrichment queue (docs/lookup-spec.md §7, docs/lookup-queue.md).
 */

export const ENRICH_QUEUE = 'dictionary.enrich_word';
/** Dead letter queue: must exist BEFORE ENRICH_QUEUE references it. */
export const ENRICH_DLQ = 'dictionary.enrich_word.dlq';

/** api_usage_counters key of the daily job cap (spec §11.7). */
export const ENRICHMENT_USAGE_PROVIDER = 'enrichment';
export const ENRICHMENT_USAGE_UNIT = 'jobs';

/**
 * Floor for the pg-boss `expireInSeconds` of a job (how long it may stay `active`). The real value is
 * computeJobExpireSeconds(): never below this, and always above the Anthropic timeout.
 */
export const JOB_EXPIRE_FLOOR_SECONDS = 300;

/** SIGTERM / SIGINT: how long running jobs get to finish before the process exits. */
export const SHUTDOWN_GRACE_MS = 30_000;

/** reconcileStaleJobs(): a queued / running row older than this with no pg-boss job behind it is stale. */
export const STALE_AFTER_MINUTES = 30;

/** Payload of a pg-boss job. Deliberately tiny and free of personal data (spec §10.9). */
export interface EnrichJobData {
  /** Normalized (lowercase) word: also the singletonKey. */
  word: string;
  requestedBy: string | null;
  ebookId: string | null;
  /** word_enrichment_jobs.id */
  jobRowId: string;
}

/**
 * pg-boss lets a job run `expireInSeconds` before it is failed / retried. The pipeline may call Haiku
 * twice (first answer + one corrected retry, spec §9.7), so give it two timeouts plus a minute for the
 * other stages — never less than the fixed floor.
 */
export function computeJobExpireSeconds(anthropicTimeoutMs: number): number {
  return Math.max(JOB_EXPIRE_FLOOR_SECONDS, Math.ceil((2 * anthropicTimeoutMs) / 1000) + 60);
}
