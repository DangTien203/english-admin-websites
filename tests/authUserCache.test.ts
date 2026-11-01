import { createAuthUserCache, type AuthUser } from '../utils/authUserCache';

// The module also builds the default instance on the real pool; this suite only uses the factory, so the pool is never opened.
jest.mock('../config/db', () => ({ query: jest.fn() }));

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 'u1',
  email: 'u1@example.com',
  full_name: 'User One',
  level: 'beginner',
  status: 'active',
  streak_current: 0,
  streak_longest: 0,
  avatar_url: null,
  ...over,
});

function make(rows: Record<string, AuthUser | null>) {
  let t = 5_000_000;
  const query = jest.fn(async (id: unknown) => rows[String(id)] ?? null);
  const cache = createAuthUserCache({ query, ttlMs: 15_000, bypass: false, now: () => t });
  return { cache, query, rows, advance: (ms: number) => (t += ms) };
}

describe('auth user cache', () => {
  it('reads the database once per TTL, not once per request', async () => {
    const { cache, query, advance } = make({ u1: user() });
    for (let i = 0; i < 5; i++) expect((await cache.load('u1'))?.email).toBe('u1@example.com');
    expect(query).toHaveBeenCalledTimes(1);

    advance(15_001);
    await cache.load('u1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('hands out copies: a handler that changes req.user does not change what the next request sees', async () => {
    const { cache } = make({ u1: user() });
    const first = (await cache.load('u1'))!;
    first.full_name = 'Changed by a handler';
    expect((await cache.load('u1'))!.full_name).toBe('User One');
  });

  it('never keeps a banned user: the 403 always comes from a fresh read, and an unban shows at once', async () => {
    const { cache, query, rows } = make({ u1: user({ status: 'banned' }) });
    expect((await cache.load('u1'))?.status).toBe('banned');
    expect((await cache.load('u1'))?.status).toBe('banned');
    expect(query).toHaveBeenCalledTimes(2);

    rows.u1 = user({ status: 'active' });
    expect((await cache.load('u1'))?.status).toBe('active');
  });

  it('never keeps "no such user" either', async () => {
    const { cache, query, rows } = make({});
    expect(await cache.load('ghost')).toBeNull();
    expect(await cache.load('ghost')).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);

    rows.ghost = user({ id: 'ghost' });
    expect((await cache.load('ghost'))?.id).toBe('ghost');
  });

  it('invalidate(id) makes the next request read the row again (a ban through the admin site takes effect at once)', async () => {
    const { cache, query, rows } = make({ u1: user(), u2: user({ id: 'u2' }) });
    await cache.load('u1');
    await cache.load('u2');
    expect(query).toHaveBeenCalledTimes(2);

    rows.u1 = user({ status: 'banned' });
    cache.invalidate('u1');
    expect((await cache.load('u1'))?.status).toBe('banned');
    await cache.load('u2'); // untouched
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('invalidate() without an id forgets everybody', async () => {
    const { cache, query } = make({ u1: user(), u2: user({ id: 'u2' }) });
    await cache.load('u1');
    await cache.load('u2');
    cache.invalidate();
    await cache.load('u1');
    await cache.load('u2');
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('sends a token payload that is not a plain id straight to the database (which answers as it always did)', async () => {
    const { cache, query } = make({});
    expect(await cache.load(undefined)).toBeNull();
    expect(await cache.load(undefined)).toBeNull();
    expect(await cache.load('')).toBeNull();
    expect(await cache.load(42)).toBeNull();
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('concurrent requests of one user share one read', async () => {
    const { cache, query } = make({ u1: user() });
    const all = await Promise.all([cache.load('u1'), cache.load('u1'), cache.load('u1')]);
    expect(all.every((u) => u?.id === 'u1')).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('a TTL of 0 turns the cache off', async () => {
    const query = jest.fn(async () => user());
    const cache = createAuthUserCache({ query, ttlMs: 0, bypass: false });
    await cache.load('u1');
    await cache.load('u1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('is off by default under NODE_ENV=test, so the suites see their own SQL changes', async () => {
    const query = jest.fn(async () => user());
    const cache = createAuthUserCache({ query, ttlMs: 15_000 });
    await cache.load('u1');
    await cache.load('u1');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
