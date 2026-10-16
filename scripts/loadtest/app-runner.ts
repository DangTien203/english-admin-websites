/**
 * The Express app as a process of its own, for scripts/loadtest/lookup-burst.ts (development and tests only).
 * Listens on 127.0.0.1 on a free port and talks to its parent over IPC:
 *   → { type: 'listening', port }
 *   ← { type: 'warm', n }    opens n pooled connections in small waves, replies { type: 'warm' } (a burst of brand-new TLS connections
 *                            can make a serverless Postgres time out; the load test measures the app, not that)
 *   ← { type: 'pool' }       → { type: 'pool', total, idle, waiting }   (the pg pool: connections, idle ones, requests waiting for one)
 *   ← { type: 'heap' }       → { type: 'heap', heapUsed, heapTotal, rss, external, arrayBuffers }   (after two forced GCs)
 *   ← { type: 'shutdown' }   closes the server and the pool, exits
 * Started with --expose-gc so the heap figures are not polluted by garbage that simply has not been collected yet.
 */
import 'dotenv/config';
import type { AddressInfo } from 'node:net';
import app from '../../app';
import pool from '../../config/db';
import { stopBoss } from '../../services/queue';

if (process.env.NODE_ENV === 'production') {
  console.error('the load-test app runner is not for production');
  process.exit(1);
}

const server = app.listen(0, '127.0.0.1', () => {
  process.send?.({ type: 'listening', port: (server.address() as AddressInfo).port });
});

process.on('message', async (message: { type?: string; n?: number }) => {
  if (message?.type === 'warm') {
    const n = Math.max(1, Math.min(message.n ?? 10, 20));
    for (let done = 0; done < n; done += 3) {
      const clients = await Promise.all(Array.from({ length: Math.min(3, n - done) }, () => pool.connect()));
      clients.forEach((c) => c.release());
      await new Promise((r) => setTimeout(r, 150));
    }
    process.send?.({ type: 'warm' });
  } else if (message?.type === 'pool') {
    process.send?.({ type: 'pool', total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
  } else if (message?.type === 'heap') {
    (globalThis as { gc?: () => void }).gc?.();
    await new Promise((r) => setTimeout(r, 300));
    (globalThis as { gc?: () => void }).gc?.();
    const m = process.memoryUsage();
    process.send?.({ type: 'heap', heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers });
  } else if (message?.type === 'shutdown') {
    server.close();
    server.closeAllConnections();
    await stopBoss(3000).catch(() => undefined); // only started when the scenario sends jobs (ENRICHMENT_ENABLED=true)
    await pool.end().catch(() => undefined);
    process.exit(0);
  }
});
