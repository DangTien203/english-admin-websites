import pool from '../../config/db';
import { loadTopicIds } from './topics';

/**
 * The enrichment pipeline entry point called by the queue worker (docs/lookup-spec.md §8).
 *
 * P5 built the worker lifecycle around this seam; P6a adds the first half of the stages in separate modules
 * (S1 sources/, S3 haiku/ + draft.ts, S4 haiku/validators.ts) and the topic check below. The stages are NOT
 * connected here yet: P6b wires S0–S2 and writes the dictionary (S5–S7).
 *
 * Contract with the worker (services/queue/enrichmentWorker.ts):
 *   - RETURN an outcome for every business result, including the "negative" ones (rejected, skipped,
 *     failed with invalid_output): the job is then completed and never retried.
 *   - THROW UpstreamUnavailable (or any unexpected error) for a transient problem: the worker puts the
 *     row back to `queued` and pg-boss retries with backoff.
 *   - THROW UpstreamConfigError or EnrichmentConfigError for a configuration problem (row → failed / config_error,
 *     no retry). Example: the 30 topic tags are missing from the `tags` table (topics_not_seeded).
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
  /** Short code (docs/lookup-queue.md): unknown_word, proper_noun, not_english, variant_form, exists, form_linked, ... */
  reason?: string;
  entryId?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export const OUTCOME_STATUSES: readonly EnrichmentOutcomeStatus[] = ['succeeded', 'rejected', 'skipped', 'failed'];

export type RunEnrichment = (job: EnrichmentJob) => Promise<EnrichmentOutcome>;

export interface PipelineDeps {
  /**
   * Makes sure the environment can enrich at all. Throws EnrichmentConfigError("topics_not_seeded") when the 30
   * topic tags are missing; resolves once they are known (their ids are cached in memory by loadTopicIds).
   */
  ensureTopics: () => Promise<unknown>;
}

/**
 * TODO(P6b): after ensureTopics, run S0 (exists?) → S1 collectSources → S2 (form / variant / unknown decisions, see
 * haikuSkipReason) → S3/S4 generateDraft → S5 merge → S6 transactional write → S7 bookkeeping. Keep the signature
 * and the contract above. Until then every job ends skipped / pipeline_not_ready.
 */
export function createPipeline(deps: PipelineDeps): RunEnrichment {
  return async (_job) => {
    await deps.ensureTopics();
    return { status: 'skipped', reason: 'pipeline_not_ready' };
  };
}

export const runEnrichment: RunEnrichment = createPipeline({ ensureTopics: () => loadTopicIds(pool) });
