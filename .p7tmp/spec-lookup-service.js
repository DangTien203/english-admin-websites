module.exports = [
  {
    file: 'services/lookup/lookupService.ts',
    edits: [
      [
        `import { UpstreamUnavailable } from '../upstream/errors';`,
        `import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../upstream/errors';`,
      ],
      [
        `import { isKnownInReferenceData, lookupLocal, recordForm, resolveViaForms } from './localLookup';
import { composeTemporary, mergeOutcome } from './merge';`,
        `import { isKnownInReferenceData, lookupLocal, recordForm, resolveViaForms } from './localLookup';
import { composeTemporary, mergeOutcome } from './merge';
import { lookupMetrics, type LookupMetrics } from './metrics';`,
      ],
      [
        `  /** Structured log sink (spec §12.1). Defaults to console.info(JSON). */
  log?: (record: Record<string, unknown>) => void;
}`,
        `  /** Structured log sink (spec §12.1). Defaults to console.info(JSON). */
  log?: (record: Record<string, unknown>) => void;
  /** In-memory counters (spec §12.2). Defaults to the process-wide instance read by LookupHealthService. */
  metrics?: Pick<LookupMetrics, 'record'>;
}`,
      ],
      [
        `  private readonly log: (record: Record<string, unknown>) => void;

  constructor(private readonly deps: LookupServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((r) => console.info(JSON.stringify(r)));
  }`,
        `  private readonly log: (record: Record<string, unknown>) => void;
  private readonly metrics: Pick<LookupMetrics, 'record'>;

  constructor(private readonly deps: LookupServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((r) => console.info(JSON.stringify(r)));
    this.metrics = deps.metrics ?? lookupMetrics;
  }`,
      ],
      [
        `  ): void {
    try {
      this.log({
        evt: 'lookup',`,
        `  ): void {
    try {
      this.metrics.record({ outcome: d.outcome, source: d.source, partial: d.partial, latencyMs: this.now() - d.started });
    } catch {
      /* counting must never break a lookup */
    }
    try {
      if (d.bundle) this.reportConfigProblems(d.bundle);
    } catch {
      /* neither must reporting */
    }
    try {
      this.log({
        evt: 'lookup',`,
      ],
      [
        `    } catch {
      /* logging must never break a lookup */
    }
  }
}`,
        `    } catch {
      /* logging must never break a lookup */
    }
  }

  /**
   * Spec §11.3: a 400 / 401 / 403 from a provider is a CONFIGURATION error (wrong key, no permission): it is logged at the
   * error level so it gets noticed, whatever the visitor sees. The provider's own spend / quota limit (§11.4) is the same kind
   * of problem. Our own monthly character counter is not: it shows in the lookup line (google: error:budget_monthly_chars).
   */
  private reportConfigProblems(bundle: UpstreamBundle): void {
    const outcomes: Array<[string, { status: string; error?: unknown }]> = [
      ['translation', bundle.translation],
      ['free_dictionary', bundle.fd],
      ['definitions', bundle.step2],
    ];
    for (const [where, o] of outcomes) {
      if (o.status !== 'error' && o.status !== 'failed') continue;
      const e = o.error;
      if (e instanceof UpstreamConfigError) {
        console.error(JSON.stringify({ evt: 'upstream_config_error', where, provider: e.provider, http_status: e.status ?? null }));
      } else if (e instanceof BudgetExceeded && e.reason !== 'monthly_chars') {
        console.error(JSON.stringify({ evt: 'upstream_budget_exceeded', where, provider: e.provider, reason: e.reason }));
      }
    }
  }
}`,
      ],
      [
        `  const e = o.error;
  return e instanceof UpstreamUnavailable ? \`error:\${e.reason}\` : \`error:\${(e as Error)?.name ?? 'unknown'}\`;`,
        `  const e = o.error;
  if (e instanceof UpstreamUnavailable) return \`error:\${e.reason}\`;
  if (e instanceof BudgetExceeded) return \`error:budget_\${e.reason}\`;
  if (e instanceof UpstreamConfigError) return \`error:config_\${e.status ?? 'none'}\`;
  return \`error:\${(e as Error)?.name ?? 'unknown'}\`;`,
      ],
    ],
  },
];
