import request from 'supertest';
import app from '../app';
import pool from '../config/db';

afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await pool.end(); });

it.each(['/api/v1/health', '/api/v1/health?db=0', '/api/v1/health?db=true'])(
  '%s is public, does not query the DB, and is never cached', async (url) => {
    const query = jest.spyOn(pool, 'query');
    const res = await request(app).get(url).set('Authorization', 'Bearer invalid');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: 'ok' } });
    expect(query).not.toHaveBeenCalled();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
  }
);

it('?db=1 performs exactly SELECT 1 without authentication', async () => {
  const query = jest.spyOn(pool, 'query');
  const res = await request(app).get('/api/v1/health?db=1');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, data: { status: 'ok', db: 'ok' } });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith('SELECT 1');
});

it('DB probe failure returns 503 without exposing database details', async () => {
  jest.spyOn(pool, 'query').mockImplementationOnce(() => Promise.reject(new Error('private connection details')));
  const res = await request(app).get('/api/v1/health?db=1');
  expect(res.status).toBe(503);
  expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
  expect(JSON.stringify(res.body)).not.toContain('private');
  expect(res.headers['cache-control']).toBe('no-store');
});
