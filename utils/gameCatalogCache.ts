import { TtlCache } from './ttlCache';

/**
 * The public game catalogs of the mobile API — the levels, the word lists (name + word count) and the semantic sets — are read by every
 * player when a game screen opens, and change only when an admin edits them in /games. They are kept for a minute
 * (GAME_CATALOG_CACHE_TTL_MS; 0 turns it off) and models/Game.ts drops them on every write, so an edit in the admin site shows at once.
 */
const raw = process.env.GAME_CATALOG_CACHE_TTL_MS;
const ttlMs = raw === undefined || raw.trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0 ? 60_000 : Number(raw);

export const gameCatalogCache = new TtlCache<unknown[]>({ ttlMs, max: 200 });

/** Forget every cached catalog (a level, word list or semantic set was created, changed or deleted). */
export const invalidateGameCatalog = (): void => gameCatalogCache.clear();
