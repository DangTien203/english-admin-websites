import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import pool from '../config/db';
import { CREDENTIALS_FILE, describeDatabase, repoPath } from '../scripts/acceptance/db';

// The credentials half of scripts/dev/seed-lookup-test-data.ts (step 1) and nothing else: rotates the password of the acceptance
// test user and writes .acceptance.local.json. It does NOT touch dictionary entries (the seed would publish run / go / light).
const EMAIL = 'lookup-acceptance@example.com';
const EBOOK_TITLE = 'Lookup acceptance ebook';
const PARAGRAPH_TEXT = 'The old bank stood by the river, and a light was running along the wall while the children went home.';
(async () => {
  const password = randomBytes(18).toString('base64url');
  const hash = await bcrypt.hash(password, 10);
  const u = await pool.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
  if (u.rows.length === 0) throw new Error('the acceptance test user does not exist; run the seed');
  await pool.query(`UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1`, [u.rows[0].id, hash]);
  const e = await pool.query(`SELECT id FROM ebooks WHERE title = $1 LIMIT 1`, [EBOOK_TITLE]);
  if (e.rows.length === 0) throw new Error('the acceptance ebook does not exist; run the seed');
  const ch = await pool.query(`SELECT id FROM chapters WHERE ebook_id = $1 AND chapter_index = 0`, [e.rows[0].id]);
  if (ch.rows.length === 0) throw new Error('the acceptance chapter does not exist; run the seed');
  const p = await pool.query(`SELECT id FROM paragraphs WHERE chapter_id = $1 AND paragraph_index = 0`, [ch.rows[0].id]);
  if (p.rows.length === 0) throw new Error('the acceptance paragraph does not exist; run the seed');
  fs.writeFileSync(repoPath(CREDENTIALS_FILE), JSON.stringify({ email: EMAIL, password, ebook_id: e.rows[0].id, paragraph_id: p.rows[0].id, database: describeDatabase(pool).database }, null, 2) + '\n', { mode: 0o600 });
  console.log('credentials written (password not printed)');
  await pool.end();
})().catch((err) => { console.error(String(err.message ?? err)); process.exit(1); });
