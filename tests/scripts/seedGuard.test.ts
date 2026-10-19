/**
 * The safety latch of `npm run db:seed` (scripts/seedGuard.ts, called first thing by scripts/seed.ts). The seed EMPTIES many tables, so
 * nothing here may run it: the guard is tested as a pure function, and the order of the lines in seed.ts is checked as text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WIPE_FLAG, checkSeedSafety, guardSeed, isLocalHost, seedTarget } from '../../scripts/seedGuard';

const SEED_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'seed.ts'), 'utf8');
const NEON = 'postgresql://neon_user:s3cr3t-pass@ep-example-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
const LOCAL = 'postgresql://postgres:s3cr3t-pass@localhost:5432/english_learning_app';

describe('where the pool would connect (the same variables as config/db.ts)', () => {
  it('reads host and database from DATABASE_URL, without the credentials', () => {
    expect(seedTarget({ DATABASE_URL: NEON })).toEqual({ host: 'ep-example-123.ap-southeast-1.aws.neon.tech', database: 'neondb', via: 'DATABASE_URL' });
    expect(seedTarget({ DATABASE_URL: LOCAL })).toMatchObject({ host: 'localhost', database: 'english_learning_app' });
  });

  it('falls back to DB_HOST / DB_NAME, and to localhost when nothing is set', () => {
    expect(seedTarget({ DB_HOST: 'db.internal', DB_NAME: 'x' })).toEqual({ host: 'db.internal', database: 'x', via: 'DB_HOST' });
    expect(seedTarget({})).toEqual({ host: 'localhost', database: 'english_learning_app', via: 'DB_HOST' });
    // config/db.ts only takes DATABASE_URL when it is a postgres URL: anything else is ignored there, and here
    expect(seedTarget({ DATABASE_URL: 'mysql://elsewhere/db', DB_HOST: 'localhost' }).host).toBe('localhost');
  });

  it('a DATABASE_URL that cannot be read is never "local"', () => {
    expect(seedTarget({ DATABASE_URL: 'postgresql://%' }).host).toBe('');
    expect(isLocalHost('')).toBe(false);
  });
});

describe('what counts as this machine', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', 'api.localhost'])('%s is local', (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each(['localhost.evil.example', 'evil-localhost', '10.0.0.5', '0.0.0.0', '128.0.0.1', '1127.0.0.1', 'db.neon.tech'])('%s is not', (host) => {
    expect(isLocalHost(host)).toBe(false);
  });

  it('an IPv6 URL host is read without its brackets', () => {
    expect(seedTarget({ DATABASE_URL: 'postgresql://u:p@[::1]:5432/db' }).host).toBe('::1');
    expect(checkSeedSafety([], { DATABASE_URL: 'postgresql://u:p@[::1]:5432/db' }).allowed).toBe(true);
  });
});

describe('checkSeedSafety', () => {
  it('lets a local database through, with nothing to say against it', () => {
    expect(checkSeedSafety([], { DATABASE_URL: LOCAL, NODE_ENV: 'development' })).toMatchObject({ allowed: true, reasons: [], flag: false });
    expect(checkSeedSafety([], {})).toMatchObject({ allowed: true, reasons: [] });
  });

  it('refuses a database that is not on this machine', () => {
    const v = checkSeedSafety([], { DATABASE_URL: NEON, NODE_ENV: 'development' });
    expect(v.allowed).toBe(false);
    expect(v.reasons).toEqual([expect.stringContaining('ep-example-123.ap-southeast-1.aws.neon.tech')]);
  });

  it('refuses NODE_ENV=production even on localhost, and says both reasons when both hold', () => {
    expect(checkSeedSafety([], { DATABASE_URL: LOCAL, NODE_ENV: 'production' })).toMatchObject({ allowed: false, reasons: ['NODE_ENV=production'] });
    expect(checkSeedSafety([], { DATABASE_URL: NEON, NODE_ENV: 'production' }).reasons).toHaveLength(2);
  });

  it(`${WIPE_FLAG} lets either through, and records that it overrode them`, () => {
    const v = checkSeedSafety([WIPE_FLAG], { DATABASE_URL: NEON, NODE_ENV: 'production' });
    expect(v).toMatchObject({ allowed: true, flag: true });
    expect(v.reasons).toHaveLength(2);
  });

  it('only the exact flag counts (a prefix, a typo or the flag as a value does not)', () => {
    for (const argv of [['--i-know-this-wipes'], ['--i-know-this-wipes-table'], ['i-know-this-wipes-tables'], ['--yes'], ['--force']]) {
      expect([argv, checkSeedSafety(argv, { DATABASE_URL: NEON }).allowed]).toEqual([argv, false]);
    }
  });
});

describe('guardSeed: what it prints and whether it lets the seed go on', () => {
  const tables = ['users', 'admin_accounts', 'lessons'];
  const run = (argv: string[], env: NodeJS.ProcessEnv) => {
    const lines: string[] = [];
    const ok = guardSeed(argv, env, tables, (l) => lines.push(l));
    return { ok, text: lines.join('\n') };
  };

  it('always prints the database and the tables it will empty, BEFORE anything else happens (also on a local database)', () => {
    const r = run([], { DATABASE_URL: LOCAL });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('localhost / english_learning_app');
    expect(r.text).toContain('3 bảng');
    expect(r.text).toContain('users, admin_accounts, lessons');
  });

  it('refuses a remote database, prints why and how to override it, and never prints the password', () => {
    const r = run([], { DATABASE_URL: NEON, NODE_ENV: 'development' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('TỪ CHỐI');
    expect(r.text).toContain('neon.tech');
    expect(r.text).toContain(WIPE_FLAG);
    expect(r.text).not.toContain('s3cr3t-pass');
    expect(r.text).not.toContain('neon_user');
  });

  it('with the flag it goes on, and warns', () => {
    const r = run([WIPE_FLAG], { DATABASE_URL: NEON, NODE_ENV: 'production' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('CẢNH BÁO');
    expect(r.text).toContain('NODE_ENV=production');
    expect(r.text).not.toContain('TỪ CHỐI');
  });
});

describe('scripts/seed.ts itself (read as text: the seed is never run by a test)', () => {
  it('imports and calls the guard, and does it before it takes a connection and before any DELETE', () => {
    const guard = SEED_SOURCE.indexOf('guardSeed(process.argv');
    const connect = SEED_SOURCE.indexOf('pool.connect()');
    const del = SEED_SOURCE.indexOf('DELETE FROM');
    expect(SEED_SOURCE).toMatch(/import \{ guardSeed \} from '\.\/seedGuard'/);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(connect);
    expect(connect).toBeLessThan(del);
  });

  it('exits when the guard says no, without ever having connected', () => {
    const after = SEED_SOURCE.slice(SEED_SOURCE.indexOf('guardSeed(process.argv'), SEED_SOURCE.indexOf('pool.connect()'));
    expect(after).toMatch(/process\.exit\(1\)/);
  });

  it('has ONE delete, that goes through the list the guard prints', () => {
    expect(SEED_SOURCE.match(/DELETE FROM/g)).toHaveLength(1);
    expect(SEED_SOURCE).toMatch(/for \(const table of CLEANUP_TABLES\)/);
    expect(SEED_SOURCE).toMatch(/guardSeed\(process\.argv\.slice\(2\), process\.env, CLEANUP_TABLES,/);
    expect(SEED_SOURCE).not.toMatch(/TRUNCATE|DROP TABLE/i);
  });

  it('only runs when it is the program that was started (importing it, as this test could, deletes nothing)', () => {
    expect(SEED_SOURCE).toMatch(/if \(require\.main === module\) void seed\(\)/);
    expect(SEED_SOURCE).not.toMatch(/^seed\(\);/m);
  });

  it('lists tables with no dictionary table among them (the seed must never empty the dictionary)', () => {
    const list = SEED_SOURCE.slice(SEED_SOURCE.indexOf('export const CLEANUP_TABLES'), SEED_SOURCE.indexOf('];', SEED_SOURCE.indexOf('export const CLEANUP_TABLES')));
    const names = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(25);
    for (const protectedTable of ['dictionary_entries', 'entry_senses', 'sense_examples', 'word_forms', 'tags']) expect(names).not.toContain(protectedTable);
  });
});
