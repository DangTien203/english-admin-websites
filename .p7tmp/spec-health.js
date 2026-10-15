module.exports = [{
  file: 'services/lookup/health.ts',
  edits: [
    [`import { currentPeriod } from '../upstream/apiUsage';`, `import { getUpstreamClients } from '../upstream';\nimport { currentPeriod } from '../upstream/apiUsage';`],
    [`      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const clients = require('../upstream').getUpstreamClients() as import('../upstream').UpstreamClients;
`, `      const clients = getUpstreamClients();
`],
  ],
}];
