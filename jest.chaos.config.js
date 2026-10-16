/**
 * Chaos / fault-injection scenarios (docs/lookup-chaos.md): `npm run test:chaos`.
 * Same transform and setup as the normal suite, but only tests/chaos/**, with room for the ones that wait for a breaker to
 * reset or for pg-boss to notice a killed worker. Nothing here calls a real service: upstreams are the mock server
 * (scripts/mock-upstream) and a fake Anthropic client.
 */
const base = require('./jest.config');

module.exports = {
  ...base,
  testMatch: ['**/tests/chaos/**/*.chaos.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.claude/'],
  testTimeout: 180000,
};
