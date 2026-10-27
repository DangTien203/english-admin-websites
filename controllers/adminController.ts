import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import Admin from '../models/Admin';
import { destroyAdminSessions } from '../utils/adminSessions';

const ROLES = ['super_admin', 'content_editor', 'moderator'];
const STATUSES = ['active', 'disabled'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 72; // bcrypt ignores everything past 72 bytes

/** Same rule as sign-in / sign-up: e-mails are stored trimmed and in lower case. */
const normalizeEmail = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/**
 * Super admins only (routes/admins.ts). Edits OTHER admin accounts; your own account stays on /profile, so a super admin can neither
 * demote nor disable themselves by accident.
 */
const adminController = {
  // GET /admins
  async getIndex(_req: Request, res: Response) {
    try {
      const admins = await Admin.getAll();
      res.render('admins/index', { title: 'Admin Accounts', active: 'admins', admins });
    } catch (err) {
      console.error('[Admins] getIndex error:', err);
      res.render('admins/index', { title: 'Admin Accounts', active: 'admins', admins: [], error: ['Failed to load the admin list'] });
    }
  },

  // GET /admins/:id/edit
  async getEdit(req: Request, res: Response) {
    try {
      const id = String(req.params.id);
      if (id === req.session.admin.id) return redirectToProfile(req, res);

      const target = UUID.test(id) ? await Admin.findById(id) : null;
      if (!target) return notFound(req, res);

      res.render('admins/edit', { title: 'Edit Admin', active: 'admins', target });
    } catch (err) {
      console.error('[Admins] getEdit error:', err);
      req.flash('error', 'Failed to load the admin account');
      return res.redirect('/admins');
    }
  },

  // POST /admins/:id/edit
  async postEdit(req: Request, res: Response) {
    const id = String(req.params.id);
    const back = `/admins/${id}/edit`;
    const fail = (message: string) => {
      req.flash('error', message);
      return res.redirect(back);
    };

    try {
      if (id === req.session.admin.id) return redirectToProfile(req, res);
      if (!UUID.test(id)) return notFound(req, res);

      const { full_name, role, status, new_password, confirm_password } = req.body ?? {};
      const email = normalizeEmail(req.body?.email);

      const errors: string[] = [];
      if (typeof full_name !== 'string' || full_name.trim().length < 2 || full_name.trim().length > 255) {
        errors.push('Full name must be 2–255 characters');
      }
      if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 255) errors.push('Email is not valid');
      if (!ROLES.includes(role)) errors.push('Role is not valid');
      if (!STATUSES.includes(status)) errors.push('Status is not valid');

      // An empty password box means "leave the password alone".
      const wantsPassword = typeof new_password === 'string' && new_password !== '';
      if (wantsPassword) {
        if (new_password.length < MIN_PASSWORD) errors.push(`New password must be at least ${MIN_PASSWORD} characters`);
        else if (new_password.length > MAX_PASSWORD) errors.push(`New password must be at most ${MAX_PASSWORD} characters`);
        else if (new_password !== confirm_password) errors.push('Password confirmation does not match');
      }
      if (errors.length > 0) return fail(errors.join('. '));

      let result;
      try {
        result = await Admin.updateByAdmin(
          id,
          {
            fullName: full_name.trim(),
            email,
            role,
            status,
            passwordHash: wantsPassword ? await bcrypt.hash(new_password, 10) : null,
          },
          { id: req.session.admin.id, ip: req.ip }
        );
      } catch (err: any) {
        if (err?.code === 'NOT_FOUND') return notFound(req, res);
        if (err?.code === 'EMAIL_TAKEN') return fail('That email is already used by another account');
        if (err?.code === 'LAST_SUPER_ADMIN') return fail('At least one active super admin must remain');
        throw err;
      }

      // The old sessions still carry the old role / status: end them when anything that decides what the admin may do changed.
      const { changes, passwordReset, after } = result;
      const rightsChanged = Boolean(changes.role || changes.status || changes.email) || passwordReset;
      const ended = rightsChanged ? await destroyAdminSessions(id) : 0;

      req.flash(
        'success',
        `${after.full_name} updated${ended > 0 ? ' — signed out, they must sign in again' : ''}`
      );
      return res.redirect('/admins');
    } catch (err) {
      console.error('[Admins] postEdit error:', err);
      return fail('An error occurred. Please try again.');
    }
  },
};

function redirectToProfile(req: Request, res: Response) {
  req.flash('warning', 'Your own account is edited on your profile page');
  return res.redirect('/profile');
}

function notFound(req: Request, res: Response) {
  req.flash('error', 'Admin account not found');
  return res.redirect('/admins');
}

export = adminController;
