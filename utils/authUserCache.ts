import pool from '../config/db';
import { TtlCache, type TtlCacheOptions } from './ttlCache';

/**
 * The row of the signed-in user that requireApiAuth / optionalApiAuth put on `req.user`.
 *
 * It used to be read from the database on EVERY request of the mobile API: one network round trip (about 60 ms to the remote database)
 * before the handler could even start, and an app screen sends several requests at once. The row changes rarely, so it is kept for a
 * few seconds (AUTH_USER_CACHE_TTL_MS, default 15000; 0 turns the cache off).
 *
 * Staleness is bounded in two ways:
 *   - every code path of this process that writes one of these columns calls invalidateAuthUser() (User model, profile routes, streak),
 *     so a ban or a profile change made through the admin site or the API shows on the very next request;
 *   - a write made by ANOTHER process (a second server instance, a script, SQL by hand) shows after at most the TTL.
 * A banned user is never kept in the cache and neither is "no such user", so the 403 / 401 answers always come from the database.
 */

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  level: string;
  status: string;
  streak_current: number;
  streak_longest: number;
  avatar_url: string | null;
}

export interface AuthUserCacheDeps {
  /** reads the row (null when there is none) */
  query: (userId: unknown) => Promise<AuthUser | null>;
  ttlMs: number;
  /** see TtlCacheOptions.bypass (default: off under NODE_ENV=test) */
  bypass?: TtlCacheOptions['bypass'];
  now?: () => number;
}

export function createAuthUserCache(deps: AuthUserCacheDeps) {
  const cache = new TtlCache<AuthUser | null>({ ttlMs: deps.ttlMs, max: 5000, bypass: deps.bypass, now: deps.now });

  return {
    /** The user row for a verified token, or null when the account does not exist. A fresh copy: callers may change it. */
    async load(userId: unknown): Promise<AuthUser | null> {
      // Anything that is not a plain id (a malformed token payload) goes straight to the database, which answers as it always did.
      if (typeof userId !== 'string' || userId === '' || deps.ttlMs <= 0) return deps.query(userId);

      const row = await cache.getOrLoad(userId, () => deps.query(userId), {
        cacheIf: (u) => u !== null && u.status !== 'banned',
      });
      return row ? { ...row } : null;
    },

    /** Forgets one user, or every user when no id is given. */
    invalidate(userId?: string | null): void {
      if (userId) cache.delete(userId);
      else cache.clear();
    },
  };
}

const ttlMs = (() => {
  const raw = process.env.AUTH_USER_CACHE_TTL_MS;
  const n = raw === undefined || raw === '' ? 15_000 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
})();

async function queryUser(userId: unknown): Promise<AuthUser | null> {
  const { rows } = await pool.query(
    `SELECT id, email, full_name, level, status,
            streak_current, streak_longest, avatar_url
       FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

const authUsers = createAuthUserCache({ query: queryUser, ttlMs });

export const loadAuthUser = (userId: unknown): Promise<AuthUser | null> => authUsers.load(userId);

/** Call after any change to the columns above (name, level, avatar, status, streak) or after the account is deleted. */
export const invalidateAuthUser = (userId?: string | null): void => authUsers.invalidate(userId);
