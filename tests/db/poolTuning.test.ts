/**
 * config/db.ts: how the pool treats connections. node-postgres' defaults (idle connections closed after 10 s, no limit on waiting for
 * a connection) cost a reconnect — TCP + TLS + auth, ~700 ms to the remote database — whenever a user paused for more than 10 s, so a
 * server keeps them for 5 minutes. Under NODE_ENV=test the defaults stay (every suite builds its own pool). Building a pool opens no
 * connection, so none of this touches the database.
 */
import { warmPool } from '../../config/poolWarmup';

type Env = Record<string, string | undefined>;

/** config/db.ts loaded fresh under `env`. */
function loadPool(env: Env): any {
  const saved: Env = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    let pool: any;
    jest.isolateModules(() => {
      pool = require('../../config/db');
    });
    return pool;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const pools: any[] = [];
const load = (env: Env) => {
  const pool = loadPool(env);
  pools.push(pool);
  return pool;
};

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
});

const CLEAN = { DB_POOL_MAX: undefined, DB_POOL_MIN: undefined, DB_POOL_IDLE_TIMEOUT_MS: undefined, DB_CONNECT_TIMEOUT_MS: undefined, DB_QUERY_TIMEOUT_MS: undefined };

describe('the pool of a server', () => {
  it('keeps idle connections for 5 minutes, fails a wait for a connection after 20 s, and never keeps a script alive', () => {
    const pool = load({ ...CLEAN, NODE_ENV: 'development' });
    expect(pool.options).toMatchObject({
      max: 10,
      min: 0,
      idleTimeoutMillis: 300_000,
      connectionTimeoutMillis: 20_000,
      allowExitOnIdle: true,
      keepAlive: true, // config/keepAlive.ts is still applied
    });
    expect(pool.options.query_timeout).toBeFalsy(); // opt-in
  });

  it('a query timeout can be switched on', () => {
    expect(load({ ...CLEAN, NODE_ENV: 'production', DB_QUERY_TIMEOUT_MS: '60000' }).options.query_timeout).toBe(60_000);
  });

  it('is tunable from the environment; an unusable value falls back to the default', () => {
    const tuned = load({ NODE_ENV: 'production', DB_POOL_MAX: '4', DB_POOL_MIN: '1', DB_POOL_IDLE_TIMEOUT_MS: '60000', DB_CONNECT_TIMEOUT_MS: '5000' });
    expect(tuned.options).toMatchObject({ max: 4, min: 1, idleTimeoutMillis: 60_000, connectionTimeoutMillis: 5_000 });

    const junk = load({ NODE_ENV: 'development', DB_POOL_MAX: '0', DB_POOL_MIN: '-3', DB_POOL_IDLE_TIMEOUT_MS: 'soon', DB_CONNECT_TIMEOUT_MS: '' });
    expect(junk.options).toMatchObject({ max: 10, min: 0, idleTimeoutMillis: 300_000, connectionTimeoutMillis: 20_000 });
  });
});

describe('under NODE_ENV=test', () => {
  it('keeps the node-postgres defaults', () => {
    const pool = load({ ...CLEAN, NODE_ENV: 'test' });
    expect(pool.options).toMatchObject({ max: 10, idleTimeoutMillis: 10_000, allowExitOnIdle: false });
    expect(pool.options.connectionTimeoutMillis).toBeFalsy();
  });
});

describe('warmPool', () => {
  it('opens the requested number of connections at once (one SELECT 1 each) and reports it', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const r = await warmPool({ query } as any, 3);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(r).toMatchObject({ requested: 3, opened: 3, failed: 0 });
  });

  it('never throws: a database that is not there only shows in the numbers', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await warmPool({ query } as any, 3);
    expect(r).toMatchObject({ requested: 3, opened: 1, failed: 2 });
  });

  it('does nothing for zero or a negative count', async () => {
    const query = jest.fn();
    expect(await warmPool({ query } as any, 0)).toMatchObject({ requested: 0, opened: 0, failed: 0 });
    expect(await warmPool({ query } as any, -2)).toMatchObject({ requested: 0 });
    expect(query).not.toHaveBeenCalled();
  });
});
