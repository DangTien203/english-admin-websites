/**
 * `npm run admin:create` (scripts/admin/create-admin.ts): one super_admin, a random password printed once or one read from the
 * environment, nothing deleted, a duplicate refused. Real PostgreSQL (the dev database): every account made here is named
 * "p8c-<run>-…@example.com" and removed at the end.
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../../app';
import pool from '../../config/db';
import {
  AdminExistsError,
  AdminInputError,
  BCRYPT_ROUNDS,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  cleanName,
  createAdmin,
  generatePassword,
  normalizeEmail,
  run,
  validateEmail,
  validateName,
  validatePassword,
} from '../../scripts/admin/create-admin';

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const email = (tag: string) => `p8c-${RUN}-${tag}@example.com`;
const GOOD = 'a-Good-Password-123';

// The database is a serverless one that may be asleep: the first connection of a run can be cut while TLS starts. Wake it first.
beforeAll(async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}, 30_000);

afterAll(async () => {
  await pool.query(`DELETE FROM admin_accounts WHERE email LIKE $1`, [`p8c-${RUN}-%`]);
  await pool.end();
});

const row = async (e: string) => (await pool.query(`SELECT id, email, full_name, role, status, password_hash FROM admin_accounts WHERE lower(email) = lower($1)`, [e])).rows[0];
const count = async () => (await pool.query(`SELECT count(*)::int AS n FROM admin_accounts`)).rows[0].n as number;

describe('the checks on what is typed', () => {
  it('e-mail: trimmed and lower-cased like the login form, and it has to look like one', () => {
    expect(normalizeEmail('  Admin@Example.COM ')).toBe('admin@example.com');
    expect(validateEmail('a@b.co')).toBeNull();
    for (const bad of ['', 'no-at-sign', 'a@b', 'a b@c.de', '<x>@c.de', `${'a'.repeat(251)}@c.de`]) expect(validateEmail(bad)).not.toBeNull();
  });

  it('name: white space collapsed, 1 to 100 characters, no control characters or angle brackets', () => {
    expect(cleanName('  Nguyễn   Văn  A ')).toBe('Nguyễn Văn A');
    expect(validateName('Nguyễn Văn A')).toBeNull();
    for (const bad of ['', 'x'.repeat(101), 'a\u0000b', '<b>x</b>']) expect(validateName(bad)).not.toBeNull();
  });

  it(`password: at least ${MIN_PASSWORD_LENGTH} characters, at most ${MAX_PASSWORD_BYTES} bytes (bcrypt reads no more), no space at the ends`, () => {
    expect(validatePassword(GOOD)).toBeNull();
    expect(validatePassword('short')).toMatch(/ít nhất 12/);
    expect(validatePassword('x'.repeat(MAX_PASSWORD_BYTES + 1))).toMatch(/72 byte/);
    expect(validatePassword('ế'.repeat(30))).toMatch(/72 byte/); // 3 bytes each
    expect(validatePassword(` ${GOOD}`)).toMatch(/khoảng trắng/);
  });

  it('a generated password is long, URL-safe and different every time', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a).not.toBe(b);
    expect(validatePassword(a)).toBeNull();
  });
});

describe('createAdmin', () => {
  it('inserts ONE super_admin, active, with the password as a bcrypt hash (never in clear), and nothing else changes', async () => {
    const before = await count();
    const made = await createAdmin(pool, { email: email('one'), name: '  Người   Thử ', password: GOOD });
    expect(made).toMatchObject({ email: email('one'), name: 'Người Thử', role: 'super_admin' });
    expect(await count()).toBe(before + 1);

    const stored = await row(email('one'));
    expect(stored).toMatchObject({ id: made.id, full_name: 'Người Thử', role: 'super_admin', status: 'active' });
    expect(stored.password_hash).not.toContain(GOOD);
    expect(stored.password_hash.startsWith(`$2a$${BCRYPT_ROUNDS}$`)).toBe(true);
    expect(await bcrypt.compare(GOOD, stored.password_hash)).toBe(true);
  });

  it('stores the e-mail in lower case, as the login form looks it up', async () => {
    await createAdmin(pool, { email: `  P8C-${RUN}-UPPER@Example.com `, name: 'Hoa Thường', password: GOOD });
    expect((await row(email('upper'))).email).toBe(email('upper'));
  });

  it('refuses an e-mail that is already an admin (also in another case), and changes nothing of the existing account', async () => {
    const first = await createAdmin(pool, { email: email('dup'), name: 'Bản đầu', password: GOOD });
    const hashBefore = (await row(email('dup'))).password_hash;
    const before = await count();

    await expect(createAdmin(pool, { email: email('dup'), name: 'Bản hai', password: 'another-Pass-9876' })).rejects.toBeInstanceOf(AdminExistsError);
    await expect(createAdmin(pool, { email: email('dup').toUpperCase(), name: 'Bản ba', password: 'another-Pass-9876' })).rejects.toBeInstanceOf(AdminExistsError);

    expect(await count()).toBe(before);
    expect(await row(email('dup'))).toMatchObject({ id: first.id, full_name: 'Bản đầu', password_hash: hashBefore });
  });

  it('is not fooled by a race: when the unique index refuses the insert, that is the same answer', async () => {
    const racy = {
      query: async (sql: string) => {
        if (sql.startsWith('SELECT')) return { rows: [] }; // "nobody has it yet"…
        throw Object.assign(new Error('duplicate key'), { code: '23505' }); // …and then somebody did
      },
    };
    await expect(createAdmin(racy, { email: email('race'), name: 'Đua', password: GOOD })).rejects.toBeInstanceOf(AdminExistsError);
  });

  it('refuses a bad e-mail, name or password before it touches the database', async () => {
    const spy = { query: jest.fn() };
    for (const input of [
      { email: 'nope', name: 'Tên', password: GOOD },
      { email: email('bad'), name: '', password: GOOD },
      { email: email('bad'), name: 'Tên', password: 'short' },
    ]) {
      await expect(createAdmin(spy, input)).rejects.toBeInstanceOf(AdminInputError);
    }
    expect(spy.query).not.toHaveBeenCalled();
  });

  it('can log in to the admin pages with the password it was given', async () => {
    await createAdmin(pool, { email: email('login'), name: 'Đăng Nhập', password: GOOD });
    const agent = request.agent(app);
    const res = await agent.post('/auth/login').type('form').send({ email: email('login'), password: GOOD });
    expect([res.status, res.headers.location]).toEqual([302, '/dashboard']);
    const wrong = await request(app).post('/auth/login').type('form').send({ email: email('login'), password: `${GOOD}x` });
    expect(wrong.headers.location).toBe('/auth/login');
  });
});

describe('the command line', () => {
  const harness = (env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { db: pool, env, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it('with no password in the environment it generates one and prints it exactly once, on its own line', async () => {
    const h = harness();
    const code = await run(['--email', email('cli1'), '--name', 'Dòng Lệnh'], h.deps);
    expect(code).toBe(0);
    const printed = h.out.filter((l) => /^[A-Za-z0-9_-]{24}$/.test(l));
    expect(printed).toHaveLength(1);
    expect(h.out.join('\n').split(printed[0]).length - 1).toBe(1); // appears once in everything it said
    expect(h.err).toEqual([]);
    expect(await bcrypt.compare(printed[0], (await row(email('cli1'))).password_hash)).toBe(true);
  });

  it('with ADMIN_PASSWORD it uses that and never prints it', async () => {
    const h = harness({ ADMIN_PASSWORD: GOOD });
    const code = await run(['--email', email('cli2'), '--name', 'Từ Môi Trường'], h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).not.toContain(GOOD);
    expect(h.out.join('\n')).toContain('ADMIN_PASSWORD');
    expect(await bcrypt.compare(GOOD, (await row(email('cli2'))).password_hash)).toBe(true);
  });

  it('refuses an existing e-mail with exit code 1, prints no password, and adds nothing', async () => {
    await createAdmin(pool, { email: email('cli3'), name: 'Có Rồi', password: GOOD });
    const before = await count();
    const h = harness();
    const code = await run(['--email', email('cli3'), '--name', 'Lần Hai'], h.deps);
    expect(code).toBe(1);
    expect(h.err.join('\n')).toMatch(/Từ chối.*Không đổi gì/);
    expect(h.out).toEqual([]);
    expect(await count()).toBe(before);
  });

  it('an ADMIN_PASSWORD that is too short is refused (exit 2) without echoing it', async () => {
    const h = harness({ ADMIN_PASSWORD: 'hunter2' });
    const code = await run(['--email', email('cli4'), '--name', 'Ngắn'], h.deps);
    expect(code).toBe(2);
    expect(`${h.out.join('\n')}${h.err.join('\n')}`).not.toContain('hunter2');
    expect(await row(email('cli4'))).toBeUndefined();
  });

  it('wrong usage exits 2 and adds nothing: no e-mail, no name, a value missing, a password on the command line', async () => {
    const before = await count();
    for (const argv of [[], ['--email', email('cli5')], ['--name', 'Chỉ tên'], ['--email', '--name', 'x'], ['--email', email('cli5'), '--name', 'Tên', '--password', GOOD]]) {
      const h = harness();
      expect([JSON.stringify(argv), await run(argv, h.deps)]).toEqual([JSON.stringify(argv), 2]);
      expect(h.out).toEqual([]);
      expect(h.err.length).toBeGreaterThan(0);
      expect(h.err.join('\n')).not.toContain(GOOD);
    }
    expect(await count()).toBe(before);
  });

  it('never issues anything but a SELECT and one INSERT (no DELETE, UPDATE, TRUNCATE, DROP)', async () => {
    const seen: string[] = [];
    const recording = { query: (sql: string, params?: any[]) => (seen.push(sql.trim().split(/\s+/)[0].toUpperCase()), pool.query(sql, params)) };
    const h = harness();
    expect(await run(['--email', email('cli6'), '--name', 'Chỉ Thêm'], { ...h.deps, db: recording })).toBe(0);
    expect(seen).toEqual(['SELECT', 'INSERT']);
  });
});
