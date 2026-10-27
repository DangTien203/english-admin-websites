/**
 * Removes what the test suites leave behind in the database. The tests share the dev database (CLAUDE.md), and a run that is killed,
 * times out or loses its connection never reaches its cleanup, so fixtures stay: words "qzq<run>…", test accounts, an "E2E ebook".
 * DRY RUN BY DEFAULT.
 *
 *   npm run clean:test-data                       # only LIST what would go, per kind
 *   npm run clean:test-data -- --confirm          # delete it, in ONE transaction, and print what was deleted
 *   npm run clean:test-data -- --older-than 180   # only rows older than 180 minutes (default 60)
 *
 * Only rows that carry a marker of the suites are touched, and only when they are older than --older-than: a test run that is going on
 * right now has fixtures too (they appear in /lookup/review while it runs), and they must be left to it. Markers (DEFAULT_PATTERNS):
 *   - dictionary entries, lessons, word lookups and enrichment jobs of "qzq…" words, and the "phase6l-entry-…" entries of the Leitner test;
 *   - users and admin accounts of the suites: e-mails "test-…", "e2e-…", "p8-…", "p8c-…", "auth-…", "phase6l-…", "loginprobe-…" @example.com
 *     (the documented fixture "lookup-acceptance@example.com" of the acceptance run is NOT matched: acceptance:lookup --cleanup removes it);
 *   - the "Leitner Test Deck" of a test user, and the ebooks "E2E ebook …" by "E2E".
 * What belongs to a deleted user or entry goes with it (ON DELETE CASCADE). If a foreign key stops a delete, nothing is deleted.
 */
import 'dotenv/config';
import pool from '../../config/db';
import { dbLabel, describeDatabase } from '../acceptance/db';

export interface Queryable {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface Connectable {
  connect(): Promise<Queryable & { release(err?: Error | boolean): void }>;
}

export interface Patterns {
  /** SQL LIKE patterns of the words of the suites (headword, lemma, lesson title, looked-up word, job word) */
  words: string[];
  /** SQL LIKE patterns of the e-mails of the test accounts */
  emails: string[];
  ebookTitles: string[];
  deckTitles: string[];
}

export const DEFAULT_PATTERNS: Patterns = {
  words: ['qzq%', 'phase6l-entry-%'],
  emails: ['test-%@example.com', 'e2e-%@example.com', 'p8-%@example.com', 'p8c-%@example.com', 'auth-%@example.com', 'phase6l-%@example.com', 'loginprobe-%@example.com'],
  ebookTitles: ['E2E ebook %'],
  deckTitles: ['Leitner Test Deck'],
};

export const DEFAULT_OLDER_THAN_MINUTES = 60;

/**
 * The steps, in the order they are deleted. Each one lists which parameters it uses (and in that order they are $1, $2, …); the last one
 * is always the number of minutes. Every statement is fixed text: nothing from the command line is spliced into SQL.
 */
type Param = 'words' | 'emails' | 'ebooks' | 'decks' | 'minutes';

interface Step {
  label: string;
  use: Param[];
  count: string;
  sample: string;
  remove: string;
}

export const STEPS: readonly Step[] = [
  {
    label: 'tra từ (word_lookups) của từ test',
    use: ['words', 'minutes'],
    count: `SELECT count(*)::int AS n FROM word_lookups WHERE word_text LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int)`,
    sample: `SELECT word_text AS name FROM word_lookups WHERE word_text LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int) LIMIT 3`,
    remove: `DELETE FROM word_lookups WHERE word_text LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int)`,
  },
  {
    label: 'job làm giàu (word_enrichment_jobs) của từ test',
    use: ['words', 'minutes'],
    count: `SELECT count(*)::int AS n FROM word_enrichment_jobs WHERE word LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int)`,
    sample: `SELECT word AS name FROM word_enrichment_jobs WHERE word LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int) LIMIT 3`,
    remove: `DELETE FROM word_enrichment_jobs WHERE word LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int)`,
  },
  {
    label: 'bộ thẻ test (decks) của tài khoản test',
    use: ['decks', 'emails', 'minutes'],
    count: `SELECT count(*)::int AS n FROM decks WHERE title = ANY($1::text[]) AND user_id IN (SELECT id FROM users WHERE email LIKE ANY($2::text[])) AND created_at < NOW() - make_interval(mins => $3::int)`,
    sample: `SELECT title AS name FROM decks WHERE title = ANY($1::text[]) AND user_id IN (SELECT id FROM users WHERE email LIKE ANY($2::text[])) AND created_at < NOW() - make_interval(mins => $3::int) LIMIT 3`,
    remove: `DELETE FROM decks WHERE title = ANY($1::text[]) AND user_id IN (SELECT id FROM users WHERE email LIKE ANY($2::text[])) AND created_at < NOW() - make_interval(mins => $3::int)`,
  },
  {
    label: 'người học test (users)',
    use: ['emails', 'minutes'],
    count: `SELECT count(*)::int AS n FROM users WHERE email LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int)`,
    sample: `SELECT email AS name FROM users WHERE email LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int) LIMIT 3`,
    remove: `DELETE FROM users WHERE email LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int)`,
  },
  {
    label: 'tài khoản admin test (admin_accounts)',
    use: ['emails', 'minutes'],
    count: `SELECT count(*)::int AS n FROM admin_accounts WHERE email LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int)`,
    sample: `SELECT email AS name FROM admin_accounts WHERE email LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int) LIMIT 3`,
    remove: `DELETE FROM admin_accounts WHERE email LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int)`,
  },
  {
    label: 'bài học test (lessons)',
    use: ['words', 'minutes'],
    count: `SELECT count(*)::int AS n FROM lessons WHERE title LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int)`,
    sample: `SELECT title AS name FROM lessons WHERE title LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int) LIMIT 3`,
    remove: `DELETE FROM lessons WHERE title LIKE ANY($1::text[]) AND created_at < NOW() - make_interval(mins => $2::int)`,
  },
  {
    label: 'từ điển test (dictionary_entries)',
    use: ['words', 'minutes'],
    count: `SELECT count(*)::int AS n FROM dictionary_entries WHERE (headword LIKE ANY($1::text[]) OR lemma LIKE ANY($1::text[])) AND created_at < NOW() - make_interval(mins => $2::int)`,
    sample: `SELECT headword AS name FROM dictionary_entries WHERE (headword LIKE ANY($1::text[]) OR lemma LIKE ANY($1::text[])) AND created_at < NOW() - make_interval(mins => $2::int) ORDER BY headword LIMIT 3`,
    remove: `DELETE FROM dictionary_entries WHERE (headword LIKE ANY($1::text[]) OR lemma LIKE ANY($1::text[])) AND created_at < NOW() - make_interval(mins => $2::int)`,
  },
  {
    label: 'ebook test (ebooks)',
    use: ['ebooks', 'minutes'],
    count: `SELECT count(*)::int AS n FROM ebooks WHERE title LIKE ANY($1::text[]) AND author = 'E2E' AND created_at < NOW() - make_interval(mins => $2::int)`,
    sample: `SELECT title AS name FROM ebooks WHERE title LIKE ANY($1::text[]) AND author = 'E2E' AND created_at < NOW() - make_interval(mins => $2::int) LIMIT 3`,
    remove: `DELETE FROM ebooks WHERE title LIKE ANY($1::text[]) AND author = 'E2E' AND created_at < NOW() - make_interval(mins => $2::int)`,
  },
];

export interface CleanArgs {
  confirm: boolean;
  olderThanMinutes: number;
}

export function parseCleanArgs(argv: string[]): CleanArgs {
  const out: CleanArgs = { confirm: false, olderThanMinutes: DEFAULT_OLDER_THAN_MINUTES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') out.confirm = true;
    else if (a === '--older-than') {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) throw new Error('--older-than needs a whole number of minutes');
      out.olderThanMinutes = Number(v);
    } else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

export interface CleanDeps {
  db: Connectable & Queryable;
  out: (line: string) => void;
  err: (line: string) => void;
  patterns?: Patterns;
  /** shown first (the database the command is about to touch) */
  label?: string;
}

export async function runCleanTestData(argv: string[], deps: CleanDeps): Promise<number> {
  const { out, err } = deps;
  let args: CleanArgs;
  try {
    args = parseCleanArgs(argv);
  } catch (e) {
    err(`${(e as Error).message}\nusage: npm run clean:test-data -- [--older-than ${DEFAULT_OLDER_THAN_MINUTES}] [--confirm]`);
    return 2;
  }
  const p = deps.patterns ?? DEFAULT_PATTERNS;
  const values: Record<Param, unknown> = { words: p.words, emails: p.emails, ebooks: p.ebookTitles, decks: p.deckTitles, minutes: args.olderThanMinutes };
  const paramsOf = (step: Step) => step.use.map((u) => values[u]);
  if (deps.label) out(deps.label);
  out(`Dữ liệu của bộ test cũ hơn ${args.olderThanMinutes} phút${args.confirm ? '' : ' (chạy thử)'}:`);

  let total = 0;
  for (const step of STEPS) {
    const n: number = (await deps.db.query(step.count, paramsOf(step))).rows[0].n;
    total += n;
    const names = n > 0 ? (await deps.db.query(step.sample, paramsOf(step))).rows.map((r) => r.name).join(', ') : '';
    out(`  ${String(n).padStart(4)}  ${step.label}${names ? `  vd: ${names}${n > 3 ? ', …' : ''}` : ''}`);
  }
  out(`  Tổng: ${total} hàng chính (các hàng con đi theo qua ON DELETE CASCADE)`);

  if (!args.confirm) {
    out(total === 0 ? '\nSạch: không có gì để xóa.' : '\nCHƯA XÓA GÌ (chạy thử). Để xóa thật: thêm --confirm.');
    return 0;
  }
  if (total === 0) {
    out('\nKhông có gì để xóa.');
    return 0;
  }

  const client = await deps.db.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    out('\nĐã xóa:');
    for (const step of STEPS) {
      const res = await client.query(step.remove, paramsOf(step));
      out(`  ${String(res.rowCount ?? 0).padStart(4)}  ${step.label}`);
    }
    await client.query('COMMIT');
    out('Xong (một giao dịch).');
    return 0;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    err(`Không xóa được, đã hoàn lại, DB không đổi: ${(e as Error).message}`);
    return 1;
  } finally {
    client.release(broken ? true : undefined);
  }
}

if (require.main === module) {
  runCleanTestData(process.argv.slice(2), {
    db: pool as any,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    label: `Cơ sở dữ liệu: ${dbLabel(describeDatabase(pool as any))}`,
  })
    .then(async (code) => {
      await pool.end().catch(() => undefined);
      process.exit(code);
    })
    .catch(async (e) => {
      console.error('clean:test-data failed:', e?.message ?? e);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
