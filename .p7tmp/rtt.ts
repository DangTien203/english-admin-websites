import 'dotenv/config';
import pool from '../config/db';
(async () => {
  const c = await pool.connect();
  const ts: number[] = [];
  for (let i = 0; i < 30; i++) { const t = performance.now(); await c.query('SELECT 1'); ts.push(performance.now() - t); }
  c.release();
  ts.sort((a, b) => a - b);
  console.log('SELECT 1 on a warm connection: p50', ts[14].toFixed(0), 'ms, p95', ts[28].toFixed(0), 'ms, min', ts[0].toFixed(0), 'ms');
  const t = performance.now();
  await Promise.all(Array.from({ length: 100 }, () => pool.query('SELECT 1')));
  console.log('100 parallel SELECT 1 through the pool (max 10):', (performance.now() - t).toFixed(0), 'ms =', (100000 / (performance.now() - t)).toFixed(0), 'queries/s');
  await pool.end();
})();
