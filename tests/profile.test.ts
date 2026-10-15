import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TEST_EMAIL_PREFIX = `phase2test-${Date.now()}-`;
let userCounter = 0;
const nextEmail = () => `${TEST_EMAIL_PREFIX}${userCounter++}@example.com`;

const registerUser = async () => {
  const email = nextEmail();
  const reg = await request(app).post('/api/v1/auth/register').send({
    email,
    password: 'password123',
    full_name: 'Test User',
  });
  if (reg.status !== 201) {
    throw new Error(`Setup failed: register returned ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  return { email, ...reg.body.data };
};

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${TEST_EMAIL_PREFIX}%`]);
  await pool.end();
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/profile/me', () => {
  it('unauthenticated → 401 NO_TOKEN', async () => {
    const res = await request(app).get('/api/v1/profile/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NO_TOKEN');
  });

  it('authenticated → user data với computed fields', async () => {
    const { access_token, email } = await registerUser();
    const res = await request(app)
      .get('/api/v1/profile/me')
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe(email);
    expect(res.body.data).toHaveProperty('total_words_saved');
    expect(res.body.data).toHaveProperty('days_active');
    expect(res.body.data).not.toHaveProperty('password_hash');
  });
});

// ════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/profile/me', () => {
  it('valid data → 200 + updated profile', async () => {
    const { access_token } = await registerUser();
    const res = await request(app)
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ full_name: 'Updated Name', level: 'intermediate' });

    expect(res.status).toBe(200);
    expect(res.body.data.full_name).toBe('Updated Name');
    expect(res.body.data.level).toBe('intermediate');
  });

  it('invalid level → 400 VALIDATION_ERROR', async () => {
    const { access_token } = await registerUser();
    const res = await request(app)
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ level: 'wizard' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/profile/change-password', () => {
  it('wrong current password → 401 INVALID_CURRENT_PASSWORD', async () => {
    const { access_token } = await registerUser();
    const res = await request(app)
      .post('/api/v1/profile/change-password')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ currentPassword: 'wrongpass', newPassword: 'newsecret' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
  });

  it('correct current → 200, login với newPassword thành công', async () => {
    const { access_token, email } = await registerUser();
    const changeRes = await request(app)
      .post('/api/v1/profile/change-password')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ currentPassword: 'password123', newPassword: 'newsecret' });
    expect(changeRes.status).toBe(200);

    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'newsecret' });
    expect(loginRes.status).toBe(200);
  });

  it('change-password revokes tất cả refresh tokens cũ', async () => {
    const { access_token, refresh_token } = await registerUser();
    const changeRes = await request(app)
      .post('/api/v1/profile/change-password')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ currentPassword: 'password123', newPassword: 'newsecret' });
    expect(changeRes.status).toBe(200);

    const refreshRes = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token });
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/profile/avatar', () => {
  it('file > 5MB → 413 FILE_TOO_LARGE', async () => {
    const { access_token } = await registerUser();
    const bigBuffer = Buffer.alloc(6 * 1024 * 1024, 0);
    const res = await request(app)
      .post('/api/v1/profile/avatar')
      .set('Authorization', `Bearer ${access_token}`)
      .attach('avatar', bigBuffer, { filename: 'big.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('file không phải ảnh (txt) → 400 INVALID_FILE_TYPE', async () => {
    const { access_token } = await registerUser();
    const txtBuffer = Buffer.from('hello world');
    const res = await request(app)
      .post('/api/v1/profile/avatar')
      .set('Authorization', `Bearer ${access_token}`)
      .attach('avatar', txtBuffer, { filename: 'hello.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });
});
