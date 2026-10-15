module.exports = [
  {
    file: 'services/upstream/errors.ts',
    edits: [
      [
        `export type UpstreamProvider =`,
        `import { redactSecrets } from '../../utils/redact';

export type UpstreamProvider =`,
      ],
      [
        `    super(\`[\${provider}] \${message}\`, cause === undefined ? undefined : { cause });`,
        `    // A provider's own text may echo a key or a URL with one: nothing that reaches a log or a response keeps it (spec §12.5).
    super(redactSecrets(\`[\${provider}] \${message}\`), cause === undefined ? undefined : { cause });`,
      ],
    ],
  },
  {
    file: 'services/queue/log.ts',
    edits: [
      [
        `type Level = 'info' | 'warn' | 'error';`,
        `import { redactSecrets } from '../../utils/redact';

type Level = 'info' | 'warn' | 'error';`,
      ],
      [
        `  const line = JSON.stringify({ evt, ...fields });`,
        `  const line = redactSecrets(JSON.stringify({ evt, ...fields }));`,
      ],
      [
        `  return String((err as Error)?.message ?? err).slice(0, 300);`,
        `  return redactSecrets(String((err as Error)?.message ?? err)).slice(0, 300);`,
      ],
    ],
  },
  {
    file: 'services/lookup/lookupService.ts',
    edits: [
      [
        `import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../upstream/errors';`,
        `import { redactSecrets } from '../../utils/redact';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../upstream/errors';`,
      ],
      [
        `    this.log = deps.log ?? ((r) => console.info(JSON.stringify(r)));`,
        `    this.log = deps.log ?? ((r) => console.info(redactSecrets(JSON.stringify(r))));`,
      ],
    ],
  },
  {
    file: 'services/lookup/index.ts',
    edits: [
      [
        `import { createPgBossEnqueuer } from '../queue';`,
        `import { redactSecrets } from '../../utils/redact';
import { createPgBossEnqueuer } from '../queue';`,
      ],
      [
        `error: String((err as Error)?.message ?? err).slice(0, 160) }))`,
        `error: redactSecrets(String((err as Error)?.message ?? err)).slice(0, 160) }))`,
      ],
    ],
  },
  {
    file: 'services/upstream/index.ts',
    edits: [
      [
        `import { AnthropicEnrichClient } from './anthropicEnrichClient';`,
        `import { redactSecrets } from '../../utils/redact';
import { AnthropicEnrichClient } from './anthropicEnrichClient';`,
      ],
      [
        `error: String((err as Error)?.message ?? err).slice(0, 200) })) }`,
        `error: redactSecrets(String((err as Error)?.message ?? err)).slice(0, 200) })) }`,
      ],
    ],
  },
];
