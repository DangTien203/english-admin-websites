/**
 * The safety latch (scripts/seedGuard.ts) on the other two scripts that destroy or overwrite data: `npm run db:reset` / `db:fresh`
 * (database/reset.ts) and scripts/seed-mobile-test-users.ts. scripts/seed.ts is covered by seedGuard.test.ts.
 *
 * Nothing here can touch a database:
 *   - the guards are pure functions;
 *   - the order of the lines in the two scripts is checked as TEXT (the scripts are never imported: they would run);
 *   - the end-to-end checks start each script as a child process whose DATABASE_URL names a host that can never resolve
 *     (".invalid", RFC 2606) and whose answer must be a refusal. A refusal comes before any connection, so the output must not contain
 *     a network error; and even if the guard were broken the process could not reach any database.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FIXED_PASSWORD_FLAG, WIPE_FLAG, checkSeedSafety, guardReset, guardTestUsers, guardWipe } from '../../scripts/seedGuard';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const RESET = read('database/reset.ts');
const MOBILE = read('scripts/seed-mobile-test-users.ts');
const PACKAGE = JSON.parse(read('package.json'));

const NEON = 'postgresql://neon_user:s3cr3t-pass@ep-example-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
const LOCAL = 'postgresql://postgres:s3cr3t-pass@localhost:5432/english_learning_app';
const KEPT = ['dictionary_entries', 'entry_senses', 'tags'];
const EMAILS = ['a@example.com', 'b@example.com'];

const collect = (fn: (print: (l: string) => void) => boolean) => {
  const lines: string[] = [];
  const ok = fn((l) => lines.push(l));
  return { ok, text: lines.join('\n') };
};

// ═════════════════════════════════════════════════════════════════════════════
describe('one implementation for every script (guardWipe)', () => {
  it('each script has its own flag: the flag of one does not open the other', () => {
    expect(FIXED_PASSWORD_FLAG).not.toBe(WIPE_FLAG);
    const remote = { DATABASE_URL: NEON };
    expect(checkSeedSafety([WIPE_FLAG], remote, FIXED_PASSWORD_FLAG).allowed).toBe(false);
    expect(checkSeedSafety([FIXED_PASSWORD_FLAG], remote, WIPE_FLAG).allowed).toBe(false);
    expect(checkSeedSafety([FIXED_PASSWORD_FLAG], remote, FIXED_PASSWORD_FLAG).allowed).toBe(true);
    expect(checkSeedSafety([WIPE_FLAG], remote).allowed).toBe(true); // the default flag is the wipe flag
  });

  it('prints the notice first and the verdict last, and is told nothing about the password', () => {
    const r = collect((p) =>
      guardWipe([], { DATABASE_URL: NEON }, { headline: (w) => `HEAD ${w}`, details: ['DETAIL 1', 'DETAIL 2'], flag: '--f', confirm: 'you mean it', example: 'cmd --f' }, p)
    );
    const lines = r.text.split('\n');
    expect(r.ok).toBe(false);
    expect(lines.slice(0, 3)).toEqual([expect.stringContaining('HEAD ep-example-123.ap-southeast-1.aws.neon.tech / neondb'), 'DETAIL 1', 'DETAIL 2']);
    expect(r.text).toContain('Chỉ chạy tiếp khi you mean it: thêm --f vào lệnh (ví dụ: cmd --f).');
    expect(r.text).not.toContain('s3cr3t-pass');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('guardReset (db:reset)', () => {
  const run = (argv: string[], env: NodeJS.ProcessEnv, all = false) => collect((p) => guardReset(argv, env, { all, kept: KEPT }, p));

  it('on a local database it prints the database and what it will drop, then lets it go on', () => {
    const r = run([], { DATABASE_URL: LOCAL });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('localhost / english_learning_app');
    expect(r.text).toContain('DROP TABLE');
    expect(r.text).toContain(`${KEPT.length} bảng nội dung từ điển`);
    expect(r.text).toContain(KEPT.join(', '));
    expect(r.text).toContain('được in trước khi xóa');
  });

  it('says plainly that --all keeps nothing, not even the dictionary', () => {
    const r = run([], { DATABASE_URL: LOCAL }, true);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('XÓA TOÀN BỘ');
    expect(r.text).toContain('KHÔNG giữ lại bảng nào');
    expect(r.text).not.toContain(KEPT.join(', '));
  });

  it.each([[false], [true]])('refuses a database that is not on this machine (--all: %s), with the flag to override it, and never prints the password', (all) => {
    const r = run([], { DATABASE_URL: NEON, NODE_ENV: 'development' }, all);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('TỪ CHỐI');
    expect(r.text).toContain('neon.tech');
    expect(r.text).toContain(`npm run db:reset -- ${WIPE_FLAG}`);
    expect(r.text).not.toContain('s3cr3t-pass');
    expect(r.text).not.toContain('neon_user');
  });

  it('refuses NODE_ENV=production even on localhost', () => {
    const r = run([], { DATABASE_URL: LOCAL, NODE_ENV: 'production' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('NODE_ENV=production');
  });

  it('refuses a DATABASE_URL it cannot read, and a host that only starts with "localhost"', () => {
    expect(run([], { DATABASE_URL: 'postgresql://%' }).ok).toBe(false);
    expect(run([], { DATABASE_URL: 'postgresql://u:p@localhost.evil.example/db' }).ok).toBe(false);
  });

  it(`with ${WIPE_FLAG} it goes on, and warns`, () => {
    const r = run([WIPE_FLAG], { DATABASE_URL: NEON, NODE_ENV: 'production' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('CẢNH BÁO');
    expect(r.text).not.toContain('TỪ CHỐI');
  });

  it('the flag of the mobile test users does not open it', () => {
    expect(run([FIXED_PASSWORD_FLAG], { DATABASE_URL: NEON }).ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('guardTestUsers (seed-mobile-test-users)', () => {
  const run = (argv: string[], env: NodeJS.ProcessEnv) => collect((p) => guardTestUsers(argv, env, EMAILS, p));

  it('on a local database it says what it does to which accounts, then goes on', () => {
    const r = run([], { DATABASE_URL: LOCAL });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('localhost / english_learning_app');
    expect(r.text).toContain(`${EMAILS.length} tài khoản`);
    expect(r.text).toContain('MẬT KHẨU CỐ ĐỊNH');
    for (const e of EMAILS) expect(r.text).toContain(e);
    expect(r.text).toContain('XÓA dữ liệu học');
  });

  it('never prints the fixed password (the guard does not even receive it)', () => {
    expect(run([], { DATABASE_URL: LOCAL }).text).not.toContain('123123');
    expect(run([], { DATABASE_URL: NEON }).text).not.toContain('123123');
  });

  it('refuses a remote database and NODE_ENV=production, and names its own flag', () => {
    for (const env of [{ DATABASE_URL: NEON }, { DATABASE_URL: LOCAL, NODE_ENV: 'production' }]) {
      const r = run([], env);
      expect(r.ok).toBe(false);
      expect(r.text).toContain('TỪ CHỐI');
      expect(r.text).toContain(FIXED_PASSWORD_FLAG);
      expect(r.text).not.toContain('s3cr3t-pass');
    }
  });

  it(`with ${FIXED_PASSWORD_FLAG} it goes on, and warns; ${WIPE_FLAG} is not enough`, () => {
    const ok = run([FIXED_PASSWORD_FLAG], { DATABASE_URL: NEON, NODE_ENV: 'production' });
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain('CẢNH BÁO');
    expect(run([WIPE_FLAG], { DATABASE_URL: NEON }).ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('database/reset.ts (read as text: importing or running it would drop tables)', () => {
  const guard = RESET.indexOf('guardReset(process.argv');
  const connect = RESET.indexOf('pool.connect()');

  it('imports the shared guard instead of writing its own', () => {
    expect(RESET).toMatch(/import \{ guardReset \} from '\.\.\/scripts\/seedGuard'/);
    expect(RESET).not.toMatch(/isLocalHost|seedTarget/);
  });

  it('calls it before it takes a connection and before any DROP', () => {
    const drop = RESET.indexOf('DROP TABLE');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(connect);
    expect(connect).toBeLessThan(drop);
  });

  it('exits with code 1 when the guard says no, without ever having connected (so `db:reset && db:seed` stops)', () => {
    expect(RESET.slice(guard, connect)).toMatch(/process\.exit\(1\)/);
  });

  it('hands the guard the real mode and the real list of kept tables', () => {
    expect(RESET).toMatch(/guardReset\(process\.argv\.slice\(2\), process\.env, \{ all: isFullReset, kept: PROTECTED_TABLES \}/);
    expect(RESET).toMatch(/const isFullReset = process\.argv\.includes\('--all'\)/);
  });

  it('keeps the dictionary tables out of the selective reset, as before', () => {
    const list = RESET.slice(RESET.indexOf('PROTECTED_TABLES: string[]'), RESET.indexOf('];', RESET.indexOf('PROTECTED_TABLES: string[]')));
    const names = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const t of ['dictionary_entries', 'entry_senses', 'sense_examples', 'word_forms', 'tags']) expect(names).toContain(t);
    expect(names).not.toContain('users');
    expect(RESET).toMatch(/tablename != ALL\(\$1\)/);
  });

  it('prints the list of tables it is about to drop, BEFORE dropping them (in both modes)', () => {
    const full = RESET.indexOf('Sẽ xóa ${everyTable.length} bảng');
    const fullDrop = RESET.indexOf('DO $$ DECLARE');
    const selective = RESET.indexOf('Sẽ xóa ${allTables.length} bảng');
    const selectiveDrop = RESET.indexOf('DROP TABLE IF EXISTS "${tablename}"');
    expect(full).toBeGreaterThan(-1);
    expect(full).toBeLessThan(fullDrop);
    expect(selective).toBeGreaterThan(-1);
    expect(selective).toBeLessThan(selectiveDrop);
  });

  it('only runs when it is the program that was started', () => {
    expect(RESET).toMatch(/if \(require\.main === module\) void reset\(\);/);
    expect(RESET).not.toMatch(/^reset\(\);/m);
  });

  it('is still what db:reset and db:fresh run, and db:fresh stops if the reset is refused (&&) before the seed starts', () => {
    expect(PACKAGE.scripts['db:reset']).toBe('tsx database/reset.ts');
    expect(PACKAGE.scripts['db:fresh']).toBe('tsx database/reset.ts && tsx scripts/seed.ts');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('scripts/seed-mobile-test-users.ts (read as text)', () => {
  const main = MOBILE.indexOf('async function main()');
  const guard = MOBILE.indexOf('if (!guardTestUsers(process.argv');
  const connect = MOBILE.indexOf('pool.connect()', main);

  it('imports the shared guard and calls it first thing in main(), before a connection and before any write', () => {
    expect(MOBILE).toMatch(/import \{ guardTestUsers \} from '\.\/seedGuard'/);
    expect(guard).toBeGreaterThan(main);
    expect(guard).toBeLessThan(connect);
    expect(MOBILE.slice(main, guard).replace(/async function main\(\): Promise<void> \{/, '').replace(/\/\/[^\n]*/g, '').trim()).toBe('');
  });

  it('exits with code 1 when the guard says no, without ever having connected', () => {
    expect(MOBILE.slice(guard, connect)).toMatch(/process\.exit\(1\)/);
  });

  it('gives the guard the very e-mails it will overwrite', () => {
    expect(MOBILE).toMatch(/guardTestUsers\(process\.argv\.slice\(2\), process\.env, TEST_USERS\.map\(\(u\) => u\.email\),/);
  });

  it('has no write outside main() that could run on import before the guard (the only top-level call is main itself)', () => {
    const topLevel = MOBILE.split('\n').filter((l) => /^(void |await |main\(|pool\.|client\.)/.test(l.trim()) && !/^\s/.test(l));
    expect(topLevel.map((l) => l.trim())).toEqual(['void main();']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('end to end: the real scripts refuse a database that is not on this machine, before any connection', () => {
  const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  // A host that can never resolve: even a broken guard could not reach a database through it.
  const URL_REMOTE = 'postgresql://nobody:never-printed-pw@db.never-resolves.invalid:5432/never_a_db';
  const URL_LOCAL = 'postgresql://nobody:never-printed-pw@localhost:1/never_a_db';

  const start = (script: string, args: string[], env: Record<string, string>) => {
    const res = spawnSync(process.execPath, [TSX, script, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90_000,
      // DATABASE_URL and NODE_ENV are the test's own (dotenv does not override variables that are already set)
      env: { ...process.env, ...env },
    });
    return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
  };

  const cases: Array<[string, string, string[], string]> = [
    ['database/reset.ts', 'db:reset', [], 'Reset sẽ XÓA'],
    ['database/reset.ts', 'db:reset --all', ['--all'], 'XÓA TOÀN BỘ'],
    ['scripts/seed.ts', 'db:seed', [], 'Seed sẽ XÓA SẠCH'],
    ['scripts/seed-mobile-test-users.ts', 'seed-mobile-test-users', [], 'MẬT KHẨU CỐ ĐỊNH'],
  ];

  it.each(cases)('%s (%s) on a remote host: exit 1, says why, and never got as far as connecting', (script, _name, args, headline) => {
    const r = start(script, args, { DATABASE_URL: URL_REMOTE, NODE_ENV: 'development' });
    expect(r.code).toBe(1);
    expect(r.out).toContain(headline);
    expect(r.out).toContain('TỪ CHỐI');
    expect(r.out).toContain('db.never-resolves.invalid');
    expect(r.out).not.toMatch(/ENOTFOUND|ECONNREFUSED|getaddrinfo|EAI_AGAIN/);
    expect(r.out).not.toContain('never-printed-pw');
  }, 120_000);

  it.each(cases)('%s (%s) with NODE_ENV=production on localhost: exit 1, never connected', (script, _name, args) => {
    const r = start(script, args, { DATABASE_URL: URL_LOCAL, NODE_ENV: 'production' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('TỪ CHỐI');
    expect(r.out).toContain('NODE_ENV=production');
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo|EAI_AGAIN/);
    expect(r.out).not.toContain('never-printed-pw');
  }, 120_000);
});
