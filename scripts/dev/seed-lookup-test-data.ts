/**
 * Prepares the database for the lookup acceptance run (P7b). STAGING ONLY: the database of .env (the single dev database,
 * no real users yet).
 *
 *   npm run seed:lookup-test -- --staging
 *
 * Refuses to run without --staging (and when NODE_ENV=production), and prints the database it is about to touch.
 *
 * What it does
 *   1. one test user (lookup-acceptance@example.com) with a RANDOM password, one ebook with one chapter and one paragraph, so that a
 *      lookup has a valid ebook_id and paragraph_id. Written to .acceptance.local.json (git-ignored; the password is not printed).
 *      A second run rotates the password and rewrites the file.
 *   2. the entries that groups A and B depend on (run, go, child, light, bank): a missing one is created with the real enrichment
 *      pipeline (what `npm run enrich:run` does), then set to published = true and logged in entry_edit_history. An entry that
 *      exists but is unpublished is published ONLY when the enrichment job wrote it ('[auto]' admin_note); anything else is left alone.
 *   3. checks the precondition of every word of docs/lookup-runbook.md §12 (A and B present and published; C, D, H not present;
 *      E and F with no entry) and prints the plan: which words will run, which are skipped and which stand-ins replace them.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { runPipeline } from '../../services/enrichment/pipeline';
import { createProductionDeps } from '../../services/enrichment/wiring';
import { getRefDb } from '../../services/lookup/refDb';
import {
  collectWordFacts,
  CREDENTIALS_FILE,
  dbLabel,
  describeDatabase,
  entryMatches,
  repoPath,
  type AcceptanceCredentials,
} from '../acceptance/db';
import { ALL_ACCEPTANCE_WORDS, checkPrecondition, GROUP_ORDER, GROUP_TITLES, GROUP_WORDS, FALLBACK_WORDS, PREREQUISITE_LEMMAS, planWords, type Group, type WordFacts } from '../acceptance/words';

const TEST_EMAIL = 'lookup-acceptance@example.com';
const EBOOK_TITLE = 'Lookup acceptance ebook';
const PARAGRAPH_TEXT = 'The old bank stood by the river, and a light was running along the wall while the children went home.';

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);

async function ensureUserAndEbook(): Promise<AcceptanceCredentials> {
  const password = randomBytes(18).toString('base64url');
  const hash = await bcrypt.hash(password, 10);
  const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [TEST_EMAIL]);
  if (existing.rows.length > 0) {
    await pool.query(`UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1`, [existing.rows[0].id, hash]);
    console.log(`  người dùng thử: đã có, đổi mật khẩu ngẫu nhiên (${TEST_EMAIL})`);
  } else {
    await pool.query(`INSERT INTO users (email, password_hash, full_name, level) VALUES ($1, $2, 'Lookup Acceptance', 'beginner')`, [TEST_EMAIL, hash]);
    console.log(`  người dùng thử: đã tạo (${TEST_EMAIL})`);
  }

  let ebookId: string;
  const ebook = await pool.query(`SELECT id FROM ebooks WHERE title = $1 LIMIT 1`, [EBOOK_TITLE]);
  if (ebook.rows.length > 0) {
    ebookId = ebook.rows[0].id;
    console.log('  ebook thử: đã có');
  } else {
    const created = await pool.query(
      `INSERT INTO ebooks (title, author, level, required_plan, status, epub_file_url) VALUES ($1, 'Acceptance', 'beginner', 'free', 'published', '/acceptance.epub') RETURNING id`,
      [EBOOK_TITLE]
    );
    ebookId = created.rows[0].id;
    console.log('  ebook thử: đã tạo');
  }
  const chapter = await pool.query(
    `INSERT INTO chapters (ebook_id, chapter_index, title) VALUES ($1, 0, 'Chapter 1')
     ON CONFLICT (ebook_id, chapter_index) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
    [ebookId]
  );
  const paragraph = await pool.query(
    `INSERT INTO paragraphs (chapter_id, paragraph_index, text, word_count) VALUES ($1, 0, $2, $3)
     ON CONFLICT (chapter_id, paragraph_index) DO UPDATE SET text = EXCLUDED.text RETURNING id`,
    [chapter.rows[0].id, PARAGRAPH_TEXT, PARAGRAPH_TEXT.split(/\s+/).length]
  );

  const credentials: AcceptanceCredentials = {
    email: TEST_EMAIL,
    password,
    ebook_id: ebookId,
    paragraph_id: paragraph.rows[0].id,
    database: describeDatabase(pool).database,
  };
  fs.writeFileSync(repoPath(CREDENTIALS_FILE), JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  console.log(`  đã ghi ${CREDENTIALS_FILE} (git-ignored; mật khẩu ngẫu nhiên, không in ra)`);
  return credentials;
}

function checkGitignore(): void {
  const gitignore = fs.existsSync(repoPath('.gitignore')) ? fs.readFileSync(repoPath('.gitignore'), 'utf8') : '';
  for (const file of ['.acceptance.local.json', '.acceptance.state.json']) {
    if (!gitignore.split(/\r?\n/).some((l) => l.trim() === file)) console.warn(`  CẢNH BÁO: ${file} chưa có trong .gitignore, thêm vào trước khi commit`);
  }
}

/** Publishes an entry written by the enrichment job and logs it. */
async function publish(entryId: string, lemma: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`UPDATE dictionary_entries SET published = TRUE WHERE id = $1 AND published = FALSE RETURNING id`, [entryId]);
    if (r.rows.length > 0) {
      await client.query(`INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value) VALUES ($1, NULL, 'published', 'false', 'true')`, [entryId]);
    }
    await client.query('COMMIT');
    console.log(`    "${lemma}": published = true (entry_edit_history ghi lại)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function ensurePrerequisite(lemma: string): Promise<boolean> {
  const rows = (await pool.query(`SELECT id, published, admin_note FROM dictionary_entries WHERE lower(lemma) = $1 OR lower(headword) = $1 ORDER BY published DESC, created_at`, [lemma])).rows;
  if (rows.some((r) => r.published)) {
    console.log(`  ${lemma}: đã có và published`);
    return true;
  }
  if (rows.length === 0) {
    console.log(`  ${lemma}: chưa có, tạo bằng đường ống làm giàu thật (gọi Haiku)`);
    const report = await runPipeline(
      { word: lemma, requestedBy: null, ebookId: null, jobRowId: `seed-${randomUUID()}`, attempt: 1 },
      createProductionDeps(),
      { onStage: (e) => console.log(`    ${e.stage.padEnd(18)} ${String(e.ms).padStart(6)} ms`) }
    );
    const o = report.outcome;
    console.log(`    kết quả: ${o.status}${o.reason ? ` / ${o.reason}` : ''}${o.entryId ? `  entry ${o.entryId}` : ''}${o.inputTokens ? `  token ${o.inputTokens}/${o.outputTokens}` : ''}`);
    if (o.status !== 'succeeded' || !o.entryId) return false;
    await publish(o.entryId, lemma);
    return true;
  }
  const auto = rows.find((r) => String(r.admin_note ?? '').startsWith('[auto]'));
  if (!auto) {
    console.log(`  ${lemma}: có mục từ nhưng published=false và KHÔNG phải do job làm giàu tạo: không đụng tới`);
    return false;
  }
  console.log(`  ${lemma}: có mục từ do job tạo (published=false), đặt published = true`);
  await publish(auto.id, lemma);
  return true;
}

async function main(): Promise<number> {
  if (!has('--staging')) {
    console.error('Từ chối: script này ghi vào DB trong .env. Thêm --staging để xác nhận đó là DB staging (DB dev duy nhất).');
    return 2;
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Từ chối: NODE_ENV=production.');
    return 2;
  }

  const identity = describeDatabase(pool);
  console.log(`DATABASE: ${dbLabel(identity)}  (user ${identity.user})`);
  console.log(`ENRICHMENT_PUBLISH_POLICY=${lookupConfig.flags.enrichmentPublishPolicy}  ENRICHMENT_ENABLED=${lookupConfig.flags.enrichmentEnabled}`);
  checkGitignore();

  console.log('\n[1] người dùng, ebook, đoạn văn');
  await ensureUserAndEbook();

  console.log('\n[2] mục từ gốc cho nhóm A và B');
  let prerequisitesOk = true;
  for (const lemma of PREREQUISITE_LEMMAS) {
    if (!(await ensurePrerequisite(lemma))) prerequisitesOk = false;
  }

  console.log('\n[3] kiểm tiền đề của từng từ');
  const refDb = getRefDb();
  const facts = new Map<string, WordFacts>();
  for (const group of GROUP_ORDER) {
    for (const word of [...GROUP_WORDS[group], ...(FALLBACK_WORDS[group] ?? [])]) {
      facts.set(`${group}:${word}`, await collectWordFacts(pool, refDb, group, word));
    }
  }
  const plan = planWords(GROUP_ORDER, (group, word) => checkPrecondition(group, word, facts.get(`${group}:${word}`)!));
  for (const group of GROUP_ORDER) {
    console.log(`  Nhóm ${group} (${GROUP_TITLES[group]}):`);
    for (const word of [...GROUP_WORDS[group], ...(FALLBACK_WORDS[group] ?? [])]) {
      const pre = checkPrecondition(group, word, facts.get(`${group}:${word}`)!);
      const standIn = (FALLBACK_WORDS[group] ?? []).includes(word) ? ' [dự phòng]' : '';
      console.log(`    ${pre.ok ? 'ĐÚNG ' : 'SAI  '} ${word.padEnd(14)}${standIn.padEnd(12)} ${pre.reason}`);
    }
  }
  console.log(`\nKẾ HOẠCH: chạy ${plan.run.length} từ: ${plan.run.map((p) => `${p.group}:${p.word}${p.standsInFor ? `(thay ${p.standsInFor})` : ''}`).join(', ')}`);
  console.log(`BỎ QUA ${plan.skipped.length} từ (tiền đề sai): ${plan.skipped.map((s) => `${s.group}:${s.word}`).join(', ') || '-'}`);
  console.log(`(${ALL_ACCEPTANCE_WORDS.length} từ gồm cả dự phòng được kiểm tra)`);
  console.log('\nBước tiếp: khởi động ứng dụng (npm run dev, ENRICHMENT_ENABLED=true) rồi  npm run acceptance:lookup -- --base-url http://localhost:3000');
  return prerequisitesOk ? 0 : 1;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`seed:lookup-test failed: [${err?.name ?? 'Error'}] ${err?.message ?? err}`);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
