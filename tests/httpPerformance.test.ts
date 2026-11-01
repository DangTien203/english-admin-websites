/**
 * What the app does to get bytes to the browser / phone faster (app.ts): compression from 1 KB up, long caching of uploaded files
 * (their names carry a timestamp, so a name is never reused), revalidation for the CSS / JS of the admin site, no X-Powered-By.
 * Real Express app; none of these routes needs the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { RUN } from './helpers/lookupAdminFixtures';

const UPLOADS = path.resolve(__dirname, '..', 'public', 'uploads');
const uploaded = path.join(UPLOADS, `qzq-perf-${RUN}.txt`);
const CSS = path.resolve(__dirname, '..', 'public', 'css', 'style.css');

beforeAll(() => {
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.writeFileSync(uploaded, 'uploaded content\n'.repeat(200));
});

afterAll(async () => {
  fs.rmSync(uploaded, { force: true });
  await pool.end();
});

describe('compression', () => {
  it('gzips a text response over 1 KB for a client that accepts it, and the body is unchanged', async () => {
    const res = await request(app).get('/css/style.css').set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers.vary).toMatch(/accept-encoding/i);
    expect(res.text).toBe(fs.readFileSync(CSS, 'utf8')); // supertest inflates it
    expect(Number(res.headers['content-length'] ?? 0)).toBeLessThan(fs.statSync(CSS).size / 2); // and it is much smaller on the wire
  });

  it('leaves the response alone for a client that does not accept compression', async () => {
    const res = await request(app).get('/css/style.css').set('Accept-Encoding', 'identity');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.text.length).toBe(fs.readFileSync(CSS, 'utf8').length);
  });

  it('does not bother with a small response (an API error is a few dozen bytes)', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Accept-Encoding', 'gzip'); // no token
    expect(res.status).toBe(401);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.error.code).toBe('NO_TOKEN');
  });
});

describe('caching of static files', () => {
  it('uploaded files are cacheable for a week without revalidation', async () => {
    const res = await request(app).get(`/uploads/${path.basename(uploaded)}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=604800, immutable');
    expect(res.headers.etag).toBeTruthy();
  });

  it('the CSS / JS of the admin site are revalidated with their ETag (a second request is a 304 with no body)', async () => {
    const first = await request(app).get('/css/style.css').set('Accept-Encoding', 'identity');
    expect(first.headers['cache-control']).toBe('public, max-age=0'); // not production: no reuse without revalidating
    const second = await request(app).get('/css/style.css').set('Accept-Encoding', 'identity').set('If-None-Match', first.headers.etag);
    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });
});

describe('headers', () => {
  it('does not announce the framework', async () => {
    const res = await request(app).get('/css/style.css');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
