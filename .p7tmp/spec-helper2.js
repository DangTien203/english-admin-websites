module.exports = [{
  file: 'tests/helpers/lookupApp.ts',
  edits: [
    [`import type { EnrichmentEnqueuer } from '../../services/lookup/enqueuer';`,
     `import type { EnrichmentEnqueuer } from '../../services/lookup/enqueuer';
import type { UpstreamClients } from '../../services/upstream';`],
    [`  /** Replaces the enrichment hook (only used by the service when ENRICHMENT_ENABLED=true). */
  setEnqueuer(enqueuer: EnrichmentEnqueuer): void;`,
     `  /** Replaces the enrichment hook (only used by the service when ENRICHMENT_ENABLED=true). */
  setEnqueuer(enqueuer: EnrichmentEnqueuer): void;
  /** The upstream clients (and their circuit breakers) THIS app uses. */
  upstream(): UpstreamClients;`],
    [`  let lookupModule!: typeof import('../../services/lookup');`,
     `  let lookupModule!: typeof import('../../services/lookup');
  let upstreamModule!: typeof import('../../services/upstream');`],
    [`      // eslint-disable-next-line @typescript-eslint/no-require-imports
      lookupModule = require('../../services/lookup');`,
     `      // eslint-disable-next-line @typescript-eslint/no-require-imports
      lookupModule = require('../../services/lookup');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      upstreamModule = require('../../services/upstream');`],
    [`    setEnqueuer: (enqueuer) => lookupModule.setEnrichmentEnqueuer(enqueuer),`,
     `    setEnqueuer: (enqueuer) => lookupModule.setEnrichmentEnqueuer(enqueuer),
    upstream: () => upstreamModule.getUpstreamClients(),`],
    // network guard
    [`export async function bootLookupApp(opts: BootOptions = {}): Promise<LookupApp> {
  const supertest = (await import('supertest')).default;`,
     `/**
 * Tests never reach a real service: while a boot is open, global fetch refuses every host except the loopback one the mock
 * listens on. (Only the host is reported: a URL could carry a query string.)
 */
function installNetworkGuard(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input?.url ?? String(input));
    const host = new URL(raw).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error(\`network guard: a test tried to reach \${host}\`);
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export async function bootLookupApp(opts: BootOptions = {}): Promise<LookupApp> {
  const supertest = (await import('supertest')).default;
  const removeGuard = installNetworkGuard();`],
    [`      } finally {
        await pool.end();
        if (ownMock) await mock.close();
      }`,
     `      } finally {
        await pool.end();
        if (ownMock) await mock.close();
        removeGuard();
      }`],
  ],
}];
