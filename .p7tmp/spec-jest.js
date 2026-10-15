module.exports = [
  { file: 'jest.config.js', edits: [
    [`  testMatch: ['**/tests/**/*.test.ts'],`, `  testMatch: ['**/tests/**/*.test.ts'],
  // Chaos scenarios (breaker timing, killed connections, child processes) are slow and run on demand: npm run test:chaos
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/chaos/'],`],
  ]},
];
