/**
 * Dọn sạch toàn bộ dữ liệu Ebook — ebooks, chapters, paragraphs
 *
 * Chạy LOCAL:    npx tsx scripts/cleanup-ebooks.mts
 * Chạy RAILWAY:  railway run npx tsx scripts/cleanup-ebooks.mts
 */
import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'english_learning_app',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  ssl:      process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  🧹 CLEANUP EBOOKS — Dọn sạch dữ liệu ebook cũ');
  console.log('═══════════════════════════════════════════════════\n');

  const client = await pool.connect();

  try {
    // Đếm trước khi xóa (COUNT(*) trả về bigint → node-pg convert sang string)
    const { rows: [before] } = await client.query<{
      ebooks: string;
      chapters: string;
      paragraphs: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM ebooks) AS ebooks,
        (SELECT COUNT(*) FROM chapters) AS chapters,
        (SELECT COUNT(*) FROM paragraphs) AS paragraphs
    `);

    console.log('  Trước khi xóa:');
    console.log(`    ebooks     : ${before.ebooks}`);
    console.log(`    chapters   : ${before.chapters}`);
    console.log(`    paragraphs : ${before.paragraphs}`);
    console.log('');

    // Xóa theo thứ tự FK: con trước, cha sau
    const tables = [
      'tts_cache',
      'word_lookups',
      'user_reading_progress',
      'ebook_glossary',
      'paragraphs',
      'chapters',
      'ebooks',
    ];

    for (const t of tables) {
      try {
        const { rowCount } = await client.query(`DELETE FROM ${t}`);
        if (rowCount && rowCount > 0) console.log(`  ✓ ${t}: ${rowCount} rows deleted`);
      } catch (err: any) {
        if (!err.message.includes('does not exist')) throw err;
      }
    }

    console.log('\n  ✅ Dọn sạch hoàn tất! Sẵn sàng import lại.\n');

  } catch (err: any) {
    console.error('\n  ❌ Lỗi:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
