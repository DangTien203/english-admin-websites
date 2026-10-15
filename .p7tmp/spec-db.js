module.exports = [
  {
    file: 'config/db.ts',
    edits: [
      [
        `export = pool;`,
        `// A server can drop an IDLE connection at any time (Neon suspends an idle compute, a failover, a restart). pg then emits 'error'
// on the pool, and an 'error' event without a listener is an uncaught exception that kills a long-running process (the API,
// the worker). The failed client is discarded by pg itself; the next query simply opens a new connection.
pool.on('error', (err: Error & { code?: string }) => {
  console.error(JSON.stringify({ evt: 'pg_pool_error', code: err.code ?? null, error: String(err.message).slice(0, 300) }));
});

export = pool;`,
      ],
    ],
  },
  {
    file: 'services/lookup/refDb.ts',
    edits: [
      [
        `    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  return refPool;`,
        `    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  // Same reason as config/db.ts: a dropped idle connection must not be an uncaught exception.
  refPool.on('error', (err: Error & { code?: string }) => {
    console.error(JSON.stringify({ evt: 'pg_pool_error', pool: 'refdata', code: err.code ?? null, error: String(err.message).slice(0, 300) }));
  });
  return refPool;`,
      ],
    ],
  },
  {
    file: 'services/queue/runtime.ts',
    edits: [
      [
        `let poolErrorLoggerAttached = false;

/**
 * A pg.Pool emits 'error' when an IDLE connection is dropped by the server (Neon does this when a compute
 * suspends). Without a listener that event is an uncaught exception and kills a long-running process.
 */
function logPoolErrors(): void {
  if (poolErrorLoggerAttached) return;
  poolErrorLoggerAttached = true;
  pool.on('error', (err) => logEvent('error', 'pg_pool_error', { error: errMessage(err) }));
}

`,
        ``,
      ],
      [
        `  logPoolErrors();
  const runWorker`,
        `  // The pool's 'error' listener (idle connections dropped by Neon) lives in config/db.ts, for every process.
  const runWorker`,
      ],
    ],
  },
];
