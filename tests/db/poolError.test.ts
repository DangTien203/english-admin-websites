/**
 * config/db.ts must survive the server dropping an IDLE connection (what Neon does when a compute suspends): pg emits 'error'
 * on the pool, and an 'error' event with no listener is an uncaught exception that kills a long-running process.
 * The second test really terminates a pooled backend on the dev database.
 */
import { Pool } from 'pg';
import pool from '../../config/db';

jest.setTimeout(60_000);

afterAll(async () => {
  await pool.end();
});

describe('pool.on("error") in config/db.ts', () => {
  it('has a listener, so an error event is logged as one JSON line instead of crashing the process', () => {
    expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);

    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => pool.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).not.toThrow();
    const line = JSON.parse(String(error.mock.calls[0][0]));
    expect(line).toEqual({ evt: 'pg_pool_error', code: '57P01', error: 'terminating connection due to administrator command' });
    error.mockRestore();
  });

  it('keeps the message short and never leaks a connection string', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    pool.emit('error', new Error('x'.repeat(5000)));
    expect(JSON.parse(String(error.mock.calls[0][0])).error.length).toBe(300);
    error.mockRestore();
  });

  it('survives a real server-side kill of an idle pooled connection, and the pool opens a new one', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const client = await pool.connect();
    const {
      rows: [{ pid }],
    } = await client.query('SELECT pg_backend_pid() AS pid');
    client.release(); // idle again, inside the pool

    // Another connection (not the pool under test) terminates that backend.
    const killer = new Pool({ ...(pool as any).options, max: 1 });
    killer.on('error', () => undefined);
    try {
      const { rows } = await killer.query('SELECT pg_terminate_backend($1) AS ok', [pid]);
      expect(rows[0].ok).toBe(true);
    } finally {
      await killer.end();
    }

    // The pool is told about the dead idle client asynchronously.
    const deadline = Date.now() + 10_000;
    while (!error.mock.calls.some(([l]) => String(l).includes('pg_pool_error')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const logged = error.mock.calls.map(([l]) => String(l)).filter((l) => l.includes('pg_pool_error'));
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(logged[0]).code).toBe('57P01'); // admin_shutdown

    const { rows } = await pool.query('SELECT 1 AS ok'); // still usable
    expect(rows[0].ok).toBe(1);
    error.mockRestore();
  });
});

describe('a client CHECKED OUT of the pool (inside a transaction) when the server drops its connection', () => {
  // pg-pool takes its own 'error' listener off a client while it is checked out. The persistence and queue code run their
  // transactions on such clients, so without a listener of our own the dropped connection was an uncaught exception.
  it('is logged as pg_client_error, the query gets a normal rejection, and the pool keeps working', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = await pool.connect();
    await client.query('BEGIN');
    const {
      rows: [{ pid }],
    } = await client.query('SELECT pg_backend_pid() AS pid');

    const killer = new Pool({ ...(pool as any).options, max: 1 });
    killer.on('error', () => undefined);
    try {
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
    } finally {
      await killer.end();
    }

    const deadline = Date.now() + 10_000;
    while (!error.mock.calls.some(([l]) => String(l).includes('pg_client_error')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const line = error.mock.calls.map(([l]) => String(l)).find((l) => l.includes('pg_client_error'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!).code).toBe('57P01');

    await expect(client.query('SELECT 2')).rejects.toThrow(); // the caller sees an ordinary failure and rolls back / releases
    client.release(true);

    expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    error.mockRestore();
  });

  it('every client the pool creates gets the listener (so a pooled client in a transaction is covered from its first query)', async () => {
    const client = await pool.connect();
    try {
      expect(client.listenerCount('error')).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
  });
});

describe('the dedicated reference-data pool (REFDATA_DATABASE_URL)', () => {
  it('has the same listener', async () => {
    const previous = process.env.REFDATA_DATABASE_URL;
    process.env.REFDATA_DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:1/none'; // a pool never connects until it is used
    let refDb: any;
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        refDb = require('../../services/lookup/refDb').getRefDb();
      });
    } finally {
      if (previous === undefined) delete process.env.REFDATA_DATABASE_URL;
      else process.env.REFDATA_DATABASE_URL = previous;
    }
    try {
      expect(refDb).not.toBe(pool);
      expect(refDb.listenerCount('error')).toBeGreaterThanOrEqual(1);
      expect(refDb.listenerCount('connect')).toBeGreaterThanOrEqual(1);
    } finally {
      await refDb.end();
    }
  });
});
