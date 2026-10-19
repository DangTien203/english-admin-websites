/**
 * Smart Reset Database
 *
 * Chạy:
 *   npm run db:reset             → Reset CẤU TRÚC (giữ nguyên dictionary content)
 *   tsx database/reset.ts -- --all → Reset TOÀN BỘ (xóa sạch mọi thứ)
 *
 * Cách hoạt động:
 *   0. Chốt an toàn (scripts/seedGuard.ts, dùng chung với db:seed): in cơ sở dữ liệu và những gì sẽ bị xóa, TRƯỚC KHI mở kết nối;
 *      từ chối khi NODE_ENV=production hoặc cơ sở dữ liệu không nằm trên máy này, trừ khi có --i-know-this-wipes-tables
 *   1. Xác định mode (selective vs all)
 *   2. Nếu selective: drop tất cả NGOẠI TRỪ content tables (danh sách bảng cụ thể được in trước khi xóa)
 *   3. Chạy migrate (CREATE IF NOT EXISTS → an toàn cho bảng đã tồn tại)
 *   4. Nếu all: chạy migrate trên DB trống
 *
 * `npm run db:fresh` = reset + seed: npm chỉ đưa tham số thêm cho lệnh CUỐI, nên cờ không tới được bước reset. Trên cơ sở dữ liệu
 * không nằm trên máy này, chạy hai lệnh riêng (`db:reset -- <cờ>` rồi `db:seed -- <cờ>`).
 */
import type { PoolClient } from 'pg';
import pool from '../config/db';
import { guardReset } from '../scripts/seedGuard';
import { migrate } from './migrate';

// Các bảng nội dung từ điển — được bảo vệ khi selective reset
export const PROTECTED_TABLES: string[] = [
  // ── Legacy content ──
  'tags',
  'dictionary_entries',
  'entry_tags',
  'entry_synonyms',
  'entry_antonyms',
  // ── Dictionary Pro (multi-sense) ──
  'entry_senses',
  'sense_examples',
  'word_forms',
  'entry_idioms',
  'phrasal_verbs',
  'collocations',
  'sense_synonyms',
  'sense_antonyms',
  'word_families',
  'word_family_members',
];

const reset = async (): Promise<void> => {
  const isFullReset = process.argv.includes('--all');
  let client: PoolClient | null = null;

  // The safety latch comes FIRST: before a connection is taken and before anything is dropped.
  if (!guardReset(process.argv.slice(2), process.env, { all: isFullReset, kept: PROTECTED_TABLES }, (line) => console.log(line))) {
    await pool.end().catch(() => undefined);
    process.exit(1);
  }

  try {
    client = await pool.connect();

    if (isFullReset) {
      // ── FULL RESET: xóa tất cả ──
      console.log('╔══════════════════════════════════════════╗');
      console.log('║   ⚠  FULL RESET — XÓA TOÀN BỘ          ║');
      console.log('╚══════════════════════════════════════════╝\n');

      const { rows: everyTable } = await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
      console.log(`  Sẽ xóa ${everyTable.length} bảng: ${everyTable.map((t) => t.tablename).join(', ') || '(không có)'}\n`);

      await client.query(`
        DO $$ DECLARE r RECORD;
        BEGIN
          FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
            EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
          END LOOP;
        END $$;
      `);
      console.log('[✓] Đã xóa TOÀN BỘ tables\n');

    } else {
      // ── SELECTIVE RESET: giữ content tables ──
      console.log('╔══════════════════════════════════════════╗');
      console.log('║   Reset — Giữ nguyên Dictionary content  ║');
      console.log('╚══════════════════════════════════════════╝\n');

      console.log('  Bảng được bảo vệ:');
      for (const t of PROTECTED_TABLES) {
        const { rows } = await client.query<{ exists: boolean }>(`
          SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1)
        `, [t]);
        const count = rows[0].exists
          ? (await client.query<{ c: number }>(`SELECT COUNT(*)::int as c FROM ${t}`)).rows[0].c
          : 0;
        console.log(`    ✓ ${t} (${count} rows → giữ nguyên)`);
      }
      console.log('');

      // Lấy danh sách tất cả tables, loại trừ protected
      const { rows: allTables } = await client.query<{ tablename: string }>(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename != ALL($1)
        ORDER BY tablename
      `, [PROTECTED_TABLES]);

      if (allTables.length === 0) {
        console.log('  Không có bảng nào cần xóa.\n');
      } else {
        console.log(`  Sẽ xóa ${allTables.length} bảng: ${allTables.map((t) => t.tablename).join(', ')}\n`);
        // Drop từng bảng không protected (CASCADE để xóa FK dependencies)
        for (const { tablename } of allTables) {
          await client.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
        }
        console.log(`[✓] Đã xóa ${allTables.length} bảng (giữ ${PROTECTED_TABLES.length} bảng content)\n`);
      }
    }

    // Giải phóng client trước khi gọi migrate (migrate sẽ tự connect lại + end pool)
    client.release();
    client = null;

    // Chạy migrate (CREATE IF NOT EXISTS → an toàn cho bảng đã tồn tại)
    console.log('── Chạy Migration ──\n');
    await migrate();

  } catch (err) {
    const error = err as Error;
    console.error('❌ Reset thất bại:', error.message);
    if (client) {
      try { client.release(); } catch { /* ignore */ }
    }
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(1);
  }
};

// Importing this file (as the tests do, to read PROTECTED_TABLES) must drop nothing: only the program that was started runs it.
if (require.main === module) void reset();
