/**
 * Fixtures for the tests of the lookup / enrichment admin pages (P8): three admin accounts (one per role) that are really logged
 * in through POST /auth/login, entries that look like the ones the job writes, ledger rows and lookups. Real PostgreSQL (the dev
 * database, like every other suite); no network.
 *
 * Everything is named after the run so that cleanup() removes exactly what this run made:
 *   - words / headwords  "qzq<run><tag>"  (letters only: the word cleaner rejects digits)
 *   - admin accounts     "p8-<run>-<role>@example.com"
 *   - the lookup user    "p8-<run>-user@example.com"
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import type { Express } from 'express';
import pool from '../../config/db';

export const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
export const fixtureWord = (tag: string): string => `qzq${RUN}${tag}`.toLowerCase();
const PASSWORD = 'p8-test-password';

export type Role = 'super_admin' | 'content_editor' | 'moderator';
export type Agent = ReturnType<typeof request.agent>;

export interface AdminFixture {
  id: string;
  email: string;
  role: Role;
  agent: Agent;
}

export async function createAdmins(app: Express): Promise<Record<Role, AdminFixture>> {
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const out = {} as Record<Role, AdminFixture>;
  for (const role of ['super_admin', 'content_editor', 'moderator'] as Role[]) {
    const email = `p8-${RUN}-${role.replace('_', '')}@example.com`;
    const { rows } = await pool.query(
      `INSERT INTO admin_accounts (email, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, hash, `P8 ${role}`, role]
    );
    const agent = request.agent(app);
    const login = await agent.post('/auth/login').type('form').send({ email, password: PASSWORD });
    if (login.status !== 302 || login.headers.location !== '/dashboard') throw new Error(`login of ${role} failed: ${login.status} ${login.headers.location}`);
    out[role] = { id: rows[0].id, email, role, agent };
  }
  return out;
}

export interface EntryOptions {
  tag: string;
  published?: boolean;
  /** the admin_note; default: a note like the job's, without notes for review */
  adminNote?: string | null;
  /** [definition_vi, definition_en] of the senses; default one sense */
  senses?: Array<{ pos?: string; definition_en?: string | null; definition_vi?: string | null; examples?: Array<[string, string | null]> }>;
  meaningVi?: string | null;
  pos?: string[];
  /** extra rows */
  tags?: string[];
}

export const NOTE_CLEAN = '[auto] nguồn: wiktionary, haiku · model: claude-haiku-5-5 · job: seed-test · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · thiếu tầng B: etymology';
export const NOTE_WITH_REVIEW = `${NOTE_CLEAN} · ghi chú của Haiku: Nghĩa 'chắt rượu' thuộc chuyên ngành. | cần kiểm tra lại cefr_level`;

/** An entry as the job writes it. Returns the id. */
export async function createEntry(o: EntryOptions): Promise<string> {
  const word = fixtureWord(o.tag);
  const senses = o.senses ?? [
    { pos: 'noun', definition_en: 'a thing used in a test', definition_vi: 'cái dùng để thử; vật mẫu', examples: [['This is a test thing.', 'Đây là một vật thử.']] as Array<[string, string | null]> },
  ];
  const { rows } = await pool.query(
    `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, meaning_en, cefr_level, source, published, admin_note, ipa_us)
     VALUES ($1, $1, $2, $3, 'a thing', 'B1', 'wiktionary', $4, $5, '/test/') RETURNING id`,
    [
      word,
      o.pos ?? ['noun'],
      o.meaningVi === undefined ? 'cái dùng để thử; vật mẫu' : o.meaningVi,
      o.published ?? false,
      o.adminNote === undefined ? NOTE_CLEAN : o.adminNote,
    ]
  );
  const id: string = rows[0].id;
  let order = 0;
  for (const s of senses) {
    const sense = await pool.query(
      `INSERT INTO entry_senses (entry_id, pos, sense_order, definition_en, definition_vi) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [id, s.pos ?? 'noun', order++, s.definition_en === undefined ? 'a thing' : s.definition_en, s.definition_vi === undefined ? 'cái; vật' : s.definition_vi]
    );
    let n = 0;
    for (const [en, vi] of s.examples ?? []) {
      await pool.query(`INSERT INTO sense_examples (sense_id, example_en, example_vi, sort_order) VALUES ($1, $2, $3, $4)`, [sense.rows[0].id, en, vi, n++]);
    }
  }
  return id;
}

export async function createJob(o: { tag: string; status: string; reason?: string | null; attempts?: number; entryId?: string | null; createdAt?: Date }): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO word_enrichment_jobs (word, status, reason, attempts, entry_id, created_at, finished_at)
     VALUES ($1, $2::varchar, $3, $4, $5, COALESCE($6, NOW()), CASE WHEN $2::varchar IN ('queued', 'running') THEN NULL ELSE NOW() END) RETURNING id`,
    [fixtureWord(o.tag), o.status, o.reason ?? null, o.attempts ?? 1, o.entryId ?? null, o.createdAt ?? null]
  );
  return rows[0].id;
}

let lookupUserId: string | undefined;

async function lookupUser(): Promise<string> {
  if (lookupUserId) return lookupUserId;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name) VALUES ($1, 'x', 'P8 reader') RETURNING id`,
    [`p8-${RUN}-user@example.com`]
  );
  lookupUserId = rows[0].id as string;
  return lookupUserId;
}

/** `count` lookups of `wordText`, `daysAgo` days ago. */
export async function createLookups(o: { wordText: string | null; result: string; count: number; daysAgo?: number }): Promise<void> {
  const user = await lookupUser();
  for (let i = 0; i < o.count; i++) {
    await pool.query(
      `INSERT INTO word_lookups (user_id, source, word_text, lookup_result, created_at)
       VALUES ($1, 'manual_search', $2, $3, NOW() - ($4::int * INTERVAL '1 day') - ($5::int * INTERVAL '1 second'))`,
      [user, o.wordText, o.result, o.daysAgo ?? 0, i]
    );
  }
}

/** Removes everything this run created. Safe to call twice. */
export async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM word_enrichment_jobs WHERE word LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM dictionary_entries WHERE headword LIKE $1`, [`qzq${RUN}%`]); // children cascade
  await pool.query(`DELETE FROM users WHERE email = $1`, [`p8-${RUN}-user@example.com`]); // its lookups cascade
  await pool.query(`DELETE FROM admin_accounts WHERE email LIKE $1`, [`p8-${RUN}-%`]);
  lookupUserId = undefined;
}
