import type { EnrichmentInfo } from './types';

/**
 * Hook between the fast lookup path and the background enrichment job (docs/lookup-spec.md §5 F11, §7).
 *
 * The fast path calls enqueue() inside try/catch and puts the answer in the response's `enrichment`
 * field. The real implementation is services/queue/pgBossEnqueuer.ts (word_enrichment_jobs row + pg-boss
 * send, daily cap, singletonKey); NoopEnqueuer reports 'disabled' when ENRICHMENT_ENABLED=false.
 */
export interface EnqueueInput {
  /** Normalized (lowercase) word: also the singleton key. */
  word: string;
  /** Null for the command-line tool (no user). */
  requestedBy: string | null;
  ebookId: string | null;
  /** Delay before the job may run (used after an outage so the upstream has time to recover). */
  startAfterSeconds?: number;
}

export interface EnrichmentEnqueuer {
  enqueue(input: EnqueueInput): Promise<EnrichmentInfo>;
}

export class NoopEnqueuer implements EnrichmentEnqueuer {
  async enqueue(_input: EnqueueInput): Promise<EnrichmentInfo> {
    return { status: 'disabled' };
  }
}
