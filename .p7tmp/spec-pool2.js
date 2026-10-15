module.exports = [
  {
    file: 'config/db.ts',
    edits: [
      [
        `import dotenv from 'dotenv';
`,
        `import dotenv from 'dotenv';
import { attachPoolErrorHandlers } from './poolErrors';
`,
      ],
      [
        `// A server can drop an IDLE connection at any time (Neon suspends an idle compute, a failover, a restart). pg then emits 'error'
// on the pool, and an 'error' event without a listener is an uncaught exception that kills a long-running process (the API,
// the worker). The failed client is discarded by pg itself; the next query simply opens a new connection.
pool.on('error', (err: Error & { code?: string }) => {
  console.error(JSON.stringify({ evt: 'pg_pool_error', code: err.code ?? null, error: String(err.message).slice(0, 300) }));
});
`,
        `// A server can drop a connection at any time (Neon suspends an idle compute, a failover, a restart). pg reports it as an 'error'
// EVENT, and an event without a listener is an uncaught exception that kills a long-running process (the API, the worker):
// for an idle client on the pool, and for a client checked out in the middle of a transaction. See config/poolErrors.ts.
attachPoolErrorHandlers(pool);
`,
      ],
    ],
  },
  {
    file: 'services/lookup/refDb.ts',
    edits: [
      [
        `import pool from '../../config/db';
`,
        `import pool from '../../config/db';
import { attachPoolErrorHandlers } from '../../config/poolErrors';
`,
      ],
      [
        `  // Same reason as config/db.ts: a dropped idle connection must not be an uncaught exception.
  refPool.on('error', (err: Error & { code?: string }) => {
    console.error(JSON.stringify({ evt: 'pg_pool_error', pool: 'refdata', code: err.code ?? null, error: String(err.message).slice(0, 300) }));
  });
`,
        `  // Same reason as config/db.ts: a dropped connection must not be an uncaught exception.
  attachPoolErrorHandlers(refPool, 'refdata');
`,
      ],
    ],
  },
];
