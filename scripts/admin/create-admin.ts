/**
 * Creates ONE admin account with the role super_admin.
 *
 *   npm run admin:create -- --email <email> --name "<full name>"
 *
 * The password is either
 *   - read from the environment variable ADMIN_PASSWORD (never printed), or
 *   - generated at random and printed ONCE, at the end of this run. It is not stored anywhere in clear: save it now.
 * It is never taken from the command line (a command line ends up in the shell history and in the process list).
 *
 * Only inserts: no table is emptied or dropped, no existing account is changed. Refuses when the e-mail is already an admin
 * (compared without regard to case: the login form lower-cases what is typed). Works on the database of .env.
 *
 * Exit code: 0 created, 1 refused or failed, 2 wrong usage.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import pool from '../../config/db';
import { readArg } from '../enrichment/args';

/** Same cost as every other place that hashes a password in this project. */
export const BCRYPT_ROUNDS = 10;
export const MIN_PASSWORD_LENGTH = 12;
/** bcrypt looks at the first 72 BYTES only; a longer password would be cut without a word. */
export const MAX_PASSWORD_BYTES = 72;
export const MAX_NAME_LENGTH = 100;
export const MAX_EMAIL_LENGTH = 255;

export class AdminExistsError extends Error {
  constructor(public readonly email: string) {
    super(`Đã có tài khoản admin với e-mail ${email}`);
    this.name = 'AdminExistsError';
  }
}

export class AdminInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminInputError';
  }
}

export interface Queryable {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** What the login form compares with: trimmed and lower case. */
export const normalizeEmail = (raw: unknown): string => String(raw ?? '').trim().toLowerCase();

export function validateEmail(email: string): string | null {
  if (!email) return 'Cần --email';
  if (email.length > MAX_EMAIL_LENGTH) return `E-mail dài quá ${MAX_EMAIL_LENGTH} ký tự`;
  if (!/^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/.test(email)) return 'E-mail không hợp lệ';
  return null;
}

/** The name as it is stored: white space collapsed, control characters refused. */
export function cleanName(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

export function validateName(name: string): string | null {
  if (!name) return 'Cần --name';
  if (name.length > MAX_NAME_LENGTH) return `Tên dài quá ${MAX_NAME_LENGTH} ký tự`;
  if (/[\u0000-\u001F\u007F<>]/.test(name)) return 'Tên chứa ký tự không được phép';
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự`;
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return `Mật khẩu dài quá ${MAX_PASSWORD_BYTES} byte (bcrypt chỉ đọc ${MAX_PASSWORD_BYTES} byte đầu)`;
  if (password !== password.trim()) return 'Mật khẩu không được bắt đầu hoặc kết thúc bằng khoảng trắng';
  return null;
}

/** 24 characters of URL-safe base64 from 18 random bytes (144 bits). */
export const generatePassword = (): string => randomBytes(18).toString('base64url');

export interface CreatedAdmin {
  id: string;
  email: string;
  name: string;
  role: 'super_admin';
}

/**
 * Inserts the admin. Throws AdminExistsError when the e-mail is taken (also when another process took it between the check and the
 * insert: the unique index on email decides), AdminInputError for a bad e-mail, name or password. Touches nothing else.
 */
export async function createAdmin(db: Queryable, input: { email: string; name: string; password: string }): Promise<CreatedAdmin> {
  const email = normalizeEmail(input.email);
  const name = cleanName(input.name);
  const problem = validateEmail(email) ?? validateName(name) ?? validatePassword(input.password);
  if (problem) throw new AdminInputError(problem);

  const existing = await db.query(`SELECT 1 FROM admin_accounts WHERE lower(email) = $1`, [email]);
  if (existing.rows.length > 0) throw new AdminExistsError(email);

  const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  try {
    const { rows } = await db.query(
      `INSERT INTO admin_accounts (email, password_hash, full_name, role) VALUES ($1, $2, $3, 'super_admin') RETURNING id`,
      [email, hash, name]
    );
    return { id: rows[0].id, email, name, role: 'super_admin' };
  } catch (err: any) {
    if (err?.code === '23505') throw new AdminExistsError(email);
    throw err;
  }
}

export interface RunDeps {
  db: Queryable;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = 'Cách dùng: npm run admin:create -- --email <email> --name "<họ tên>"   (mật khẩu: biến môi trường ADMIN_PASSWORD, hoặc để trống để sinh ngẫu nhiên)';

/** The command line. Returns the exit code; prints the generated password once, and only when it was generated. */
export async function run(argv: string[], deps: RunDeps): Promise<number> {
  let email: string | undefined;
  let name: string | undefined;
  try {
    email = readArg(argv, 'email');
    name = readArg(argv, 'name');
  } catch (e) {
    deps.err(String((e as Error).message));
    deps.err(USAGE);
    return 2;
  }
  if (!email || !name) {
    deps.err(USAGE);
    return 2;
  }
  if (argv.includes('--password')) {
    deps.err('Không nhận mật khẩu qua dòng lệnh (nó nằm lại trong lịch sử shell). Dùng biến môi trường ADMIN_PASSWORD, hoặc bỏ trống để sinh ngẫu nhiên.');
    return 2;
  }

  const fromEnv = deps.env.ADMIN_PASSWORD;
  const generated = fromEnv === undefined || fromEnv === '';
  const password = generated ? generatePassword() : (fromEnv as string);

  try {
    const admin = await createAdmin(deps.db, { email, name, password });
    deps.out(`Đã tạo admin super_admin: ${admin.email} (${admin.name}), id ${admin.id}.`);
    if (generated) {
      deps.out('Mật khẩu (chỉ hiện MỘT lần, hãy lưu ngay; không có cách xem lại):');
      deps.out(password);
    } else {
      deps.out('Mật khẩu: lấy từ biến môi trường ADMIN_PASSWORD (không in lại).');
    }
    return 0;
  } catch (e) {
    if (e instanceof AdminExistsError) {
      deps.err(`Từ chối: ${e.message}. Không đổi gì.`);
      return 1;
    }
    if (e instanceof AdminInputError) {
      deps.err(`Từ chối: ${e.message}.`);
      return 2;
    }
    deps.err(`Lỗi: ${String((e as Error)?.message ?? e)}`);
    return 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2), { db: pool, env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) })
    .then(async (code) => {
      await pool.end().catch(() => undefined);
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('admin:create failed:', String(err?.message ?? err));
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
