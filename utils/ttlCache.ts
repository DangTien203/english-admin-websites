/**
 * A small in-process cache: values live for a time-to-live, the number of entries is capped (the least recently used goes first), and
 * `getOrLoad` lets concurrent callers of one key share a single load ("single flight").
 *
 * Why it exists: the database is a network hop away (about 60 ms from a laptop to Neon), so a value that is read on EVERY request and
 * changes rarely (the signed-in user's row, the active subscription, the features of a plan) is worth keeping for a few seconds. The
 * caches built on this class are invalidated by the code that changes the data (see utils/authUserCache.ts, utils/subscriptionHelper.ts);
 * the TTL only bounds how stale a value can get when another process wrote it.
 *
 * Switched off under NODE_ENV=test (every get misses, nothing is stored), like the other caches of this code base: the suites change
 * rows with plain SQL and expect the next request to see them. A test of the cache itself passes `bypass: false`.
 *
 * Invalidation and loads in flight: a load that STARTED before `delete`/`clear` may read the old row. Its result is still handed to the
 * callers that were waiting for it, but it is not stored (the `epoch` changed), so an invalidation can never be undone by a slow reader.
 */

export interface TtlCacheOptions {
  /** how long a stored value stays valid, in milliseconds */
  ttlMs: number;
  /** most entries kept; when exceeded the least recently used entry is dropped (default 1000) */
  max?: number;
  /** true, or a function returning true: the cache does nothing (default: yes under NODE_ENV=test) */
  bypass?: boolean | (() => boolean);
  /** clock in milliseconds, for tests */
  now?: () => number;
}

export interface LoadOptions<V> {
  /** override of the TTL for the value this load produces */
  ttlMs?: number;
  /** return false to hand the value to the callers but not store it (default: store everything, `null` included) */
  cacheIf?: (value: V) => boolean;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

const defaultBypass = (): boolean => process.env.NODE_ENV === 'test';

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly bypass: () => boolean;
  private readonly now: () => number;
  /** bumped by delete() / clear(): a load that began under an older epoch must not store its result */
  private epoch = 0;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.max = Math.max(1, options.max ?? 1000);
    const b = options.bypass;
    this.bypass = typeof b === 'function' ? b : b === undefined ? defaultBypass : () => b;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.store.size;
  }

  /** The stored value, or undefined when there is none, it has expired, or the cache is bypassed. A hit makes the key the most recent. */
  get(key: string): V | undefined {
    if (this.bypass()) return undefined;
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Map keeps insertion order: re-inserting moves the key to the "most recently used" end.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number = this.ttlMs): void {
    if (this.bypass() || ttlMs <= 0) return;
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Forgets one key. A load of that key that is still running will not store its result. */
  delete(key: string): void {
    this.epoch++;
    this.store.delete(key);
    this.inflight.delete(key);
  }

  clear(): void {
    this.epoch++;
    this.store.clear();
    this.inflight.clear();
  }

  /**
   * The stored value, or the result of `loader`. Callers that ask for the same key while a load is running share it (one database
   * round trip instead of one each). A failed load is not stored and is not shared with later callers.
   */
  async getOrLoad(key: string, loader: () => Promise<V>, options: LoadOptions<V> = {}): Promise<V> {
    if (this.bypass()) return loader();

    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const running = this.inflight.get(key);
    if (running) return running;

    const startedAt = this.epoch;
    // `Promise.resolve().then(loader)`: a loader that throws before its first await is a rejection like any other, and the
    // callbacks below always run after `load` has been assigned.
    const load: Promise<V> = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (this.epoch === startedAt && (options.cacheIf ? options.cacheIf(value) : true)) {
          this.set(key, value, options.ttlMs);
        }
        return value;
      })
      .finally(() => {
        // Only remove our own promise: delete() may already have replaced it with a newer load.
        if (this.inflight.get(key) === load) this.inflight.delete(key);
      });
    this.inflight.set(key, load);
    return load;
  }
}
