import type { Request, Response, NextFunction } from 'express';
import { apiError } from '../utils/apiResponse';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The JSON endpoints of the admin pages answer in JSON (a fetch() call cannot follow a flash + redirect); every other path is a page.
const JSON_PATH = /^\/lookup\/api(?:[/?]|$)/;

const MESSAGE = 'Request refused: it did not come from this site';

/** Host (with port) named by an Origin / Referer value, lowercased; null when it cannot be read ("null" origins included). */
function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * CSRF defence for the session-cookie surface (the admin pages and /lookup/api): a state-changing request that names an origin
 * must name this site's.
 *
 *   - POST / PUT / PATCH / DELETE only; GET, HEAD and OPTIONS pass.
 *   - Origin is checked, or Referer when there is no Origin (browsers send at least one of them on a cross-site form post or fetch).
 *   - Neither header (curl, supertest, a browser that strips both) → passes: the session cookie's SameSite=Lax is the other layer.
 *   - A header that is present but unreadable (Origin: null, a sandboxed frame) counts as cross-site.
 *
 * Do NOT mount this on /api/v1: the mobile app authenticates with a Bearer token, which a cross-site page cannot attach.
 */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!UNSAFE_METHODS.has(req.method)) return next();

  const source = req.get('origin') ?? req.get('referer');
  if (source === undefined) return next();

  const sourceHost = hostOf(source);
  const ownHost = req.get('host')?.toLowerCase();
  if (sourceHost !== null && sourceHost === ownHost) return next();

  if (JSON_PATH.test(req.originalUrl)) {
    apiError(res, 403, 'FORBIDDEN', MESSAGE);
    return;
  }
  req.flash('error', MESSAGE);
  res.redirect(req.session?.admin ? '/dashboard' : '/auth/login');
}
