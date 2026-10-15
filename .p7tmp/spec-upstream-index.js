module.exports = [
  {
    file: 'services/upstream/index.ts',
    edits: [
      [
        `  anthropicFast: AnthropicEnrichClient;
  usage: ApiUsage;
  breakers: Record<UpstreamProvider, CircuitBreaker>;
}`,
        `  anthropicFast: AnthropicEnrichClient;
  usage: ApiUsage;
  breakers: Record<UpstreamProvider, CircuitBreaker>;
  /** The separate breaker of \`anthropicFast\` (reported next to \`breakers.anthropic\`, which belongs to the enrichment job). */
  fastBreaker: CircuitBreaker;
}`,
      ],
      [
        `function logBreakerChange(provider: UpstreamProvider, from: BreakerState, to: BreakerState): void {
  // Opening is worth attention; the other transitions are routine.
  const log = to === 'open' ? console.warn : console.info;
  log(JSON.stringify({ evt: 'breaker', provider, from, to }));
}`,
        `function logBreakerChange(provider: UpstreamProvider, from: BreakerState, to: BreakerState, scope?: string): void {
  // Opening is worth attention; the other transitions are routine.
  const log = to === 'open' ? console.warn : console.info;
  log(JSON.stringify({ evt: 'breaker', provider, ...(scope ? { scope } : {}), from, to }));
}`,
      ],
      [
        `  const makeBreaker = (provider: UpstreamProvider) =>
    new CircuitBreaker(provider, {
      failureThreshold: cfg.breaker.failureThreshold,
      resetMs: cfg.breaker.resetMs,
      onStateChange: logBreakerChange,
    });`,
        `  const makeBreaker = (provider: UpstreamProvider, scope?: string) =>
    new CircuitBreaker(provider, {
      failureThreshold: cfg.breaker.failureThreshold,
      resetMs: cfg.breaker.resetMs,
      onStateChange: (p, from, to) => logBreakerChange(p, from, to, scope),
    });
  const fastBreaker = makeBreaker('anthropic', 'fast_path');`,
      ],
      [
        `  instance = {
    usage,
    breakers,
    anthropicFast:`,
        `  instance = {
    usage,
    breakers,
    fastBreaker,
    anthropicFast:`,
      ],
      [
        `      { breaker: makeBreaker('anthropic') }
    ),
    google:`,
        `      { breaker: fastBreaker }
    ),
    google:`,
      ],
    ],
  },
];
