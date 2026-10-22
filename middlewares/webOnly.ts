import type { Request, RequestHandler } from 'express';

/**
 * /api and everything under it: the JWT surface (mobile app). Matched like Express routes it, so case does not matter
 * (`/API/v1/...` reaches the same handlers as `/api/v1/...`). `/lookup/api/*` (admin JSON, session auth) is NOT an API path.
 */
export const isApiPath = (req: Pick<Request, 'path'>): boolean => /^\/api(\/|$)/i.test(req.path);

/**
 * Runs `handler` for the web pages only; `/api/*` skips it. Used for session, flash and the admin locals: with those on /api/v1,
 * every request, even one with a valid JWT and no cookie, created an empty session in the store and answered with Set-Cookie.
 */
export function webOnly(handler: RequestHandler): RequestHandler {
  return (req, res, next) => (isApiPath(req) ? next() : handler(req, res, next));
}
