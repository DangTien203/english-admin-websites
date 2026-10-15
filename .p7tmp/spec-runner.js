module.exports = [
  { file: 'scripts/loadtest/app-runner.ts', edits: [
    [` *   ← { type: 'heap' }       →`, ` *   ← { type: 'warm', n }    opens n pooled connections in small waves, replies { type: 'warm' } (a burst of brand-new TLS connections
 *                            can make a serverless Postgres time out; the load test measures the app, not that)
 *   ← { type: 'heap' }       →`],
    [`process.on('message', async (message: { type?: string }) => {
  if (message?.type === 'heap') {`, `process.on('message', async (message: { type?: string; n?: number }) => {
  if (message?.type === 'warm') {
    const n = Math.max(1, Math.min(message.n ?? 10, 20));
    for (let done = 0; done < n; done += 3) {
      const clients = await Promise.all(Array.from({ length: Math.min(3, n - done) }, () => pool.connect()));
      clients.forEach((c) => c.release());
      await new Promise((r) => setTimeout(r, 150));
    }
    process.send?.({ type: 'warm' });
  } else if (message?.type === 'heap') {`],
  ]},
  { file: 'scripts/loadtest/lookup-burst.ts', edits: [
    [`interface AppProcess {
  base: string;`, `interface AppProcess {
  base: string;
  warm(n: number): Promise<void>;`],
    [`    lookupLogs,
    heap: () =>`, `    lookupLogs,
    warm: (n) =>
      new Promise<void>((resolve) => {
        const onMessage = (m: any) => {
          if (m?.type === 'warm') {
            child.off('message', onMessage);
            resolve();
          }
        };
        child.on('message', onMessage);
        child.send({ type: 'warm', n });
      }),
    heap: () =>`],
    [`    // warm-up: the pool's connections, the code paths, the JIT (not measured)
    for (let i = 0; i < 6; i++)`, `    // warm-up: the pool's connections, the code paths, the JIT (not measured)
    await app.warm(10);
    for (let i = 0; i < 6; i++)`],
    [`    for (let i = 0; i < 4; i++) await lookup(app, ebookId, tokens[i], word(\`sfwarm\${alpha(i)}\`), 'warm');`, `    await app.warm(10);
    for (let i = 0; i < 4; i++) await lookup(app, ebookId, tokens[i], word(\`sfwarm\${alpha(i)}\`), 'warm');`],
  ]},
];
