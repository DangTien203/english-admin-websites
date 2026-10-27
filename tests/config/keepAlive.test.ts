/**
 * TCP keep-alive on every PostgreSQL connection (config/keepAlive.ts). Without it a connection that the network drops silently looks
 * alive for about two hours and a query on it never returns: on 22/10/2026 that froze all four slots of the enrichment worker for
 * 1 h 50 min. Nothing here opens a connection.
 */
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../config/db';
import { KEEP_ALIVE } from '../../config/keepAlive';
import { buildBossOptions } from '../../services/queue/boss';

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

afterAll(async () => {
  await pool.end();
});

describe('keep-alive', () => {
  it('is on, and starts probing after 10 seconds of silence (a dead connection is found in about 20 seconds, not 2 hours)', () => {
    expect(KEEP_ALIVE).toEqual({ keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  });

  it('the application pool uses it', () => {
    expect((pool as any).options).toMatchObject({ keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  });

  it('both ways of building that pool carry it (the connection string of a deployment, and the separate DB_* variables)', () => {
    const source = read('config/db.ts');
    expect(source.match(/\.\.\.KEEP_ALIVE/g)).toHaveLength(2);
  });

  it("pg-boss's own pool gets the same settings from the application pool", () => {
    const settings = { schema: 'pgboss', poolMax: 2, retryLimit: 3, retryDelaySeconds: 30, expireSeconds: 300 };
    expect(buildBossOptions(settings as any, 'worker')).toMatchObject({ keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
    expect(buildBossOptions(settings as any, 'sender')).toMatchObject({ keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  });

  it('the pool of reference data (used when REFDATA_DATABASE_URL points elsewhere) has it too', () => {
    const source = read('services/lookup/refDb.ts');
    expect(source).toMatch(/\.\.\.KEEP_ALIVE/);
  });
});
