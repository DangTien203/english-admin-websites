module.exports = [
  {
    file: 'jest.config.js',
    edits: [[
      "  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/chaos/'],",
      "  // .claude/worktrees holds checked-out copies of this repo (other sessions' work): their tests run old code against the same database\n  // and fail for reasons that are not this tree's. They are not part of this suite (nor of the haste map: same package name).\n  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/chaos/', '<rootDir>/.claude/'],\n  modulePathIgnorePatterns: ['<rootDir>/.claude/'],",
    ]],
  },
  {
    file: 'jest.chaos.config.js',
    edits: [[
      "  testPathIgnorePatterns: ['/node_modules/'],",
      "  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.claude/'],",
    ]],
  },
  {
    file: 'services/lookup/index.ts',
    edits: [[
      "/** Usage ledger name for the fast-path Haiku calls (api_usage_counters.provider). */",
      "/**\n * Graceful shutdown: lets the job sends and word_lookups inserts that follow answers already given finish (spec 1.5 runs them after\n * the response, so closing the HTTP server no longer waits for them). Bounded: a send stuck on a dead database must not hold the exit.\n */\nexport async function drainLookupBackground(maxMs: number = 10_000): Promise<void> {\n  if (!service) return;\n  let timer: NodeJS.Timeout | undefined;\n  await Promise.race([\n    service.idle(),\n    new Promise<void>((resolve) => {\n      timer = setTimeout(resolve, maxMs);\n    }),\n  ]);\n  if (timer) clearTimeout(timer);\n}\n\n/** Usage ledger name for the fast-path Haiku calls (api_usage_counters.provider). */",
    ]],
  },
  {
    file: 'app.ts',
    edits: [
      [
        "import { startEnrichmentRuntime } from './services/queue';",
        "import { drainLookupBackground } from './services/lookup';\nimport { startEnrichmentRuntime } from './services/queue';",
      ],
      [
        "          { name: 'stop_queue', run: async () => void (await runtime?.stop()) },",
        "          // job sends and word_lookups inserts that follow answers already given (they run after the response, spec 1.5)\n          { name: 'lookup_background', run: () => drainLookupBackground() },\n          { name: 'stop_queue', run: async () => void (await runtime?.stop()) },",
      ],
    ],
  },
];
