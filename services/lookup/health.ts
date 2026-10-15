import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { ENRICH_DLQ, ENRICH_QUEUE } from '../queue/constants';
import { counterSnapshot } from '../queue/log';
import { getUpstreamClients } from '../upstream';
import { currentPeriod } from '../upstream/apiUsage';
import type { BreakerSnapshot } from '../upstream/circuitBreaker';
import { lookupMetrics, type LookupMetrics, type LookupMetricsSnapshot } from './metrics';
import type { Db } from './types';

/**
 * LookupHealthService (docs/lookup-spec.md §12.2): one read-only snapshot of everything an operator wants to know when the
 * word lookup or the background enrichment misbehaves. NOT exposed over HTTP yet (P8); callers are tests and, until then,
 * `npm run health:snapshot`-style scripts.
 *
 * Every section is independent: if one query fails the section becomes { error } and the rest is still returned, because a
 * health view that dies with the thing it is watching is worth nothing. It reads, it never writes, and it never starts
 * pg-boss (the queue depth is a plain COUNT on the pg-boss tables, which also works from a process that only sends jobs).
 *
 * Privacy: job failures carry the word, the reason code and the time, never the requesting user or the ebook.
 */

export type Section<T> = T | { error: string };

export const RECENT_FAILURES_LIMIT = 20;

export interface JobFailure {
  at: string | null;
  word: string;
  status: string;
  reason: string | null;
  attempts: number;
}

export interface QueueDepth {
  schema: string;
  main: { waiting: number; active: number; byState: Record<string, number> };
  deadLetter: { waiting: number; byState: Record<string, number> };
}

export interface HealthSnapshot {
  generatedAt: string;
  /** Per provider; `anthropic_fast` is the separate breaker of the lookup fast path. */
  breakers: Record<string, Pick<BreakerSnapshot, 'state' | 'consecutiveFailures' | 'openedAt'>>;
  google: Section<{ period: string; charsUsed: number; monthlyCharLimit: number; remaining: number }>;
  anthropic: Section<{
    period: string;
    /** Enrichment jobs: prompt tokens include cache writes and reads (docs/lookup-enrichment.md). */
    enrichment: { inputTokens: number; outputTokens: number };
    /** The lookup fast path (LOOKUP_FAST_TRANSLATOR=haiku), summed over the days of the month. */
    fastPath: { inputTokens: number; outputTokens: number };
  }>;
  jobs: Section<{
    today: { period: string; used: number; limit: number; remaining: number };
    byStatus: Record<string, number>;
  }>;
  queue: Section<QueueDepth | null>;
  recentFailures: Section<JobFailure[]>;
  /** In-memory, since this process started. */
  lookups: LookupMetricsSnapshot;
  /** In-memory job / enqueue counters of the queue layer (services/queue/log.ts). */
  counters: Record<string, number>;
}

export interface HealthDeps {
  db: Db;
  breakers: () => Record<string, BreakerSnapshot>;
  limits: { googleMonthlyChars: number; maxJobsPerDay: number };
  queueSchema: string;
  metrics?: Pick<LookupMetrics, 'snapshot'>;
  counters?: () => Record<string, number>;
  now?: () => Date;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/i;

async function safe<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return await fn();
  } catch (err) {
    return { error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

export class LookupHealthService {
  private readonly metrics: Pick<LookupMetrics, 'snapshot'>;
  private readonly counters: () => Record<string, number>;
  private readonly now: () => Date;

  constructor(private readonly deps: HealthDeps) {
    this.metrics = deps.metrics ?? lookupMetrics;
    this.counters = deps.counters ?? counterSnapshot;
    this.now = deps.now ?? (() => new Date());
  }

  async getSnapshot(): Promise<HealthSnapshot> {
    const at = this.now();
    const month = currentPeriod('month', at);
    const day = currentPeriod('day', at);

    const [usage, jobsByStatus, recentFailures, queue] = await Promise.all([
      safe(() => this.usage(month, day)),
      safe(() => this.jobsByStatus()),
      safe(() => this.recentFailures()),
      safe(() => this.queueDepth()),
    ]);

    const failed = (s: unknown): s is { error: string } => typeof s === 'object' && s !== null && 'error' in s;

    return {
      generatedAt: at.toISOString(),
      breakers: this.breakers(),
      google: failed(usage)
        ? usage
        : { period: month, charsUsed: usage.googleChars, monthlyCharLimit: this.deps.limits.googleMonthlyChars, remaining: Math.max(0, this.deps.limits.googleMonthlyChars - usage.googleChars) },
      anthropic: failed(usage)
        ? usage
        : { period: month, enrichment: { inputTokens: usage.enrichmentIn, outputTokens: usage.enrichmentOut }, fastPath: { inputTokens: usage.fastIn, outputTokens: usage.fastOut } },
      jobs:
        failed(usage) || failed(jobsByStatus)
          ? { error: failed(usage) ? usage.error : (jobsByStatus as { error: string }).error }
          : { today: { period: day, used: usage.jobsToday, limit: this.deps.limits.maxJobsPerDay, remaining: Math.max(0, this.deps.limits.maxJobsPerDay - usage.jobsToday) }, byStatus: jobsByStatus },
      queue,
      recentFailures,
      lookups: this.metrics.snapshot(),
      counters: this.counters(),
    };
  }

  private breakers(): HealthSnapshot['breakers'] {
    const out: HealthSnapshot['breakers'] = {};
    try {
      for (const [name, b] of Object.entries(this.deps.breakers())) out[name] = { state: b.state, consecutiveFailures: b.consecutiveFailures, openedAt: b.openedAt };
    } catch {
      /* the clients could not be built (bad configuration): no breakers to report */
    }
    return out;
  }

  /** One query for every counter this snapshot needs. BIGINT arrives as a string. */
  private async usage(month: string, day: string) {
    const { rows } = await this.deps.db.query(
      `SELECT provider, period, unit, used FROM api_usage_counters
        WHERE (provider = 'google_translate' AND period = $1 AND unit = 'chars')
           OR (provider = 'anthropic' AND period = $1)
           OR (provider = 'anthropic_fast' AND period LIKE $2)
           OR (provider = 'enrichment' AND period = $3 AND unit = 'jobs')`,
      [month, `${month}-%`, day]
    );
    const sum = (match: (r: any) => boolean) => rows.filter(match).reduce((n, r) => n + Number(r.used), 0);
    return {
      googleChars: sum((r) => r.provider === 'google_translate'),
      enrichmentIn: sum((r) => r.provider === 'anthropic' && r.unit === 'input_tokens'),
      enrichmentOut: sum((r) => r.provider === 'anthropic' && r.unit === 'output_tokens'),
      fastIn: sum((r) => r.provider === 'anthropic_fast' && r.unit === 'input_tokens'),
      fastOut: sum((r) => r.provider === 'anthropic_fast' && r.unit === 'output_tokens'),
      jobsToday: sum((r) => r.provider === 'enrichment'),
    };
  }

  private async jobsByStatus(): Promise<Record<string, number>> {
    const { rows } = await this.deps.db.query(`SELECT status, COUNT(*)::int AS n FROM word_enrichment_jobs GROUP BY status`);
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Failed jobs, and jobs stopped by a spend limit (an error the operator has to act on), newest first. */
  private async recentFailures(): Promise<JobFailure[]> {
    const { rows } = await this.deps.db.query(
      `SELECT word, status, reason, attempts, COALESCE(finished_at, updated_at) AS at
         FROM word_enrichment_jobs
        WHERE status = 'failed' OR (status = 'skipped' AND reason = 'budget')
        ORDER BY COALESCE(finished_at, updated_at) DESC
        LIMIT $1`,
      [RECENT_FAILURES_LIMIT]
    );
    return rows.map((r) => ({ at: r.at ? new Date(r.at).toISOString() : null, word: r.word, status: r.status, reason: r.reason, attempts: r.attempts }));
  }

  /** Plain COUNT on the pg-boss job table: fresh (not the cached figure of the monitor), and it starts nothing. */
  private async queueDepth(): Promise<QueueDepth | null> {
    const schema = this.deps.queueSchema;
    if (!IDENTIFIER.test(schema)) throw new Error('invalid queue schema name');
    const exists = await this.deps.db.query(`SELECT to_regclass($1) AS t`, [`"${schema}".job`]);
    if (!exists.rows[0]?.t) return null; // pg-boss was never installed here (ENRICHMENT_ENABLED has never been on)

    const { rows } = await this.deps.db.query(
      `SELECT name, state, COUNT(*)::int AS n FROM "${schema}".job WHERE name IN ($1, $2) GROUP BY name, state`,
      [ENRICH_QUEUE, ENRICH_DLQ]
    );
    const by = (name: string) => Object.fromEntries(rows.filter((r) => r.name === name).map((r) => [r.state, r.n as number])) as Record<string, number>;
    const main = by(ENRICH_QUEUE);
    const dlq = by(ENRICH_DLQ);
    return {
      schema,
      main: { waiting: (main.created ?? 0) + (main.retry ?? 0), active: main.active ?? 0, byState: main },
      deadLetter: { waiting: (dlq.created ?? 0) + (dlq.retry ?? 0) + (dlq.active ?? 0), byState: dlq },
    };
  }
}

let instance: LookupHealthService | undefined;

/** The production instance (real pool, real breakers, the configured limits). Built lazily, once per process. */
export function getLookupHealthService(): LookupHealthService {
  instance ??= new LookupHealthService({
    db: pool,
    limits: { googleMonthlyChars: lookupConfig.google.monthlyCharLimit, maxJobsPerDay: lookupConfig.queue.maxJobsPerDay },
    queueSchema: lookupConfig.queue.schema,
    breakers: () => {
      const clients = getUpstreamClients();
      return {
        google_translate: clients.breakers.google_translate.snapshot(),
        free_dictionary: clients.breakers.free_dictionary.snapshot(),
        datamuse: clients.breakers.datamuse.snapshot(),
        anthropic: clients.breakers.anthropic.snapshot(),
        anthropic_fast: clients.fastBreaker.snapshot(),
      };
    },
  });
  return instance;
}
