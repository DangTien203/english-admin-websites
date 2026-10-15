/**
 * Backfill total_chapters + total_words for ebooks that were seeded/inserted
 * without those computed columns.
 *
 * Safe to re-run — skips ebooks where both values are already > 0.
 *
 * Usage:
 *   tsx scripts/backfill-ebook-counts.ts [--dry-run]
 */
import 'dotenv/config';
import pool from '../config/db';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const client = await pool.connect();
  try {
    // Find ebooks missing totals
    const { rows: ebooks } = await client.query<{ id: string; title: string }>(
      `SELECT id, title FROM ebooks
       WHERE total_chapters IS NULL OR total_words IS NULL
          OR total_chapters = 0   OR total_words = 0
       ORDER BY created_at ASC`
    );

    if (ebooks.length === 0) {
      console.log('All ebooks already have totals. Nothing to backfill.');
      return;
    }

    console.log(`Found ${ebooks.length} ebook(s) to backfill${dryRun ? ' [dry-run]' : ''}:\n`);

    for (const ebook of ebooks) {
      // Count chapters
      const { rows: [{ chapter_count }] } = await client.query<{ chapter_count: string }>(
        `SELECT COUNT(*) AS chapter_count FROM chapters WHERE ebook_id = $1`,
        [ebook.id]
      );

      // Sum word counts from paragraphs (more accurate than chapters.word_count)
      const { rows: [{ word_count }] } = await client.query<{ word_count: string }>(
        `SELECT COALESCE(SUM(p.word_count), 0) AS word_count
         FROM paragraphs p
         JOIN chapters c ON c.id = p.chapter_id
         WHERE c.ebook_id = $1`,
        [ebook.id]
      );

      // Fallback to chapters.word_count if no paragraphs exist yet
      const { rows: [{ chapter_words }] } = await client.query<{ chapter_words: string }>(
        `SELECT COALESCE(SUM(word_count), 0) AS chapter_words
         FROM chapters WHERE ebook_id = $1`,
        [ebook.id]
      );

      const totalChapters = parseInt(chapter_count, 10);
      const totalWords    = parseInt(word_count, 10) > 0
        ? parseInt(word_count, 10)
        : parseInt(chapter_words, 10);

      console.log(`  "${ebook.title}" → chapters: ${totalChapters}, words: ${totalWords}`);

      if (!dryRun) {
        await client.query(
          `UPDATE ebooks SET total_chapters = $1, total_words = $2 WHERE id = $3`,
          [totalChapters, totalWords, ebook.id]
        );
      }
    }

    // Also backfill chapters.word_count = 0 from their paragraphs
    const { rows: emptyChapters } = await client.query<{ id: string; title: string; ebook_id: string }>(
      `SELECT c.id, c.title, c.ebook_id FROM chapters c
       WHERE c.word_count IS NULL OR c.word_count = 0`
    );

    if (emptyChapters.length > 0) {
      console.log(`\nBackfilling word_count for ${emptyChapters.length} chapter(s)...`);
      for (const ch of emptyChapters) {
        const { rows: [{ wc }] } = await client.query<{ wc: string }>(
          `SELECT COALESCE(SUM(word_count), 0) AS wc FROM paragraphs WHERE chapter_id = $1`,
          [ch.id]
        );
        const chWords = parseInt(wc, 10);
        console.log(`  "${ch.title}" → ${chWords} words`);
        if (!dryRun && chWords > 0) {
          await client.query(
            `UPDATE chapters SET word_count = $1 WHERE id = $2`,
            [chWords, ch.id]
          );
        }
      }
    }

    if (!dryRun) {
      console.log('\n✅ Backfill complete.');
    } else {
      console.log('\n[dry-run] No changes written.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
