/**
 * Database helpers of the acceptance tools (P7b): which database this is (name only, never the password), the facts about a
 * word that the preconditions need, the usage counters, the typed confirmation of the database name, the local credentials file.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Pool } from 'pg';
import type { Group, WordFacts } from './words';
import { FORM_LEMMAS } from './words';

export interface Queryable {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface DatabaseIdentity {
  host: string;
  database: string;
  user: string;
}

/** Host, database and user of a pool. The password is never read. */
export function describeDatabase(pool: Pool): DatabaseIdentity {
  const o: any = (pool as any).options ?? {};
  if (typeof o.connectionString === 'string' && o.connectionString) {
    const u = new URL(o.connectionString);
    return { host: u.hostname, database: decodeURIComponent(u.pathname.replace(/^\//, '')), user: decodeURIComponent(u.username) };
  }
  return { host: String(o.host ?? 'localhost'), database: String(o.database ?? ''), user: String(o.user ?? '') };
}

export const dbLabel = (d: DatabaseIdentity): string => `${d.host} / ${d.database}`;

/**
 * Asks the person at the keyboard to type the database name again. True only when it matches exactly.
 * Reads one line from stdin (works with a pipe too).
 */
export async function confirmDatabaseName(identity: DatabaseIdentity, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<boolean> {
  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    output.write(`Database: ${dbLabel(identity)} (user ${identity.user})\nGõ lại TÊN DATABASE "${identity.database}" để xác nhận: `);
    const answer: string = await new Promise((resolve) => {
      rl.once('line', (line) => resolve(line));
      rl.once('close', () => resolve(''));
    });
    return answer.trim() === identity.database && identity.database !== '';
  } finally {
    rl.close();
  }
}

// ── facts about a word ───────────────────────────────────────────────────────────────────────────────────────────────

/** Any entry (published or not) matching headword, lemma or a word_forms row; same match as S0 of the pipeline. */
export async function entryMatches(db: Queryable, word: string): Promise<{ exists: boolean; published: boolean; id: string | null; lemma: string | null }> {
  const w = word.trim().toLowerCase();
  const { rows } = await db.query(
    `SELECT e.id, e.lemma, e.published
       FROM dictionary_entries e
      WHERE lower(e.headword) = $1 OR lower(e.lemma) = $1
         OR e.id IN (SELECT wf.entry_id FROM word_forms wf WHERE lower(wf.form_value) = $1)
      ORDER BY e.published DESC, e.created_at
      LIMIT 5`,
    [w]
  );
  if (rows.length === 0) return { exists: false, published: false, id: null, lemma: null };
  const first = rows.find((r) => r.published) ?? rows[0];
  return { exists: true, published: rows.some((r) => r.published), id: first.id, lemma: first.lemma };
}

export async function headwordExists(db: Queryable, word: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM dictionary_entries WHERE lower(headword) = $1 LIMIT 1`, [word.trim().toLowerCase()]);
  return rows.length > 0;
}

/**
 * The entry a group B form is reached through: first through word_forms / headword / lemma, then through the lemma that
 * ref_wiktionary_en names for it (the local inflection step F4b of the fast path).
 */
export async function formTarget(db: Queryable, refDb: Queryable, word: string): Promise<{ lemma: string; published: boolean } | null> {
  const direct = await entryMatches(db, word);
  if (direct.exists) return { lemma: direct.lemma ?? word, published: direct.published };
  const { rows } = await refDb.query(`SELECT DISTINCT lemma_of FROM ref_wiktionary_en WHERE word = $1 AND lemma_of IS NOT NULL LIMIT 10`, [word.trim().toLowerCase()]);
  for (const r of rows) {
    const via = await entryMatches(db, String(r.lemma_of));
    if (via.exists) return { lemma: via.lemma ?? String(r.lemma_of), published: via.published };
  }
  const expected = FORM_LEMMAS[word];
  if (expected) {
    const via = await entryMatches(db, expected);
    if (via.exists) return { lemma: via.lemma ?? expected, published: via.published };
  }
  return null;
}

export async function collectWordFacts(db: Queryable, refDb: Queryable, group: Group, word: string): Promise<WordFacts> {
  const match = await entryMatches(db, word);
  return {
    entryExists: match.exists,
    entryPublished: match.published,
    headwordExists: await headwordExists(db, word),
    formTarget: group === 'B' ? await formTarget(db, refDb, word) : undefined,
  };
}

// ── usage counters ───────────────────────────────────────────────────────────────────────────────────────────────────

export const utcMonth = (now: Date = new Date()): string => now.toISOString().slice(0, 7);

export async function readCounter(db: Queryable, provider: string, unit: string, period: string): Promise<number> {
  const { rows } = await db.query(`SELECT used FROM api_usage_counters WHERE provider = $1 AND unit = $2 AND period = $3`, [provider, unit, period]);
  return rows.length > 0 ? Number(rows[0].used) : 0;
}

// ── local files (never committed) ────────────────────────────────────────────────────────────────────────────────────

export const CREDENTIALS_FILE = '.acceptance.local.json';
export const STATE_FILE = '.acceptance.state.json';

export interface AcceptanceCredentials {
  email: string;
  password: string;
  ebook_id: string;
  paragraph_id: string;
  database?: string;
}

export function repoPath(file: string): string {
  return path.resolve(__dirname, '..', '..', file);
}

export function readCredentials(file: string = repoPath(CREDENTIALS_FILE)): AcceptanceCredentials {
  if (!fs.existsSync(file)) {
    throw new Error(`Không thấy ${CREDENTIALS_FILE}. Chạy trước: npm run seed:lookup-test -- --staging`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['email', 'password', 'ebook_id', 'paragraph_id']) {
    if (typeof raw[key] !== 'string' || !raw[key]) throw new Error(`${CREDENTIALS_FILE}: thiếu "${key}"`);
  }
  return raw as AcceptanceCredentials;
}

/** What a run leaves behind for --cleanup, so that cleanup only touches what THAT run created. */
export interface AcceptanceState {
  /** database clock (ISO) when the first not-yet-cleaned run started */
  startedAt: string;
  database: string;
  words: string[];
}

export function readState(file: string = repoPath(STATE_FILE)): AcceptanceState | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AcceptanceState;
  } catch {
    return null;
  }
}

export function writeState(state: AcceptanceState, file: string = repoPath(STATE_FILE)): void {
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function clearState(file: string = repoPath(STATE_FILE)): void {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
