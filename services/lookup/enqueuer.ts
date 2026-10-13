import type { EnrichmentInfo } from './types';

/**
 * Hook between the fast lookup path and the background enrichment job (docs/lookup-spec.md §5 F11, §7).
 *
 * P3 only defines the seam: the fast path calls enqueue() inside try/catch and puts the answer in the
 * response's `enrichment` field. The real implementation (word_enrichment_jobs row + pg-boss send, daily
 * cap, singletonKey) is P5; until then NoopEnqueuer reports 'disabled'.
 */
export interface EnqueueInput {
  /** Normalized (lowercase) word: also the singleton key. */
  word: string;
  requestedBy: string;
  ebookId: string;
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
