module.exports = [
  {
    file: 'scripts/loadtest/lookup-burst.ts',
    edits: [
      [
        `const SKIP_SLOW = argv.includes('--skip-slow');`,
        `const SKIP_SLOW = argv.includes('--skip-slow');
/** LOOKUP_TOTAL_DEADLINE_MS of the app in scenario A (default 3000 = the production default). */
const DEADLINE_MS = num('deadline', 3000);`,
      ],
      [
        ` *   npm run loadtest:lookup -- --skip-slow       # without the single-flight scenario (it waits ~15 s)`,
        ` *   npm run loadtest:lookup -- --deadline 60000  # LOOKUP_TOTAL_DEADLINE_MS of the app in scenario A (default 3000, the production default)
 *   npm run loadtest:lookup -- --skip-slow       # without the single-flight scenario (it waits ~15 s)`,
      ],
      [
        `interface AppProcess {
  base: string;
  warm(n: number): Promise<void>;`,
        `interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

interface AppProcess {
  base: string;
  warm(n: number): Promise<void>;
  pool(): Promise<PoolStats>;
  /** Waits until the app's pool has nothing queued and every connection is idle (the fire-and-forget inserts of the last burst are done). */
  drained(): Promise<number>;`,
      ],
      [
        `    heap: () =>
      new Promise<Heap>((resolve) => {`,
        `    pool: () =>
      new Promise<PoolStats>((resolve) => {
        const onMessage = (m: any) => {
          if (m?.type === 'pool') {
            child.off('message', onMessage);
            resolve(m);
          }
        };
        child.on('message', onMessage);
        child.send({ type: 'pool' });
      }),
    drained: async () => {
      const t0 = Date.now();
      let calm = 0;
      while (Date.now() - t0 < 180_000) {
        const p = await poolOf();
        calm = p.waiting === 0 && p.idle === p.total ? calm + 1 : 0;
        if (calm >= 3) break;
        await sleep(500);
      }
      return Date.now() - t0;
    },
    heap: () =>
      new Promise<Heap>((resolve) => {`,
      ],
      [
        `  return {
    base: \`http://127.0.0.1:\${port}\`,`,
        `  const poolOf = () =>
    new Promise<PoolStats>((resolve) => {
      const onMessage = (m: any) => {
        if (m?.type === 'pool') {
          child.off('message', onMessage);
          resolve(m);
        }
      };
      child.on('message', onMessage);
      child.send({ type: 'pool' });
    });

  return {
    base: \`http://127.0.0.1:\${port}\`,`,
      ],
      [
        `  const app = await startApp(mock);
  try {
    mock.reset();
    mock.setControl({ google: { latencyMs: LATENCY_MS }, fd: { latencyMs: LATENCY_MS } });

    // warm-up`,
        `  const app = await startApp(mock, DEADLINE_MS === 3000 ? {} : { LOOKUP_TOTAL_DEADLINE_MS: String(DEADLINE_MS), LOOKUP_UPSTREAM_TIMEOUT_MS: String(Math.min(30_000, DEADLINE_MS)) });
  try {
    console.log(\`  app: LOOKUP_TOTAL_DEADLINE_MS=\${DEADLINE_MS}, pg pool max 10 (the pg default), database as above\`);
    mock.reset();
    mock.setControl({ google: { latencyMs: LATENCY_MS }, fd: { latencyMs: LATENCY_MS } });

    // warm-up`,
      ],
      [
        `      const t0 = Date.now();
      const jobs: Promise<void>[] = [];

      // the burst`,
        `      const t0 = Date.now();
      const jobs: Promise<void>[] = [];
      let peakWaiting = 0;
      const sampler = setInterval(() => void app.pool().then((p) => (peakWaiting = Math.max(peakWaiting, p.waiting))), 400);

      // the burst`,
      ],
      [
        `      await Promise.all(jobs);
      const wall = Date.now() - t0;
`,
        `      await Promise.all(jobs);
      const wall = Date.now() - t0;
      clearInterval(sampler);
`,
      ],
      [
        `      console.log(\`\\n  round \${round}: \${results.length} requests in \${wall} ms\`);`,
        `      console.log(\`\\n  round \${round}: \${results.length} requests in \${wall} ms · peak of requests waiting for a database connection: \${peakWaiting}\`);`,
      ],
      [
        `      roundReports.push({ round, wallMs: wall,`,
        `      const flightLogs = app.lookupLogs.filter((l) => l.shared === false && typeof l.local_ms === 'number');
      if (flightLogs.length) {
        const local = summarize(flightLogs.map((l) => l.local_ms));
        const step1 = summarize(flightLogs.map((l) => l.translation_ms ?? 0));
        console.log(\`  from the app's own log (\${flightLogs.length} flights): local database work p50 \${local.p50} ms, p95 \${local.p95} ms · upstream step 1 p50 \${step1.p50} ms\`);
      }
      roundReports.push({ round, peakWaiting, wallMs: wall,`,
      ],
      [
        `      heaps.push(await app.heap());`,
        `      const drainedMs = await app.drained();
      console.log(\`  the pool drained \${drainedMs} ms after the last response (the fire-and-forget word_lookups / words_looked_up inserts)\`);
      heaps.push(await app.heap());`,
      ],
      [
        `    // ── C · F6 on the same app ──`,
        `    await app.drained();
    // ── C · F6 on the same app ──`,
      ],
    ],
  },
];
