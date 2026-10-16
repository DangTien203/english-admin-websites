import type { RequestHandler } from 'express';
import { apiError } from '../utils/apiResponse';
import { logAdminAction } from '../utils/adminAudit';
import type { AdminRole } from '../services/lookup/adminRules';

/**
 * Role gate for the JSON endpoints of the admin pages (the lookup / enrichment pages of P8). Same session and same roles as
 * requireRole in middlewares/auth.ts, but it answers in JSON: that one redirects to the login page with a flash message, which
 * is right for a page and useless for a fetch() call.
 *
 *   no session            → 401 UNAUTHORIZED
 *   role not in the list  → 403 FORBIDDEN (a refused write is also logged as admin_action / forbidden)
 */
export function requireAdminJson(...roles: AdminRole[]): RequestHandler {
  return (req, res, next) => {
    const admin = req.session?.admin;
    if (!admin) {
      apiError(res, 401, 'UNAUTHORIZED', 'Vui lòng đăng nhập');
      return;
    }
    if (!roles.includes(admin.role as AdminRole)) {
      if (req.method !== 'GET') {
        logAdminAction({ adminId: admin.id, action: `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`, result: 'forbidden' });
      }
      apiError(res, 403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này');
      return;
    }
    next();
  };
}
