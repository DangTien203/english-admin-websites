/**
 * In-memory counters of the lookup fast path (docs/lookup-spec.md §12.2): lookups by source and outcome, the share of
 * partial answers, and latency percentiles over the last N lookups. One instance per process; nothing is stored, the counters
 * start from zero on every restart (the durable numbers are in api_usage_counters and word_enrichment_jobs, see health.ts).
 *
 * Memory is bounded: the key sets (source × outcome) are tiny and fixed, the latencies live in a ring buffer.
 */

export interface LookupSample {
  /** hit, temporary, not_found, unavailable, rate_limited */
  outcome: string;
  /** dictionary, translation, none */
  source: string;
  partial: boolean;
  latencyMs: number;
}

export interface LatencySummary {
  /** How many latencies the percentiles are computed from (at most the window size). */
  samples: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface LookupMetricsSnapshot {
  since: string;
  total: number;
  bySource: Record<string, number>;
  byOutcome: Record<string, number>;
  /** "source:outcome" → count, e.g. "translation:temporary". */
  bySourceOutcome: Record<string, number>;
  /** Share of partial answers among the answers that carry a body (outcome "temporary"). */
  partial: { count: number; of: number; rate: number };
  latency: LatencySummary;
}

export const DEFAULT_LATENCY_WINDOW = 500;

/** Nearest-rank percentile of an ASCENDING sorted array; null for an empty one. */
export function percentile(sortedAscending: readonly number[], p: number): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length, Math.max(1, rank)) - 1];
}

export class LookupMetrics {
  private since: Date;
  private total = 0;
  private readonly bySource = new Map<string, number>();
  private readonly byOutcome = new Map<string, number>();
  private readonly bySourceOutcome = new Map<string, number>();
  private temporary = 0;
  private partial = 0;
  private ring: number[] = [];
  private next = 0;

  constructor(
    private readonly windowSize: number = DEFAULT_LATENCY_WINDOW,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!(windowSize >= 1)) throw new RangeError('windowSize must be >= 1');
    this.since = now();
  }

  record(sample: LookupSample): void {
    this.total++;
    bump(this.bySource, sample.source);
    bump(this.byOutcome, sample.outcome);
    bump(this.bySourceOutcome, `${sample.source}:${sample.outcome}`);
    if (sample.outcome === 'temporary') {
      this.temporary++;
      if (sample.partial) this.partial++;
    }
    const ms = Number.isFinite(sample.latencyMs) ? Math.max(0, Math.round(sample.latencyMs)) : 0;
    if (this.ring.length < this.windowSize) this.ring.push(ms);
    else this.ring[this.next] = ms;
    this.next = (this.next + 1) % this.windowSize;
  }

  snapshot(): LookupMetricsSnapshot {
    const sorted = [...this.ring].sort((a, b) => a - b);
    return {
      since: this.since.toISOString(),
      total: this.total,
      bySource: Object.fromEntries(this.bySource),
      byOutcome: Object.fromEntries(this.byOutcome),
      bySourceOutcome: Object.fromEntries(this.bySourceOutcome),
      partial: { count: this.partial, of: this.temporary, rate: this.temporary === 0 ? 0 : Math.round((this.partial / this.temporary) * 10_000) / 10_000 },
      latency: { samples: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.length ? sorted[sorted.length - 1] : null },
    };
  }

  reset(): void {
    this.since = this.now();
    this.total = 0;
    this.bySource.clear();
    this.byOutcome.clear();
    this.bySourceOutcome.clear();
    this.temporary = 0;
    this.partial = 0;
    this.ring = [];
    this.next = 0;
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** The process-wide instance the lookup service records into and LookupHealthService reads. */
export const lookupMetrics = new LookupMetrics();
