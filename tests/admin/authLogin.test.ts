/**
 * Sign-in and sign-up of the admin pages (POST /auth/login, POST /auth/register).
 *
 * Bug this covers: sign-up stored the e-mail trimmed and in lower case, but sign-in looked it up exactly as typed, so an account made as
 * "Name@Example.com" (or typed with a space) could never sign in: "Email hoặc mật khẩu không đúng" with the right password.
 *
 * Real Express app and the dev database (like every other suite); everything created is named "auth-<run>-…@example.com" and removed at
 * the end. No network.
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../../app';
import pool from '../../config/db';

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const email = (tag: string): string => `auth-${RUN}-${tag}@example.com`;
const PASSWORD = 'auth-test-password';
const GENERIC = 'Email hoặc mật khẩu không đúng';

async function createAdmin(tag: string, status = 'active'): Promise<string> {
  const address = email(tag);
  await pool.query(`INSERT INTO admin_accounts (email, password_hash, full_name, role, status) VALUES ($1, $2, $3, 'moderator', $4)`, [
    address,
    bcrypt.hashSync(PASSWORD, 4),
    `Auth ${tag}`,
    status,
  ]);
  return address;
}

const login = (agent: request.Agent, address: string, password = PASSWORD) => agent.post('/auth/login').type('form').send({ email: address, password });

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(async () => {
  await pool.query(`DELETE FROM admin_accounts WHERE email LIKE $1`, [`auth-${RUN}-%`]);
  jest.restoreAllMocks();
});

describe('POST /auth/login', () => {
  let plain: string;
  beforeAll(async () => {
    plain = await createAdmin('plain');
  });

  it('signs in with the e-mail as stored', async () => {
    const res = await login(request.agent(app), plain);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });

  it.each([
    ['capital letters', (s: string) => s.toUpperCase()],
    ['only the first letter capital', (s: string) => s[0].toUpperCase() + s.slice(1)],
    ['spaces around it', (s: string) => `  ${s}  `],
    ['both', (s: string) => ` ${s.toUpperCase()}\t`],
  ])('signs in when the e-mail is typed with %s', async (_name, change) => {
    const agent = request.agent(app);
    const res = await login(agent, change(plain));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    expect((await agent.get('/dashboard')).status).toBe(200);
  });

  it('a wrong password goes back to the form with ONE generic message, the e-mail kept and the password not', async () => {
    const agent = request.agent(app);
    const res = await login(agent, plain.toUpperCase(), 'not-the-password');
    expect(res.headers.location).toBe('/auth/login');

    const page = await agent.get('/auth/login');
    expect(page.text).toContain(GENERIC);
    expect(page.text).toContain(`value="${plain}"`); // normalised, given back
    expect(page.text).not.toContain('not-the-password');
    expect((await agent.get('/dashboard')).headers.location).toBe('/auth/login'); // still signed out
  });

  it('an unknown e-mail gets the very same message as a wrong password (no account enumeration)', async () => {
    const wrongPassword = request.agent(app);
    await login(wrongPassword, plain, 'nope-nope');
    const unknown = request.agent(app);
    await login(unknown, email('nobody-here'), 'nope-nope');

    const alertOf = (html: string) => /auth-alert-error[^>]*>[\s\S]*?<span>([^<]*)<\/span>/.exec(html)?.[1];
    const a = alertOf((await wrongPassword.get('/auth/login')).text);
    const b = alertOf((await unknown.get('/auth/login')).text);
    expect(a).toBe(GENERIC);
    expect(b).toBe(GENERIC);
  });

  it('asks for both fields when one is empty', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/auth/login').type('form').send({ email: plain, password: '' });
    expect(res.headers.location).toBe('/auth/login');
    expect((await agent.get('/auth/login')).text).toContain('Vui lòng nhập email và mật khẩu');
  });

  it('survives a request with no body at all', async () => {
    const res = await request(app).post('/auth/login');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  it('a disabled account is told so only with the right password', async () => {
    const disabled = await createAdmin('disabled', 'disabled');

    const withPassword = request.agent(app);
    await login(withPassword, disabled);
    expect((await withPassword.get('/auth/login')).text).toContain('Tài khoản đã bị vô hiệu hóa');

    const withoutPassword = request.agent(app);
    await login(withoutPassword, disabled, 'wrong-password');
    const page = (await withoutPassword.get('/auth/login')).text;
    expect(page).toContain(GENERIC);
    expect(page).not.toContain('vô hiệu hóa');
  });
});

describe('POST /auth/register, then sign in', () => {
  const typed = `Auth-${RUN}-Reg@Example.COM`; // what the person types, capitals and all

  const form = (overrides: Record<string, string> = {}) => ({
    full_name: 'Người Dùng Thử',
    email: typed,
    password: PASSWORD,
    password_confirm: PASSWORD,
    role: 'moderator',
    ...overrides,
  });

  it('stores the e-mail in lower case, and the same text typed again signs in (the reported bug)', async () => {
    const agent = request.agent(app);
    const created = await agent.post('/auth/register').type('form').send(form());
    expect(created.status).toBe(302);
    expect(created.headers.location).toBe('/auth/login');

    const { rows } = await pool.query(`SELECT email, role FROM admin_accounts WHERE LOWER(email) = LOWER($1)`, [typed]);
    expect(rows).toEqual([{ email: typed.toLowerCase(), role: 'moderator' }]);

    // the login page greets the new account: success message and the e-mail already filled in
    const page = await agent.get('/auth/login');
    expect(page.text).toContain('Tạo tài khoản thành công');
    expect(page.text).toContain(`value="${typed.toLowerCase()}"`);

    const signedIn = await login(request.agent(app), typed);
    expect(signedIn.headers.location).toBe('/dashboard');
  });

  it('refuses the same e-mail in another letter case, and gives the form back filled in (not the passwords)', async () => {
    const agent = request.agent(app);
    const again = await agent.post('/auth/register').type('form').send(form({ email: typed.toUpperCase(), full_name: 'Tên Thử Lại' }));
    expect(again.headers.location).toBe('/auth/register');

    const page = await agent.get('/auth/register');
    expect(page.text).toContain('Email đã được sử dụng');
    expect(page.text).toContain('value="Tên Thử Lại"');
    expect(page.text).toContain(`value="${typed.toLowerCase()}"`); // given back in its normal form
    expect(page.text).not.toContain(PASSWORD);
    const { rows } = await pool.query(`SELECT 1 FROM admin_accounts WHERE LOWER(email) = LOWER($1)`, [typed]);
    expect(rows).toHaveLength(1);
  });

  it.each([
    ['passwords that differ', { password_confirm: 'something-else' }, 'Xác nhận mật khẩu không khớp'],
    ['a password under 6 characters', { password: '12345', password_confirm: '12345' }, 'Mật khẩu phải có ít nhất 6 ký tự'],
    ['an address that is not an e-mail', { email: 'not-an-email' }, 'Email không hợp lệ'],
    ['a one-letter name', { full_name: 'A' }, 'Họ tên phải có ít nhất 2 ký tự'],
  ])('says what is wrong with %s and keeps the rest of the form', async (_name, overrides, message) => {
    const agent = request.agent(app);
    const res = await agent.post('/auth/register').type('form').send(form({ email: email('invalid'), ...overrides }));
    expect(res.headers.location).toBe('/auth/register');
    const page = await agent.get('/auth/register');
    expect(page.text).toContain(message);
    expect(page.text).not.toContain(PASSWORD);
  });

  it('does not let a visitor pick super_admin', async () => {
    await request(app).post('/auth/register').type('form').send(form({ email: email('wannabe'), role: 'super_admin' }));
    const { rows } = await pool.query(`SELECT role FROM admin_accounts WHERE email = $1`, [email('wannabe')]);
    expect(rows[0].role).toBe('content_editor');
  });
});

describe('the pages', () => {
  it('the sign-in page uses the dedicated layout and helps the browser (autocomplete, no auto-capitalisation, show password)', async () => {
    const res = await request(app).get('/auth/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('auth-shell');
    expect(res.text).toContain('/css/auth.css');
    expect(res.text).toContain('/js/auth.js');
    expect(res.text).toMatch(/name="email"[^>]*autocomplete="username"/);
    expect(res.text).toMatch(/name="email"[^>]*autocapitalize="none"/);
    expect(res.text).toMatch(/name="password"[^>]*autocomplete="current-password"/);
    expect(res.text).toContain('data-toggle-password="password"');
    expect(res.text).toContain('action="/auth/login"');
    expect(res.text).not.toContain('id="sidebar"'); // no admin chrome
  });

  it('the sign-up page asks for the password twice and offers super_admin only to a signed-in super admin', async () => {
    const visitor = await request(app).get('/auth/register');
    expect(visitor.status).toBe(200);
    expect(visitor.text).toContain('name="password_confirm"');
    expect(visitor.text).not.toContain('value="super_admin"');
  });

  it('the static files the pages need are served', async () => {
    expect((await request(app).get('/css/auth.css')).status).toBe(200);
    expect((await request(app).get('/js/auth.js')).status).toBe(200);
  });

  it('a signed-in admin is sent from the sign-in page to the dashboard', async () => {
    const address = await createAdmin('already');
    const agent = request.agent(app);
    await login(agent, address);
    const res = await agent.get('/auth/login');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });
});
