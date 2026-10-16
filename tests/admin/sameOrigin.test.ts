/**
 * CSRF defence of the session-cookie surface: SameSite on the session cookie, and middlewares/sameOrigin.ts refusing a
 * state-changing request whose Origin (or Referer) is another site. Real app, real PostgreSQL (the dev database, like every other
 * suite), real login through POST /auth/login. "Changes nothing" is checked in the database.
 *
 * Every request carries Host: admin.test so that "same origin" is a fixed value instead of the ephemeral 127.0.0.1:<port>.
 *
 * Fixtures: one admin account "csrf-<run>-admin@example.com" and one mobile user "csrf-<run>-user@example.com", removed in afterAll.
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../../app';
import pool from '../../config/db';

const RUN = Math.random().toString(36).slice(2, 8);
const ADMIN_EMAIL = `csrf-${RUN}-admin@example.com`;
const USER_EMAIL = `csrf-${RUN}-user@example.com`;
const PASSWORD = 'csrf-test-password';
const HOST = 'admin.test';
const OWN_ORIGIN = `http://${HOST}`;
const REFUSED = 'Request refused';

const agent = request.agent(app);
let userId: string;

const login = (a: ReturnType<typeof request.agent>) =>
  a.post('/auth/login').set('Host', HOST).type('form').send({ email: ADMIN_EMAIL, password: PASSWORD });

const userStatus = async (): Promise<string> =>
  (await pool.query('SELECT status FROM users WHERE id = $1', [userId])).rows[0].status;

/** POST /users/:id/toggle-status (ban) as the logged-in admin, with the given extra headers. */
const ban = (headers: Record<string, string> = {}) =>
  agent.post(`/users/${userId}/toggle-status`).set('Host', HOST).set(headers).type('form').send({ new_status: 'banned' });

beforeAll(async () => {
  await pool.query(
    `INSERT INTO admin_accounts (email, password_hash, full_name, role) VALUES ($1, $2, 'CSRF admin', 'super_admin')`,
    [ADMIN_EMAIL, bcrypt.hashSync(PASSWORD, 4)]
  );
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name) VALUES ($1, 'x', 'CSRF reader') RETURNING id`,
    [USER_EMAIL]
  );
  userId = rows[0].id;
  const res = await login(agent);
  if (res.status !== 302 || res.headers.location !== '/dashboard') {
    throw new Error(`login failed: ${res.status} ${res.headers.location}`);
  }
});

beforeEach(async () => {
  await pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [userId]);
});

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`csrf-${RUN}-%`]);
  await pool.query('DELETE FROM admin_accounts WHERE email LIKE $1', [`csrf-${RUN}-%`]);
  await pool.end();
});

describe('session cookie', () => {
  it('is SameSite=Lax and, outside production, not Secure', async () => {
    const res = await login(request.agent(app));
    const cookie = [res.headers['set-cookie']].flat().find((c) => c?.startsWith('connect.sid='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it('trusts the first proxy hop (Railway): without it a Secure cookie would never be set behind the proxy', () => {
    expect(app.get('trust proxy')).toBe(1);
  });

  it('is Secure in production once the proxy says the request was HTTPS', async () => {
    // Booting the app as production prints a MemoryStore warning and a rate-limit key warning; neither is under test.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const env = process.env.NODE_ENV;
    let prodApp: typeof app | undefined;
    process.env.NODE_ENV = 'production';
    try {
      jest.isolateModules(() => {
        prodApp = require('../../app').default;
      });
    } finally {
      process.env.NODE_ENV = env;
      jest.restoreAllMocks();
    }
    const res = await request(prodApp!).get('/auth/login').set('Host', HOST).set('X-Forwarded-Proto', 'https');
    const cookie = [res.headers['set-cookie']].flat().find((c) => c?.startsWith('connect.sid='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
  });
});

describe('admin page POST (/users/:id/toggle-status)', () => {
  it.each([
    ['same-site Origin', { Origin: OWN_ORIGIN }],
    ['same-site Origin over https (TLS ends at the proxy)', { Origin: `https://${HOST}` }],
    ['same-site Referer and no Origin', { Referer: `${OWN_ORIGIN}/users` }],
    ['same-site Origin and a foreign Referer (Origin wins)', { Origin: OWN_ORIGIN, Referer: 'https://evil.example/page' }],
    ['neither Origin nor Referer (curl, supertest)', {}],
  ])('passes with %s', async (_name, headers) => {
    const res = await ban(headers);
    expect(res.status).toBe(302);
    expect(await userStatus()).toBe('banned');
  });

  it.each([
    ['another site', { Origin: 'http://evil.example' }],
    ['another site over https', { Origin: 'https://evil.example' }],
    ['the same host on another port', { Origin: 'http://admin.test:8080' }],
    ['a look-alike host', { Origin: 'http://admin.test.evil.example' }],
    ['Origin: null (sandboxed frame, cross-site redirect)', { Origin: 'null' }],
    ['an unreadable Origin', { Origin: 'not a url' }],
    ['another site in Referer when there is no Origin', { Referer: 'https://evil.example/form' }],
    ['another site in Origin even with a same-site Referer', { Origin: 'http://evil.example', Referer: `${OWN_ORIGIN}/users` }],
  ])('refuses %s: flash + redirect, nothing changes', async (_name, headers) => {
    const res = await ban(headers);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    expect(await userStatus()).toBe('active');

    // The flash message is waiting on the next page.
    const next = await agent.get('/dashboard').set('Host', HOST);
    expect(next.status).toBe(200);
    expect(next.text).toContain(REFUSED);
  });

  it.each(['put', 'patch', 'delete'] as const)('refuses a cross-site %s on any guarded path', async (method) => {
    const res = await agent[method](`/dictionary/${userId}`).set('Host', HOST).set('Origin', 'http://evil.example');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });

  it('does not look at safe methods: a cross-site GET still renders', async () => {
    const res = await agent.get('/dashboard').set('Host', HOST).set('Origin', 'http://evil.example');
    expect(res.status).toBe(200);
  });

  it('refuses a cross-site login (login CSRF) and leaves the visitor logged out', async () => {
    const visitor = request.agent(app);
    const res = await visitor.post('/auth/login').set('Host', HOST).set('Origin', 'http://evil.example').type('form')
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');

    const dashboard = await visitor.get('/dashboard').set('Host', HOST);
    expect(dashboard.status).toBe(302);
    expect(dashboard.headers.location).toBe('/auth/login');
  });
});

// A router that is mounted outside /api/v1 and has a write route authenticates with the session cookie, so it must sit behind the guard.
// This walks the real route table, so a mount added to app.ts but forgotten in the guard's prefix list fails here.
describe('guard coverage', () => {
  const isWrite = (route: any): boolean =>
    Boolean(route.methods._all) || Object.keys(route.methods).some((m) => !['get', 'head', 'options'].includes(m));
  const hasWrite = (stack: any[]): boolean =>
    stack.some((layer) => (layer.route ? isWrite(layer.route) : layer.name === 'router' && hasWrite(layer.handle.stack)));
  /** "/users" out of the layer's regexp /^\/users\/?(?=\/|$)/i */
  const mountOf = (layer: any): string => {
    const m = /^\^(.+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
    if (!m) throw new Error(`cannot read the mount path of a router from ${layer.regexp.source}`);
    return m[1].replace(/\\\//g, '/');
  };
  const writeMounts = (): string[] =>
    ((app as any)._router.stack as any[])
      .filter((layer) => layer.name === 'router' && hasWrite(layer.handle.stack))
      .map(mountOf);

  it('every router with a write route outside /api/v1 refuses a cross-site write', async () => {
    const mounts = writeMounts().filter((m) => !m.startsWith('/api/v1'));
    expect(mounts).toEqual(expect.arrayContaining(['/auth', '/users', '/dictionary', '/subscriptions']));
    for (const mount of mounts) {
      const res = await agent.post(`${mount}/__csrf_probe__`).set('Host', HOST).set('Origin', 'http://evil.example');
      // 302 (flash + redirect) for a page, 403 for /lookup/api; without the guard the probe would fall through to the 404 page
      expect([mount, [302, 403].includes(res.status)]).toEqual([mount, true]);
    }
  });

  it('the /api/v1 routers (JWT Bearer) are the only write routers left unguarded', () => {
    const unguarded = writeMounts().filter((m) => m.startsWith('/api/v1'));
    expect(unguarded.length).toBeGreaterThan(0);
  });
});

describe('mobile API (/api/v1, JWT Bearer)', () => {
  const mobileEmail = `csrf-${RUN}-mobile@example.com`;

  it('is not subject to the Origin check', async () => {
    const register = await request(app)
      .post('/api/v1/auth/register')
      .set('Host', HOST)
      .set('Origin', 'http://evil.example')
      .send({ email: mobileEmail, password: 'password123', full_name: 'CSRF mobile' });
    expect(register.status).toBe(201);
    expect(register.body.success).toBe(true);

    const token = `Bearer ${register.body.data.access_token}`;
    const foreign = await request(app)
      .post('/api/v1/notifications/read-all')
      .set('Host', HOST)
      .set('Origin', 'http://evil.example')
      .set('Authorization', token);
    expect(foreign.status).toBe(204);

    // the usual mobile request: no Origin, no Referer
    const plain = await request(app).post('/api/v1/notifications/read-all').set('Host', HOST).set('Authorization', token);
    expect(plain.status).toBe(204);
  });
});
