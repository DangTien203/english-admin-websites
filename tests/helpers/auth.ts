import request from 'supertest';
import app from '../../app';

export interface RegisteredUser {
  userId: string;
  accessToken: string;
  email: string;
}

/**
 * Register a fresh test user via the public /api/v1/auth/register endpoint and
 * return the resulting JWT + user id. The email is prefixed with `suffix` and
 * the current timestamp, so callers can clean up with a single
 * `DELETE FROM users WHERE email LIKE 'test-<suffix>-%'` in afterAll.
 */
export async function registerUser(suffix: string): Promise<RegisteredUser> {
  const email = `test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await request(app).post('/api/v1/auth/register').send({
    email,
    password: 'password123',
    full_name: `Test ${suffix}`,
  });
  if (res.status !== 201) {
    throw new Error(`registerUser(${suffix}) failed: ${JSON.stringify(res.body)}`);
  }
  return {
    userId: res.body.data.user.id,
    accessToken: res.body.data.access_token,
    email,
  };
}
