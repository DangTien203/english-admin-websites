/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 20000,
  setupFiles: ['<rootDir>/tests/setup.ts'],
  // DB pool shared across tests — run sequentially for deterministic state.
  maxWorkers: 1,
  // Pool keeps idle connections alive; force-exit after tests finish.
  forceExit: true,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
    // pg-boss and the dependencies listed below ship as ES modules; Jest (CommonJS) has to compile them.
    '^.+\\.m?js$': ['ts-jest', { tsconfig: 'tsconfig.test.json', diagnostics: false }],
  },
  transformIgnorePatterns: ['/node_modules/(?!(pg-boss|rrule-temporal|serialize-error|non-error)/)'],
};
