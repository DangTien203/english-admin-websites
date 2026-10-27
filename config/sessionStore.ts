import session from 'express-session';

/**
 * The session store of the admin pages (express-session's default in-memory one), in its own module so that code outside app.ts —
 * e.g. ending the sessions of an admin account that a super admin just edited — can reach it without importing the app.
 * app.ts re-exports it for the tests.
 */
export const sessionStore = new session.MemoryStore();
