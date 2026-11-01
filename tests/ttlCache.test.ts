import { TtlCache } from '../utils/ttlCache';

/** A cache with a clock the test moves by hand. `bypass: false`: the default switches the cache off under NODE_ENV=test. */
function make<V>(over: Partial<ConstructorParameters<typeof TtlCache<V>>[0]> = {}) {
  let t = 1_000_000;
  const cache = new TtlCache<V>({ ttlMs: 1000, bypass: false, now: () => t, ...over });
  return { cache, advance: (ms: number) => (t += ms) };
}

describe('TtlCache', () => {
  it('returns what was stored until the TTL has passed', () => {
    const { cache, advance } = make<string>();
    cache.set('a', 'x');
    expect(cache.get('a')).toBe('x');
    advance(999);
    expect(cache.get('a')).toBe('x');
    advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0); // the expired entry is dropped when it is found
  });

  it('keeps null (a known "nothing") apart from a miss', () => {
    const { cache } = make<string | null>();
    cache.set('none', null);
    expect(cache.get('none')).toBeNull();
    expect(cache.get('other')).toBeUndefined();
  });

  it('a per-set TTL overrides the default, and a TTL of 0 stores nothing', () => {
    const { cache, advance } = make<number>();
    cache.set('short', 1, 100);
    cache.set('never', 2, 0);
    advance(150);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('never')).toBeUndefined();
  });

  it('drops the least recently used entry beyond `max`, and a hit counts as a use', () => {
    const { cache } = make<number>({ max: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a is now newer than b
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('delete and clear forget keys', () => {
    const { cache } = make<number>();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    cache.clear();
    expect(cache.get('b')).toBeUndefined();
  });

  describe('bypass', () => {
    it('stores nothing and always loads', async () => {
      const { cache } = make<number>({ bypass: true });
      cache.set('a', 1);
      expect(cache.get('a')).toBeUndefined();
      const loader = jest.fn(async () => 7);
      await cache.getOrLoad('a', loader);
      await cache.getOrLoad('a', loader);
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('is on by default under NODE_ENV=test (what keeps the suites seeing their own SQL changes)', async () => {
      expect(process.env.NODE_ENV).toBe('test');
      const cache = new TtlCache<number>({ ttlMs: 1000 });
      const loader = jest.fn(async () => 1);
      await cache.getOrLoad('k', loader);
      await cache.getOrLoad('k', loader);
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('can be a function, read at every call', () => {
      let off = true;
      const { cache } = make<number>({ bypass: () => off });
      cache.set('a', 1);
      expect(cache.get('a')).toBeUndefined();
      off = false;
      cache.set('a', 1);
      expect(cache.get('a')).toBe(1);
    });
  });

  describe('getOrLoad', () => {
    it('loads once, then serves from the cache', async () => {
      const { cache } = make<string>();
      const loader = jest.fn(async () => 'v');
      expect(await cache.getOrLoad('k', loader)).toBe('v');
      expect(await cache.getOrLoad('k', loader)).toBe('v');
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('caches a null result too (a user without a subscription is the common case)', async () => {
      const { cache } = make<string | null>();
      const loader = jest.fn(async () => null);
      expect(await cache.getOrLoad('k', loader)).toBeNull();
      expect(await cache.getOrLoad('k', loader)).toBeNull();
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('lets concurrent callers share one load', async () => {
      const { cache } = make<number>();
      let release!: (v: number) => void;
      const loader = jest.fn(() => new Promise<number>((resolve) => (release = resolve)));
      const all = Promise.all([cache.getOrLoad('k', loader), cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)]);
      await Promise.resolve();
      release(42);
      expect(await all).toEqual([42, 42, 42]);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('does not store a failure, does not share it with later callers, and passes the error on', async () => {
      const { cache } = make<number>();
      const boom = new Error('db down');
      const loader = jest.fn().mockRejectedValueOnce(boom).mockResolvedValueOnce(5);
      await expect(cache.getOrLoad('k', loader)).rejects.toBe(boom);
      expect(await cache.getOrLoad('k', loader)).toBe(5);
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('treats a loader that throws before its first await as a rejection and leaves nothing in flight', async () => {
      const { cache } = make<number>();
      const loader = jest
        .fn<Promise<number>, []>()
        .mockImplementationOnce(() => {
          throw new Error('sync');
        })
        .mockResolvedValueOnce(9);
      await expect(cache.getOrLoad('k', loader)).rejects.toThrow('sync');
      expect(await cache.getOrLoad('k', loader)).toBe(9);
    });

    it('cacheIf=false hands the value over without storing it', async () => {
      const { cache } = make<{ status: string }>();
      const loader = jest.fn(async () => ({ status: 'banned' }));
      const opts = { cacheIf: (u: { status: string }) => u.status !== 'banned' };
      await cache.getOrLoad('u', loader, opts);
      await cache.getOrLoad('u', loader, opts);
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('a per-load TTL applies to the value that load produced', async () => {
      const { cache, advance } = make<number>();
      const loader = jest.fn(async () => 1);
      await cache.getOrLoad('k', loader, { ttlMs: 50 });
      advance(60);
      await cache.getOrLoad('k', loader, { ttlMs: 50 });
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('an invalidation while a load is running keeps that (possibly old) result out of the cache', async () => {
      const { cache } = make<string>();
      let release!: (v: string) => void;
      const slow = jest.fn(() => new Promise<string>((resolve) => (release = resolve)));
      const pending = cache.getOrLoad('k', slow);
      await Promise.resolve();

      cache.delete('k'); // the row was written after the slow reader looked at it
      release('old');
      expect(await pending).toBe('old'); // the waiting caller still gets its answer …
      expect(cache.get('k')).toBeUndefined(); // … but the cache did not keep it

      const fresh = jest.fn(async () => 'new');
      expect(await cache.getOrLoad('k', fresh)).toBe('new');
      expect(await cache.getOrLoad('k', fresh)).toBe('new');
      expect(fresh).toHaveBeenCalledTimes(1);
    });

    it('a caller that arrives after an invalidation starts its own load instead of joining the old one', async () => {
      const { cache } = make<string>();
      let releaseOld!: (v: string) => void;
      const old = jest.fn(() => new Promise<string>((resolve) => (releaseOld = resolve)));
      const first = cache.getOrLoad('k', old);
      await Promise.resolve();

      cache.delete('k');
      const second = await cache.getOrLoad('k', async () => 'after');
      expect(second).toBe('after');

      releaseOld('before');
      expect(await first).toBe('before');
      expect(cache.get('k')).toBe('after'); // the old load did not overwrite the newer value
    });
  });
});
