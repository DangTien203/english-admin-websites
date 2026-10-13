/**
 * Master Migration Runner — with tracking table
 * Chạy: npm run db:migrate
 *
 * Skip migrations đã chạy → chỉ run migration mới.
 * Track qua bảng schema_migrations.
 */

import type { PoolClient } from 'pg';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../config/db';

type MigrationFn = (client: PoolClient) => Promise<void>;

interface MigrationDef {
  name: string;
  file: string;
  /** Unique key dùng để track (không đổi sau khi đã chạy production) */
  key: string;
}

/**
 * QUAN TRỌNG: 
 * - 'key' là identifier UNIQUE cho mỗi migration trong DB.
 * - KHÔNG được thay đổi 'key' sau khi đã chạy production (sẽ bị chạy lại).
 * - 'name' và 'file' có thể đổi tự do.
 */
const migrations: MigrationDef[] = [
  { key: '01_auth_content',           name: 'Domain 1+2: Auth & Content (22 tables)',                  file: './migrations/01_auth_content' },
  { key: '02_learning_srs',           name: 'Domain 3+4: Learning & Retrieval (6 bảng)',               file: './migrations/02_learning_srs' },
  { key: '03_reading_ebook',          name: 'Domain 5: Ebook & TTS (6 bảng)',                          file: './migrations/03_reading_ebook' },
  { key: '04_gaming',                 name: 'Domain 6: Gaming (6 bảng)',                               file: './migrations/04_gaming' },
  { key: '05_commerce',               name: 'Domain 7: Commerce (4 bảng)',                             file: './migrations/05_commerce' },
  { key: '06_ai_sync',                name: 'Domain 8: AI & Sync (6 bảng)',                            file: './migrations/06_ai_sync' },
  { key: '07_system',                 name: 'Domain 9: System (4 bảng)',                               file: './migrations/07_system' },
  { key: '08_indexes',                name: 'Indexes (performance)',                                   file: './migrations/08_indexes' },
  { key: '09_approvals',              name: 'Domain 10: Approvals (1 bảng)',                           file: './migrations/09_approvals' },
  { key: '10_refresh_tokens',         name: 'Domain 11: Refresh Tokens (1 bảng)',                      file: './migrations/10_refresh_tokens' },
  { key: '11_user_saved_words',       name: 'Domain 12: User Saved Words (1 bảng)',                    file: './migrations/11_user_saved_words' },
  { key: '12_dictionary_indexes',     name: 'Dictionary GIN + recency (2 indexes)',                    file: './migrations/12_dictionary_indexes' },
  { key: '13_decks_user_study',       name: 'Phase 4: User decks + study indexes',                     file: './migrations/13_decks_user_study' },
  { key: '14_decks_user_id',          name: 'Phase 4 fix: decks.user_id safety',                       file: './migrations/14_decks_user_id' },
  { key: '15_leitner_rewrite',        name: 'Phase 6 rewrite: leitner_cards + leitner_reviews',        file: './migrations/15_leitner_rewrite' },
  { key: '16_practice_sessions',      name: 'Phase 6: practice_sessions + practice_answers',           file: './migrations/16_practice_sessions' },
  { key: '17_clean_user_card_progress', name: 'Phase 6: clean user_card_progress (drop SRS)',          file: './migrations/17_clean_user_card_progress' },
  { key: '18_payment_methods',        name: 'Phase 7: Payment Methods (2 bảng + admin_note)',          file: './migrations/18_payment_methods' },
  { key: '19_user_subscription_pending', name: 'Phase 7.2: user_subscriptions pending_payment status', file: './migrations/19_user_subscription_pending' },
  { key: '20_paragraphs',             name: 'Phase 9: paragraphs table + reading progress',            file: './migrations/20_paragraphs' },
  { key: '21_user_ebook_favorites',   name: 'Phase 9: user_ebook_favorites table',                     file: './migrations/21_user_ebook_favorites' },
  { key: '21_tts_cache_update',       name: 'TTS cache update (Section A snake_case schema)',          file: './migrations/21_tts_cache_update' },
  { key: '22_retrieval_feature_quotas', name: 'Phase 8: retrieval_practice_daily feature quotas',      file: './migrations/22_retrieval_feature_quotas' },
  { key: '22_tts_cache_recreate',     name: 'TTS cache recreate (drop legacy chapter_id schema)',      file: './migrations/22_tts_cache_recreate' },
  { key: '23_decks_system_flag',      name: 'Phase 10.5: decks.is_system + sort_order',                file: './migrations/23_decks_system_flag' },
  { key: '24_user_deck_favorites',    name: 'Phase 10.5: user_deck_favorites table',                   file: './migrations/24_user_deck_favorites' },
  { key: '25_chapter_tts_progress',   name: 'Phase 9.5: chapter TTS progress tracking',                file: './migrations/25_chapter_tts_progress' },
  { key: '26_word_translation_cache', name: 'Phase 9.6: word_translation_cache + word_lookups fallback fields', file: './migrations/26_word_translation_cache' },
  { key: '27_rename_plan_features',   name: 'Rename plan_features keys to mobile convention + translation_daily quotas', file: './migrations/27_rename_plan_features' },
  { key: '28_user_notifications',     name: 'Phase 11: user_notifications + user_fcm_tokens',          file: './migrations/28_user_notifications' },
  { key: '29_answer_grading',         name: 'Typed Vietnamese answer aliases + semantic grading cache', file: './migrations/29_answer_grading' },
  { key: '30_answer_cache_lang',      name: 'Language dimension for answer_semantic_cache (vi/en)',    file: './migrations/30_answer_cache_lang' },
  { key: '31_leitner_review_sessions', name: 'Leitner review sessions (box 4/5 checked on both meanings)', file: './migrations/31_leitner_review_sessions' },
  { key: '32_leitner_session_box',    name: 'Leitner review sessions can target one box',              file: './migrations/32_leitner_session_box' },
];

/**
 * Tạo bảng tracking nếu chưa có.
 * Bảng này lưu lại migration nào đã chạy thành công.
 */
async function ensureTrackingTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      key varchar(100) PRIMARY KEY,
      name varchar(200) NOT NULL,
      checksum varchar(64),
      executed_at timestamptz NOT NULL DEFAULT now(),
      duration_ms int
    );
  `);
}

/**
 * Trả về Set các migration keys đã chạy.
 */
async function getExecutedKeys(client: PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ key: string }>(
    `SELECT key FROM schema_migrations`
  );
  return new Set(rows.map(r => r.key));
}

/**
 * Tính checksum của file migration (để detect khi anh sửa migration cũ — sẽ warning).
 */
function computeChecksum(filePath: string): string | null {
  try {
    const fullPath = path.resolve(__dirname, filePath + '.ts');
    if (!fs.existsSync(fullPath)) return null;
    const content = fs.readFileSync(fullPath, 'utf-8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

export const migrate = async (): Promise<void> => {
  const client = await pool.connect();
  const startTime = Date.now();

  try {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   English Learning App — DB Migration    ║');
    console.log('╚══════════════════════════════════════════╝\n');

    // Extension — auto-commit (ngoài transaction).
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    console.log('[✓] Extension uuid-ossp');

    // Setup tracking table.
    await ensureTrackingTable(client);
    await seedExistingMigrationsIfFreshTable(client);
    const executed = await getExecutedKeys(client);
    console.log(`[i] Đã chạy trước đó: ${executed.size}/${migrations.length} migrations\n`);

    let ranCount = 0;
    let skippedCount = 0;

    for (const m of migrations) {
      // SKIP nếu đã chạy.
      if (executed.has(m.key)) {
        console.log(`⊘ SKIP   ${m.key.padEnd(35)} — already executed`);
        skippedCount++;
        continue;
      }

      // CHẠY migration mới.
      console.log(`▶ RUN    ${m.key.padEnd(35)} — ${m.name}`);
      const fn = require(m.file) as MigrationFn;
      const checksum = computeChecksum(m.file);
      const t0 = Date.now();

      await client.query('BEGIN');
      try {
        await fn(client);
        const duration = Date.now() - t0;

        // Track lại migration đã chạy thành công.
        await client.query(
          `INSERT INTO schema_migrations (key, name, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [m.key, m.name, checksum, duration]
        );

        await client.query('COMMIT');
        console.log(`✓ DONE   ${m.key.padEnd(35)} — ${duration}ms\n`);
        ranCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`\n❌ Failed: ${m.key} — ${m.name}`);
        throw err;
      }
    }

    // Đếm bảng final.
    const { rows } = await pool.query<{ count: number }>(`
      SELECT COUNT(*)::int as count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);

    const totalDuration = Date.now() - startTime;
    console.log('══════════════════════════════════════════');
    console.log(`✅ Migration hoàn tất trong ${totalDuration}ms`);
    console.log(`   Ran: ${ranCount}  |  Skipped: ${skippedCount}  |  Tables: ${rows[0].count}`);
    console.log('══════════════════════════════════════════');

  } catch (err) {
    const error = err as Error;
    console.error('\n❌ Migration thất bại:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

if (require.main === module) {
  migrate();
}

/**
 * Seed lần đầu: nếu schema_migrations rỗng NHƯNG đã có bảng users
 * (= production cũ đã chạy migrations rồi), thì mark TẤT CẢ migrations
 * trong list là 'đã chạy' để tránh re-run lãng phí.
 *
 * Chỉ chạy 1 lần duy nhất khi anh deploy code mới này lần đầu.
 */
async function seedExistingMigrationsIfFreshTable(client: PoolClient): Promise<void> {
  // Check schema_migrations rỗng?
  const { rows: countRows } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM schema_migrations`
  );
  if (countRows[0].count > 0) return; // Đã seed rồi → bỏ qua.

  // Check users table tồn tại? (proxy cho "DB đã có data từ migration cũ")
  const { rows: tableRows } = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
    ) as exists
  `);
  if (!tableRows[0].exists) {
    // DB hoàn toàn rỗng → fresh setup, không cần seed.
    console.log('[i] Fresh database — sẽ chạy tất cả migrations.\n');
    return;
  }

  // DB cũ + tracking table rỗng → seed all migrations as executed.
  console.log('[!] Phát hiện DB cũ chưa có tracking. Seeding...');
  for (const m of migrations) {
    await client.query(
      `INSERT INTO schema_migrations (key, name, executed_at, duration_ms)
       VALUES ($1, $2, now(), 0)
       ON CONFLICT (key) DO NOTHING`,
      [m.key, m.name]
    );
  }
  console.log(`[✓] Seeded ${migrations.length} migrations (mark as already executed).\n`);
}
