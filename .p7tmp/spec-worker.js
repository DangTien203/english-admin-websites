module.exports = [
  {
    file: 'services/queue/enrichmentWorker.ts',
    edits: [
      [
        `import { BudgetExceeded, UpstreamConfigError } from '../upstream/errors';`,
        `import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../upstream/errors';`,
      ],
      [
        `export interface EnrichmentWorkerDeps {
  db: EnrichmentJobDb;
  runEnrichment: RunEnrichment;
}`,
        `export interface EnrichmentWorkerDeps {
  db: EnrichmentJobDb;
  runEnrichment: RunEnrichment;
  /** Test seam for the Retry-After wait. Resolves early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Longest a handler holds its slot to honour a provider's Retry-After (spec §11.4: "429 with retry-after: wait, then retry
 * through pg-boss"). The job's own expiry is at least 300 s and the failed call took seconds, so this always fits; a longer
 * ask is cut and the pg-boss backoff (30 s, doubling) covers the rest.
 */
export const MAX_RETRY_AFTER_WAIT_MS = 60_000;

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** The pause a 429 asks for, or 0. */
export function retryAfterWaitMs(err: unknown): number {
  if (!(err instanceof UpstreamUnavailable) || err.reason !== 'rate_limited') return 0;
  const ms = err.retryAfterMs;
  return typeof ms === 'number' && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_WAIT_MS) : 0;
}`,
      ],
      [
        `    } else {
      await Jobs.markQueued(db, row.id, 'upstream_error');`,
        `    } else {
      // A 429 that says how long to wait: wait that long first, so the retry pg-boss schedules does not hit the same wall.
      const waitMs = retryAfterWaitMs(err);
      if (waitMs > 0) {
        logEvent('warn', 'enrich_retry_after_wait', { word: row.word, job_id: row.id, wait_ms: waitMs, provider: (err as UpstreamUnavailable).provider });
        await (this.deps.sleep ?? abortableSleep)(waitMs, job.signal);
      }
      await Jobs.markQueued(db, row.id, 'upstream_error');`,
      ],
    ],
  },
];
