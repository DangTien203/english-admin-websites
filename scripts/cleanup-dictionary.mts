// ══════════════════════════════════════════════════════════════
//  CLEANUP DICTIONARY — Dọn sạch dữ liệu từ điển cũ
// ══════════════════════════════════════════════════════════════
//
//  Chạy LOCAL:   npx tsx scripts/cleanup-dictionary.mts
//  Chạy RAILWAY: railway run npx tsx scripts/cleanup-dictionary.mts
//
//  Script này xóa:
//    1. Toàn bộ Dictionary Pro tables (senses, forms, idioms...)
//    2. Legacy data (entry_tags, entry_synonyms, entry_antonyms)
//    3. Toàn bộ dictionary_entries
//    4. Tags (vì entry_tags sẽ trống)
//
//  SAU KHI CHẠY: DB sạch hoàn toàn, sẵn sàng import mới.

import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'english_learning_app',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  🧹 CLEANUP DICTIONARY — Dọn sạch dữ liệu cũ');
  console.log('═══════════════════════════════════════════════════\n');

  const client = await pool.connect();

  try {
    // Đếm trước khi xóa
    const { rows: [before] } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM dictionary_entries) AS entries,
        (SELECT COUNT(*) FROM entry_senses) AS senses,
        (SELECT COUNT(*) FROM sense_examples) AS examples,
        (SELECT COUNT(*) FROM word_forms) AS forms,
        (SELECT COUNT(*) FROM phrasal_verbs) AS phrasal,
        (SELECT COUNT(*) FROM entry_idioms) AS idioms,
        (SELECT COUNT(*) FROM collocations) AS colloc,
        (SELECT COUNT(*) FROM sense_synonyms) AS syn,
        (SELECT COUNT(*) FROM sense_antonyms) AS ant
    `);

    console.log('  Trước khi xóa:');
    console.log(`    dictionary_entries : ${before.entries}`);
    console.log(`    entry_senses       : ${before.senses}`);
    console.log(`    sense_examples     : ${before.examples}`);
    console.log(`    word_forms         : ${before.forms}`);
    console.log(`    phrasal_verbs      : ${before.phrasal}`);
    console.log(`    entry_idioms       : ${before.idioms}`);
    console.log(`    collocations       : ${before.colloc}`);
    console.log(`    sense_synonyms     : ${before.syn}`);
    console.log(`    sense_antonyms     : ${before.ant}`);
    console.log('');

    // Xóa theo thứ tự FK (con trước, cha sau)
    const tables = [
      'sense_examples', 'sense_synonyms', 'sense_antonyms',
      'entry_senses', 'word_forms', 'phrasal_verbs',
      'entry_idioms', 'collocations',
      'word_family_members', 'word_families',
      'entry_tags', 'entry_synonyms', 'entry_antonyms',
      'entry_edit_history',
      // Các bảng khác reference dictionary_entries
      'lesson_entries',
    ];

    for (const t of tables) {
      try {
        const { rowCount } = await client.query(`DELETE FROM ${t}`);
        if (rowCount && rowCount > 0) console.log(`  ✓ ${t}: ${rowCount} rows deleted`);
      } catch (err: any) {
        // Bảng không tồn tại → bỏ qua
        if (!err.message.includes('does not exist')) throw err;
      }
    }

    // Xóa dictionary_entries (sau khi con đã xóa hết)
    const { rowCount } = await client.query('DELETE FROM dictionary_entries');
    console.log(`  ✓ dictionary_entries: ${rowCount} rows deleted`);

    // Xóa tags
    const { rowCount: tagCount } = await client.query('DELETE FROM tags');
    console.log(`  ✓ tags: ${tagCount} rows deleted`);

    console.log('\n  ✅ Dọn sạch hoàn tất! DB sẵn sàng import mới.\n');

  } catch (err: any) {
    console.error('\n  ❌ Lỗi:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
