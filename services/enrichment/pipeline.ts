/**
 * The enrichment pipeline entry point called by the queue worker (docs/lookup-spec.md §8).
 *
 * P5 only provides the seam: the worker's lifecycle (running → succeeded / skipped / failed / retry) is
 * complete and tested against fake pipelines, while the real stages S0–S7 arrive in P6a / P6b.
 *
 * Contract with the worker (services/queue/enrichmentWorker.ts):
 *   - RETURN an outcome for every business result, including the "negative" ones (rejected, skipped,
 *     failed with invalid_output): the job is then completed and never retried.
 *   - THROW UpstreamUnavailable (or any unexpected error) for a transient problem: the worker puts the
 *     row back to `queued` and pg-boss retries with backoff.
 *   - THROW UpstreamConfigError for a configuration problem (row → failed / config_error, no retry).
 *   - THROW BudgetExceeded when a spend limit is hit (row → skipped / budget, no retry).
 *   - Honor `signal`: it aborts when the job expires or the process is shutting down.
 */

export interface EnrichmentJob {
  /** Normalized (lowercase) word. */
  word: string;
  requestedBy: string | null;
  ebookId: string | null;
  /** word_enrichment_jobs.id */
  jobRowId: string;
  /** Attempt number of this run (word_enrichment_jobs.attempts after the increment): 1, 2, 3, ... */
  attempt: number;
  signal?: AbortSignal;
}

export type EnrichmentOutcomeStatus = 'succeeded' | 'rejected' | 'skipped' | 'failed';

export interface EnrichmentOutcome {
  status: EnrichmentOutcomeStatus;
  /** Short code (docs/lookup-queue.md): unknown_word, proper_noun, exists, form_linked, ... */
  reason?: string;
  entryId?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export const OUTCOME_STATUSES: readonly EnrichmentOutcomeStatus[] = ['succeeded', 'rejected', 'skipped', 'failed'];

export type RunEnrichment = (job: EnrichmentJob) => Promise<EnrichmentOutcome>;

/**
 * Placeholder until P6.
 * TODO(P6b): replace the body with the real pipeline (S0 existence check → S1 collect → S2 lemma → S3 Haiku →
 * S4 validate → S5 merge → S6 transactional write → S7 bookkeeping). Keep the signature and the contract above.
 */
export const runEnrichment: RunEnrichment = async (_job) => ({
  status: 'skipped',
  reason: 'pipeline_not_ready',
});
