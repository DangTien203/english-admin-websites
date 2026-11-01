/**
 * The signed-in user of the mobile API (req.user) is kept in memory for a few seconds (utils/authUserCache.ts). Under NODE_ENV=test
 * the cache is switched off, so the rest of the suite sees its own SQL changes at once; here it is switched ON for a moment (the
 * cache reads NODE_ENV at every call) to check the whole path with the real app and database:
 *   - repeated requests do not read the users table again;
 *   - every writer that changes what req.user holds — the profile API, the admin site's User model — makes the next request see it;
 *   - a ban is never served from memory.
 */
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import User from '../models/User';
import { registerUser, type RegisteredUser } from './helpers/auth';

jest.setTimeout(120_000);

let user: RegisteredUser;

beforeAll(async () => {
  user = await registerUser('authcache');
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email = $1`, [user.email]);
  await pool.end();
});

const me = () => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${user.accessToken}`);

/** Runs `fn` with the caches on, counting how many times the users row was read for authentication. */
async function withCaches<T>(fn: (userReads: () => number) => Promise<T>): Promise<T> {
  const spy = jest.spyOn(pool, 'query');
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    return await fn(() => spy.mock.calls.filter(([sql]) => /FROM users WHERE id = \$1/.test(String(sql)) && /streak_longest, avatar_url/.test(String(sql))).length);
  } finally {
    process.env.NODE_ENV = previous;
    spy.mockRestore();
  }
}

describe('req.user from memory', () => {
  it('reads the users table once for a burst of requests, and hands every request the same data', async () => {
    await withCaches(async (userReads) => {
      const first = await me();
      expect(first.status).toBe(200);
      expect(userReads()).toBe(1);

      for (let i = 0; i < 4; i++) {
        const again = await me();
        expect(again.status).toBe(200);
        expect(again.body.data.user.id).toBe(user.userId);
      }
      expect(userReads()).toBe(1); // the four others came from memory
    });
  });

  it('a profile change through the API shows on the very next request', async () => {
    await withCaches(async () => {
      expect((await me()).body.data.user.full_name).toBe('Test authcache');
      const patch = await request(app).patch('/api/v1/profile/me').set('Authorization', `Bearer ${user.accessToken}`).send({ full_name: 'Renamed Reader' });
      expect(patch.status).toBe(200);
      expect((await me()).body.data.user.full_name).toBe('Renamed Reader');
    });
  });

  it('a change made through the admin site\'s User model shows at once, and a ban is answered with 403 immediately', async () => {
    await withCaches(async (userReads) => {
      expect((await me()).status).toBe(200); // warm

      await User.update(user.userId, { fullName: 'Edited by an admin', level: 'intermediate', status: 'active' });
      const edited = await me();
      expect(edited.body.data.user).toMatchObject({ full_name: 'Edited by an admin', level: 'intermediate' });

      await User.setStatus(user.userId, 'banned');
      const banned = await me();
      expect(banned.status).toBe(403);
      expect(banned.body.error.code).toBe('ACCOUNT_BANNED');

      // a banned user is not kept in memory: every request re-reads the row, so an unban works at once as well
      const before = userReads();
      expect((await me()).status).toBe(403);
      expect(userReads()).toBe(before + 1);
      await User.setStatus(user.userId, 'active');
      expect((await me()).status).toBe(200);
    });
  });

  it('a user deleted through the model is refused at once (401), not served from memory', async () => {
    const other = await registerUser('authcache-del');
    const get = () => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${other.accessToken}`);
    await withCaches(async () => {
      expect((await get()).status).toBe(200);
      await User.delete(other.userId);
      expect((await get()).status).toBe(401);
    });
  });
});

describe('with the caches off (NODE_ENV=test)', () => {
  it('every request reads the row: an SQL change made behind the application\'s back is visible at once', async () => {
    expect((await me()).status).toBe(200);
    await pool.query(`UPDATE users SET status = 'banned' WHERE id = $1`, [user.userId]);
    expect((await me()).status).toBe(403);
    await pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [user.userId]);
    expect((await me()).status).toBe(200);
  });
});
