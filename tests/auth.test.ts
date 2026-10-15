import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';
import pool from '../config/db';

const TEST_EMAIL_PREFIX = `phase1test-${Date.now()}-`;
let userCounter = 0;
const nextEmail = () => `${TEST_EMAIL_PREFIX}${userCounter++}@example.com`;

const register = (email: string, overrides: Record<string, any> = {}) =>
  request(app)
    .post('/api/v1/auth/register')
    .send({
      email,
      password: 'password123',
      full_name: 'Test User',
      ...overrides,
    });

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${TEST_EMAIL_PREFIX}%`]);
  await pool.end();
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/auth/register', () => {
  it('happy path → 201 with access_token + refresh_token + user', async () => {
    const email = nextEmail();
    const res = await register(email);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.access_token).toEqual(expect.any(String));
    expect(res.body.data.refresh_token).toEqual(expect.any(String));
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.user.id).toEqual(expect.any(String));
    // password_hash never leaks
    expect(res.body.data.user).not.toHaveProperty('password_hash');
  });

  it('duplicate email → 409 DUPLICATE', async () => {
    const email = nextEmail();
    const first = await register(email);
    expect(first.status).toBe(201);

    const second = await register(email);
    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);
    expect(second.body.error.code).toBe('DUPLICATE');
  });

  it('invalid email format → 400 VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'not-an-email',
      password: 'password123',
      full_name: 'Test User',
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/auth/login', () => {
  it('correct credentials → 200 + tokens', async () => {
    const email = nextEmail();
    await register(email);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.access_token).toEqual(expect.any(String));
    expect(res.body.data.refresh_token).toEqual(expect.any(String));
    expect(res.body.data.user.email).toBe(email);
  });

  it('wrong password → 401 INVALID_CREDENTIALS', async () => {
    const email = nextEmail();
    await register(email);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/auth/me', () => {
  it('with valid token → user data', async () => {
    const email = nextEmail();
    const reg = await register(email);
    const { access_token } = reg.body.data;

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(email);
  });

  it('without token → 401 NO_TOKEN', async () => {
    const res = await request(app).get('/api/v1/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NO_TOKEN');
  });

  it('with expired token → 401 TOKEN_EXPIRED', async () => {
    const expired = jwt.sign(
      { userId: '00000000-0000-0000-0000-000000000000', email: 'x@x.com' },
      process.env.JWT_SECRET!,
      { expiresIn: -60 }
    );

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/auth/refresh', () => {
  it('happy path → new access + refresh (rotated)', async () => {
    const email = nextEmail();
    const reg = await register(email);
    const oldRefresh = reg.body.data.refresh_token;

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: oldRefresh });

    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toEqual(expect.any(String));
    expect(res.body.data.refresh_token).toEqual(expect.any(String));
    // Refresh token must have rotated
    expect(res.body.data.refresh_token).not.toBe(oldRefresh);
    expect(res.body.data.user.email).toBe(email);
  });

  it('with revoked/rotated token → 401 INVALID_REFRESH_TOKEN', async () => {
    const email = nextEmail();
    const reg = await register(email);
    const oldRefresh = reg.body.data.refresh_token;

    // First rotation succeeds
    const first = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: oldRefresh });
    expect(first.status).toBe(200);

    // Reusing the old refresh token must fail (it's been revoked by rotation)
    const second = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: oldRefresh });

    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/auth/logout & /logout-all', () => {
  it('logout revokes the supplied refresh token', async () => {
    const email = nextEmail();
    const reg = await register(email);
    const { access_token, refresh_token } = reg.body.data;

    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ refresh_token });
    expect(logoutRes.status).toBe(204);

    // Using the revoked refresh token must fail
    const refreshRes = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token });
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('logout-all revokes every refresh token for the user', async () => {
    const email = nextEmail();
    // First session via register
    const reg = await register(email);
    const { access_token, refresh_token: rt1 } = reg.body.data;

    // Second session via login (simulates a second device)
    const login2 = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'password123' });
    expect(login2.status).toBe(200);
    const rt2 = login2.body.data.refresh_token;

    const res = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${access_token}`);
    expect(res.status).toBe(204);

    // Both refresh tokens must now fail
    const r1 = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: rt1 });
    expect(r1.status).toBe(401);
    expect(r1.body.error.code).toBe('INVALID_REFRESH_TOKEN');

    const r2 = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: rt2 });
    expect(r2.status).toBe(401);
    expect(r2.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});
