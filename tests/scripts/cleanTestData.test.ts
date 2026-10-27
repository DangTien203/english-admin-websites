/**
 * scripts/dev/clean-test-data.ts against the real database, on fixtures of its own. The patterns are narrowed to this run
 * ("qzqcln<run>…", "auth-cln<run>-…@example.com", "E2E ebook cln<run>"), so the test can never touch the rows of another suite that
 * is running at the same moment, nor a real row. Old fixtures are made old by moving created_at back two hours.
 */
import pool from '../../config/db';
import { parseCleanArgs, runCleanTestData, DEFAULT_OLDER_THAN_MINUTES, DEFAULT_PATTERNS, type Patterns } from '../../scripts/dev/clean-test-data';

jest.setTimeout(120_000);

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const patterns: Patterns = {
  words: [`qzqcln${RUN}%`],
  emails: [`auth-cln${RUN}-%@example.com`],
  ebookTitles: [`E2E ebook cln${RUN}%`],
  deckTitles: [`Test Deck cln${RUN}`],
};
const word = (tag: string) => `qzqcln${RUN}${tag}`;
const email = (tag: string) => `auth-cln${RUN}-${tag}@example.com`;
const ebook = (tag: string) => `E2E ebook cln${RUN}${tag}`;

const run = async (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCleanTestData(argv, { db: pool as any, out: (l) => out.push(l), err: (l) => err.push(l), patterns });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

const exists = async (sql: string, p: any[]) => (await pool.query(sql, p)).rows.length > 0;
const entryExists = (headword: string) => exists(`SELECT 1 FROM dictionary_entries WHERE headword = $1`, [headword]);
const userExists = (e: string) => exists(`SELECT 1 FROM users WHERE email = $1`, [e]);
const ebookExists = (title: string) => exists(`SELECT 1 FROM ebooks WHERE title = $1`, [title]);

const ago = (table: string, column: string, value: string) => pool.query(`UPDATE ${table} SET created_at = NOW() - INTERVAL '2 hours' WHERE ${column} = $1`, [value]);

async function makeFixtures() {
  for (const tag of ['old', 'new']) {
    await pool.query(`INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, source, published) VALUES ($1, $1, ARRAY['noun']::varchar[], 'x', 'manual', FALSE)`, [word(tag)]);
    await pool.query(`INSERT INTO users (email, password_hash, full_name, level) VALUES ($1, 'not-a-real-hash', 'Clean Test', 'beginner')`, [email(tag)]);
    await pool.query(`INSERT INTO ebooks (title, author, level, required_plan, status, epub_file_url) VALUES ($1, 'E2E', 'beginner', 'free', 'published', '/x.epub')`, [ebook(tag)]);
  }
  // a row that matches no pattern, however old: it must stay
  await pool.query(`INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, source, published) VALUES ($1, $1, ARRAY['noun']::varchar[], 'x', 'manual', FALSE)`, [`zzcln${RUN}real`]);
  await ago('dictionary_entries', 'headword', word('old'));
  await ago('dictionary_entries', 'headword', `zzcln${RUN}real`);
  await ago('users', 'email', email('old'));
  await ago('ebooks', 'title', ebook('old'));
}

async function wipe() {
  await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1 OR headword = $2`, [`qzqcln${RUN}%`, `zzcln${RUN}real`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`auth-cln${RUN}-%@example.com`]);
  await pool.query(`DELETE FROM ebooks WHERE title LIKE $1`, [`E2E ebook cln${RUN}%`]);
}

beforeAll(async () => {
  await makeFixtures();
});
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('arguments', () => {
  it('reads --confirm and --older-than; anything else is refused', () => {
    expect(parseCleanArgs([])).toEqual({ confirm: false, olderThanMinutes: DEFAULT_OLDER_THAN_MINUTES });
    expect(parseCleanArgs(['--confirm', '--older-than', '5'])).toEqual({ confirm: true, olderThanMinutes: 5 });
    for (const bad of [['--confirmed'], ['--yes'], ['--older-than'], ['--older-than', 'soon'], ['--older-than', '-1']]) expect(() => parseCleanArgs(bad)).toThrow();
  });

  it('the default patterns do not match the acceptance fixture or an ordinary address', () => {
    const like = (value: string, pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`).test(value);
    for (const keep of ['lookup-acceptance@example.com', 'someone@gmail.com', 'dangtien311399@gmail.com', 'admin@english-app.com']) {
      expect(DEFAULT_PATTERNS.emails.some((p) => like(keep, p))).toBe(false);
    }
    for (const junk of ['test-srs-1@example.com', 'e2e-abc-main@example.com', 'p8-abc-moderator@example.com', 'auth-abc-plain@example.com', 'phase6l-1792060071666-1@example.com']) {
      expect(DEFAULT_PATTERNS.emails.some((p) => like(junk, p))).toBe(true);
    }
    expect(DEFAULT_PATTERNS.words.some((p) => like('qzqabcdefclean', p))).toBe(true);
    expect(DEFAULT_PATTERNS.words.some((p) => like('quiz', p) || like('test', p))).toBe(false);
  });
});

describe('the command', () => {
  it('is a dry run by default: lists what is old enough, deletes nothing', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('CHƯA XÓA GÌ');
    expect(r.out).toMatch(/\s1\s+từ điển test/);
    expect(r.out).toMatch(/\s1\s+người học test/);
    expect(r.out).toMatch(/\s1\s+ebook test/);
    expect(await entryExists(word('old'))).toBe(true);
    expect(await userExists(email('old'))).toBe(true);
    expect(await ebookExists(ebook('old'))).toBe(true);
  });

  it('refuses an unknown option (exit 2) and plans nothing', async () => {
    const r = await run(['--confrim']);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain('usage: npm run clean:test-data');
  });

  it('--older-than keeps what is younger: with 3 hours, nothing from this run is old enough', async () => {
    const r = await run(['--older-than', '180', '--confirm']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Không có gì để xóa.');
    expect(await entryExists(word('old'))).toBe(true);
  });

  it('--confirm deletes the old fixtures, and ONLY those: the young ones and a row without a marker stay', async () => {
    const r = await run(['--confirm']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Xong (một giao dịch).');

    expect(await entryExists(word('old'))).toBe(false);
    expect(await userExists(email('old'))).toBe(false);
    expect(await ebookExists(ebook('old'))).toBe(false);

    expect(await entryExists(word('new'))).toBe(true); // a suite running right now
    expect(await userExists(email('new'))).toBe(true);
    expect(await ebookExists(ebook('new'))).toBe(true);
    expect(await entryExists(`zzcln${RUN}real`)).toBe(true); // old, but not a fixture
  });

  it('a second run finds nothing old left', async () => {
    const r = await run([]);
    expect(r.out).toContain('Sạch: không có gì để xóa.');
  });
});
