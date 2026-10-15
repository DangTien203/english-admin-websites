module.exports = [
  {
    file: 'CLAUDE.md',
    edits: [
      [
        `npm run test:watch
`,
        `npm run test:watch
npm run test:chaos    # fault-injection scenarios (breaker, 429, budgets, killed connections / processes); slow, NOT part of npm test — docs/lookup-chaos.md
npm run mock:upstream # local fake Google / Free Dictionary / Datamuse (127.0.0.1, dev and tests only) — docs/lookup-loadtest.md
npm run loadtest:lookup  # burst load test of POST /api/v1/ebooks/:id/lookup (single-flight, per-user limit, latency, heap)
npm run health:snapshot  # LookupHealthService.getSnapshot() as JSON (breakers, Google chars, tokens, jobs, queue depth)
npm run enrich:redrive   # re-send dead-lettered enrichment jobs; dry-run unless --confirm — docs/lookup-runbook.md
`,
      ],
      [
        `SSL only enabled with \`NODE_ENV=production\`.`,
        `SSL only enabled with \`NODE_ENV=production\`. Pool and client \`'error'\` listeners (a dropped Neon connection must not crash the process) are attached by [config/poolErrors.ts](config/poolErrors.ts); any new \`new Pool()\` must call \`attachPoolErrorHandlers\`.`,
      ],
    ],
  },
];
