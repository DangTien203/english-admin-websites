/**
 * The safety latch of the scripts that EMPTY or OVERWRITE data in the database `config/db.ts` connects to:
 *   - scripts/seed.ts                  (`npm run db:seed`, and the second half of `npm run db:fresh`): empties a long list of tables
 *   - database/reset.ts                (`npm run db:reset`, and the first half of `npm run db:fresh`): DROPs tables
 *   - scripts/seed-mobile-test-users.ts: sets a fixed password on 6 accounts and deletes their data
 *
 * That is what a developer wants on a local database and a disaster anywhere else, so each of them refuses to start when
 *   - NODE_ENV is "production", or
 *   - the database it would connect to is not on this machine,
 * unless the command line has the flag that script names (`--i-know-this-wipes-tables` for the first two). Whatever the verdict, it
 * first prints which database it is about to use (host and name, never the password) and what it will empty.
 *
 * Pure apart from the printing function that is handed in, so it is tested without a database (tests/scripts/seedGuard.test.ts).
 * It reads the same variables as config/db.ts, in the same order: DATABASE_URL when it is a postgres URL, else DB_HOST / DB_NAME.
 * One implementation (`guardWipe`) serves all three; the per-script wording is built by `guardSeed`, `guardReset`, `guardTestUsers`.
 */

export const WIPE_FLAG = '--i-know-this-wipes-tables';
/** the flag of scripts/seed-mobile-test-users.ts (it wipes nothing but the data of its own 6 accounts, so the flag says what it really does) */
export const FIXED_PASSWORD_FLAG = '--i-know-this-sets-a-known-password';

export interface SeedTarget {
  /** where the pool will connect */
  host: string;
  database: string;
  /** which variables decided it */
  via: 'DATABASE_URL' | 'DB_HOST';
}

/** What config/db.ts would connect to. An unreadable DATABASE_URL gives host "" (never local). */
export function seedTarget(env: NodeJS.ProcessEnv): SeedTarget {
  const url = env.DATABASE_URL;
  if (url && (url.startsWith('postgresql://') || url.startsWith('postgres://'))) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      // a URL like "postgresql://%" parses (its host is opaque) but names no machine
      return { host: /^[a-z0-9._:-]+$/.test(host) ? host : '', database: decodeURIComponent(u.pathname.replace(/^\//, '')), via: 'DATABASE_URL' };
    } catch {
      return { host: '', database: '', via: 'DATABASE_URL' };
    }
  }
  return { host: String(env.DB_HOST || 'localhost').toLowerCase(), database: env.DB_NAME || 'english_learning_app', via: 'DB_HOST' };
}

/** localhost, 127.x.x.x, ::1 and *.localhost: this machine. Anything else (a name that merely starts with "localhost" too) is not. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost');
}

export interface SeedVerdict {
  target: SeedTarget;
  nodeEnv: string;
  /** why the script would normally refuse (empty = nothing to object to) */
  reasons: string[];
  /** the flag was given */
  flag: boolean;
  /** may go on: no reason, or the flag overrides them */
  allowed: boolean;
}

export function checkSeedSafety(argv: readonly string[], env: NodeJS.ProcessEnv, flagName: string = WIPE_FLAG): SeedVerdict {
  const target = seedTarget(env);
  const nodeEnv = env.NODE_ENV ?? '';
  const reasons: string[] = [];
  if (nodeEnv === 'production') reasons.push('NODE_ENV=production');
  if (!isLocalHost(target.host)) reasons.push(`cơ sở dữ liệu không nằm trên máy này (host: ${target.host || 'không đọc được'})`);
  const flag = argv.includes(flagName);
  return { target, nodeEnv, reasons, flag, allowed: reasons.length === 0 || flag };
}

/** What a script tells the operator, and the flag it accepts. */
export interface WipeNotice {
  /** the first line; `where` reads "host / database (qua …, NODE_ENV=…)" */
  headline: (where: string) => string;
  /** what will be emptied, dropped or overwritten, one line each */
  details: readonly string[];
  /** the flag that lets it go on */
  flag: string;
  /** completes "Chỉ chạy tiếp khi …" in the refusal */
  confirm: string;
  /** a command line that carries the flag */
  example: string;
}

/**
 * Prints the notice and returns whether the script may go on. The caller exits when it returns false, BEFORE it takes a connection.
 */
export function guardWipe(argv: readonly string[], env: NodeJS.ProcessEnv, notice: WipeNotice, print: (line: string) => void): boolean {
  const v = checkSeedSafety(argv, env, notice.flag);
  const where = `${v.target.host || '(không đọc được host)'} / ${v.target.database || '(không rõ)'} (qua ${v.target.via}, NODE_ENV=${v.nodeEnv || '(trống)'})`;
  print(notice.headline(where));
  for (const line of notice.details) print(line);
  if (v.reasons.length > 0 && !v.flag) {
    print(`TỪ CHỐI chạy: ${v.reasons.join('; ')}.`);
    print(`Chỉ chạy tiếp khi ${notice.confirm}: thêm ${notice.flag} vào lệnh (ví dụ: ${notice.example}).`);
    return false;
  }
  if (v.reasons.length > 0) print(`CẢNH BÁO: ${v.reasons.join('; ')}. Vẫn chạy vì có ${notice.flag}.`);
  return true;
}

/**
 * scripts/seed.ts: `tables` is the list the seed really empties (CLEANUP_TABLES of scripts/seed.ts).
 */
export function guardSeed(argv: readonly string[], env: NodeJS.ProcessEnv, tables: readonly string[], print: (line: string) => void): boolean {
  return guardWipe(
    argv,
    env,
    {
      headline: (where) => `Seed sẽ XÓA SẠCH dữ liệu của ${tables.length} bảng trước khi ghi dữ liệu mẫu, trên cơ sở dữ liệu: ${where}.`,
      details: ['Các bảng bị xóa theo thứ tự (bảng không tồn tại thì bỏ qua):', `  ${tables.join(', ')}`],
      flag: WIPE_FLAG,
      confirm: 'bạn chắc chắn muốn xóa các bảng trên ở đó',
      example: `npm run db:seed -- ${WIPE_FLAG}`,
    },
    print
  );
}

/**
 * database/reset.ts (`npm run db:reset`, `npm run db:reset -- --all`). The tables to drop are not known before it connects (they are
 * "every table of schema public" except the kept ones), so the notice says exactly that; reset.ts prints the real list once it is
 * connected and before it drops anything.
 *
 * `npm run db:fresh` cannot carry the flag to this half: npm gives extra arguments to the LAST command only. On a database that is not
 * on this machine run `db:reset` and `db:seed` as two commands, each with the flag.
 */
export function guardReset(argv: readonly string[], env: NodeJS.ProcessEnv, o: { all: boolean; kept: readonly string[] }, print: (line: string) => void): boolean {
  const details = o.all
    ? ['Chế độ --all: KHÔNG giữ lại bảng nào (kể cả từ điển). Sau đó chạy lại migration để dựng cấu trúc; dữ liệu KHÔNG được khôi phục.']
    : [`Bảng nội dung từ điển được giữ nguyên (${o.kept.length} bảng): ${o.kept.join(', ')}.`, 'Mọi bảng khác (người dùng, tài khoản admin, gói đăng ký, ebook, bài học…) bị xóa cùng dữ liệu, rồi chạy lại migration.'];
  details.push('Danh sách bảng cụ thể lấy từ cơ sở dữ liệu sau khi kết nối và được in trước khi xóa.');
  return guardWipe(
    argv,
    env,
    {
      headline: (where) =>
        o.all
          ? `Reset sẽ XÓA TOÀN BỘ bảng trong schema public (DROP TABLE … CASCADE), trên cơ sở dữ liệu: ${where}.`
          : `Reset sẽ XÓA (DROP TABLE … CASCADE) mọi bảng trong schema public trừ ${o.kept.length} bảng nội dung từ điển, trên cơ sở dữ liệu: ${where}.`,
      details,
      flag: WIPE_FLAG,
      confirm: 'bạn chắc chắn muốn xóa các bảng đó ở đó',
      example: `npm run db:reset -- ${WIPE_FLAG}`,
    },
    print
  );
}

/**
 * scripts/seed-mobile-test-users.ts: it keeps the password it gives to the 6 accounts in the source (so anyone who reads the repository
 * knows it), and before writing them it deletes the study data of those accounts. On a database with real users that is an account
 * takeover waiting to happen if one of the e-mails exists there.
 */
export function guardTestUsers(argv: readonly string[], env: NodeJS.ProcessEnv, emails: readonly string[], print: (line: string) => void): boolean {
  return guardWipe(
    argv,
    env,
    {
      headline: (where) => `Script này đặt MỘT MẬT KHẨU CỐ ĐỊNH (ghi trong mã nguồn) cho ${emails.length} tài khoản người dùng cố định, trên cơ sở dữ liệu: ${where}.`,
      details: [
        'Trước khi ghi, nó XÓA dữ liệu học của chính các tài khoản đó (thẻ, phiên luyện tập, đăng ký, thông báo…); tài khoản đã có sẽ bị ĐẶT LẠI mật khẩu.',
        `Tài khoản: ${emails.join(', ')}`,
      ],
      flag: FIXED_PASSWORD_FLAG,
      confirm: 'bạn chắc chắn muốn đặt mật khẩu cố định đó ở đó',
      example: `npx tsx scripts/seed-mobile-test-users.ts ${FIXED_PASSWORD_FLAG}`,
    },
    print
  );
}
