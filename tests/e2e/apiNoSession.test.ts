/**
 * /api/v1 authenticates with a JWT: it must not create an HTTP session or answer with Set-Cookie (connect.sid).
 * Before, express-session + connect-flash + injectAdmin ran on every request, so each API call, even with a valid JWT and no
 * cookie, added an empty session to the in-memory store and set a new cookie. The admin pages keep their session.
 *
 * The real Express app with the mock upstream (no real service is called), like the other suites in tests/e2e.
 */
import request from 'supertest';
import { bootLookupApp, fixtureWord, type LookupApp } from '../helpers/lookupApp';

jest.setTimeout(60_000);

const setCookie = (res: request.Response): string[] => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

let a: LookupApp;

beforeAll(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  a = await bootLookupApp();
});

afterAll(async () => {
  await a?.close();
  jest.restoreAllMocks();
});

describe('POST /api/v1/ebooks/:id/lookup with a JWT and no cookie', () => {
  it('answers without Set-Cookie and leaves the session store as it was', async () => {
    const before = await a.sessionCount();

    for (const tag of ['one', 'two', 'three']) {
      const res = await a.lookup(fixtureWord(`ns${tag}`));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(setCookie(res)).toEqual([]);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    await a.settle();

    expect(await a.sessionCount()).toBe(before);
  });

  it('also for the answers that are not 200: bad token, bad word, unknown path with and without a token, any letter case of /api', async () => {
    const before = await a.sessionCount();
    const lookupPath = `/api/v1/ebooks/${a.ebookId}/lookup`;

    const responses = [
      await request(a.app).post(lookupPath).send({ word: fixtureWord('anon') }), // 401, no token
      await request(a.app).post(lookupPath).set('Authorization', 'Bearer not.a.jwt').send({ word: 'run' }), // 401, bad token
      await a.lookup('!!'), // 400, rejected word
      await request(a.app).get('/api/v1/no-such-endpoint'), // 401: the broad /api/v1 mount wants a token first
      await request(a.app).get('/api/v1/no-such-endpoint').set('Authorization', `Bearer ${a.user.token}`), // 404 JSON
      await request(a.app).post(lookupPath.replace('/api/', '/API/')).set('Authorization', `Bearer ${a.user.token}`).send({ word: fixtureWord('upper') }), // Express routes /API/ like /api/
    ];

    expect(responses.map((r) => r.status)).toEqual([401, 401, 400, 401, 404, 200]);
    for (const res of responses) expect(setCookie(res)).toEqual([]);
    await a.settle();
    expect(await a.sessionCount()).toBe(before);
  });
});

describe('the admin pages keep their session', () => {
  it('the login page still starts a session: Set-Cookie connect.sid, one more session', async () => {
    const before = await a.sessionCount();

    const res = await request(a.app).get('/auth/login');

    expect(res.status).toBe(200);
    const cookies = setCookie(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^connect\.sid=/);
    expect(cookies[0]).toMatch(/HttpOnly/i);
    expect(cookies[0]).toMatch(/SameSite=Lax/i);
    expect(await a.sessionCount()).toBe(before + 1);
  });

  it('a client that sends the cookie back keeps the same session (no new one, no new cookie)', async () => {
    const agent = request.agent(a.app);
    const first = await agent.get('/auth/login');
    expect(setCookie(first)).toHaveLength(1);
    const before = await a.sessionCount();

    const second = await agent.get('/auth/login');

    expect(second.status).toBe(200);
    expect(setCookie(second)).toEqual([]);
    expect(await a.sessionCount()).toBe(before);
  });

  it('flash messages still work across redirects (a protected page sends the visitor to login with a message)', async () => {
    const agent = request.agent(a.app);

    const redirect = await agent.get('/dashboard');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('/auth/login');
    expect(setCookie(redirect)).toHaveLength(1);

    const login = await agent.get('/auth/login');
    expect(login.text).toContain('Vui lòng đăng nhập để tiếp tục');
  });
});
