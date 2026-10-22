import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import Admin from '../models/Admin';

const AUTH_LAYOUT = 'layouts/auth';
const GENERIC_LOGIN_ERROR = 'Email hoặc mật khẩu không đúng';

// Compared against when the e-mail is unknown, so a miss takes as long as a wrong password (no account enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10);

/** Admin e-mails are stored trimmed and in lower case: every lookup goes through this, so "Tien@Gmail.com " finds "tien@gmail.com". */
const normalizeEmail = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const ROLE_VALUES = ['content_editor', 'moderator', 'super_admin'];

interface RegisterForm {
  full_name: string;
  email: string;
  role: string;
}

function readRegisterForm(raw: string | undefined): RegisterForm {
  const empty: RegisterForm = { full_name: '', email: '', role: 'content_editor' };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    return {
      full_name: typeof parsed.full_name === 'string' ? parsed.full_name : '',
      email: typeof parsed.email === 'string' ? parsed.email : '',
      role: ROLE_VALUES.includes(parsed.role) ? parsed.role : 'content_editor',
    };
  } catch {
    return empty;
  }
}

const authController = {
  // ── GET /auth/login ──
  getLogin(req: Request, res: Response) {
    // After a failed attempt the e-mail typed is given back (never the password).
    const [email] = req.flash('login_email');
    res.render('auth/login', { title: 'Đăng nhập', layout: AUTH_LAYOUT, email: email || '' });
  },

  // ── POST /auth/login ──
  async postLogin(req: Request, res: Response) {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    const fail = (message: string) => {
      req.flash('error', message);
      if (email) req.flash('login_email', email);
      return res.redirect('/auth/login');
    };

    try {
      if (!email || !password) return fail('Vui lòng nhập email và mật khẩu');

      const admin = await Admin.findByEmail(email);

      // Always one bcrypt comparison, whether or not the account exists.
      const isMatch = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);
      if (!admin || !isMatch) return fail(GENERIC_LOGIN_ERROR);

      // Only said to someone who knows the password: a stranger cannot learn which e-mails belong to disabled accounts.
      if (admin.status === 'disabled') return fail('Tài khoản đã bị vô hiệu hóa. Liên hệ Super Admin.');

      // Lưu session
      req.session.admin = {
        id: admin.id,
        email: admin.email,
        full_name: admin.full_name,
        role: admin.role,
        avatar_url: admin.avatar_url,
      };

      await Admin.updateLastLogin(admin.id);

      req.flash('success', `Xin chào, ${admin.full_name}!`);
      return res.redirect('/dashboard');
    } catch (err) {
      console.error('[Auth] Login error:', err);
      return fail('Đã xảy ra lỗi. Vui lòng thử lại.');
    }
  },

  // ── GET /auth/register ──
  getRegister(req: Request, res: Response) {
    const [saved] = req.flash('register_form');
    res.render('auth/register', { title: 'Tạo tài khoản', layout: AUTH_LAYOUT, form: readRegisterForm(saved) });
  },

  // ── POST /auth/register ──
  async postRegister(req: Request, res: Response) {
    const { full_name, password, password_confirm, role } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);

    const fail = (message: string) => {
      req.flash('error', message);
      // Everything but the passwords is given back, so a typo does not mean typing the form again.
      req.flash('register_form', JSON.stringify({ full_name: typeof full_name === 'string' ? full_name : '', email, role }));
      return res.redirect('/auth/register');
    };

    try {
      // Validate
      const errors: string[] = [];
      if (typeof full_name !== 'string' || full_name.trim().length < 2) {
        errors.push('Họ tên phải có ít nhất 2 ký tự');
      }
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        errors.push('Email không hợp lệ');
      }
      if (typeof password !== 'string' || password.length < 6) {
        errors.push('Mật khẩu phải có ít nhất 6 ký tự');
      }
      if (password !== password_confirm) {
        errors.push('Xác nhận mật khẩu không khớp');
      }

      if (errors.length > 0) return fail(errors.join('. '));

      // Check email tồn tại (case-insensitive)
      const existing = await Admin.findByEmail(email);
      if (existing) return fail('Email đã được sử dụng');

      // Chỉ super_admin mới được tạo super_admin khác
      const allowedRoles = ['content_editor', 'moderator'];
      if (req.session && req.session.admin && req.session.admin.role === 'super_admin') {
        allowedRoles.push('super_admin');
      }
      const finalRole = allowedRoles.includes(role) ? role : 'content_editor';

      const passwordHash = await bcrypt.hash(password, 10);

      try {
        await Admin.create({
          email,
          passwordHash,
          fullName: full_name.trim(),
          role: finalRole,
        });
      } catch (err: any) {
        // Two sign-ups with the same e-mail at the same moment: the unique index decides.
        if (err?.code === '23505') return fail('Email đã được sử dụng');
        throw err;
      }

      req.flash('success', 'Tạo tài khoản thành công! Hãy đăng nhập.');
      req.flash('login_email', email);
      return res.redirect('/auth/login');
    } catch (err) {
      console.error('[Auth] Register error:', err);
      return fail('Đã xảy ra lỗi. Vui lòng thử lại.');
    }
  },

  // ── POST /auth/logout ──
  postLogout(req: Request, res: Response) {
    req.session.destroy((err) => {
      if (err) console.error('[Auth] Logout error:', err);
      res.redirect('/auth/login');
    });
  },
};

export = authController;
