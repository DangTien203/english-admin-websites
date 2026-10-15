/**
 * CLI: Parse EPUB file → segment paragraphs → INSERT into DB.
 *
 * Usage:
 *   tsx scripts/ingest-ebook.ts <path-to-epub> [--level beginner|intermediate|advanced]
 *                               [--plan free|premium|pro] [--dry-run]
 *
 * Requires epub2 (npm i epub2).
 */
import 'dotenv/config';
import path from 'path';
import pool from '../config/db';
import { segmentParagraphs, countWords } from '../utils/paragraphSegmenter';

// epub2 ships its own types
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EPub } = require('epub2') as typeof import('epub2');

// ─────────────────────────────────────────────────────────────────────────────
//  CLI args
// ─────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const epubPath = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const levelArg = args[args.indexOf('--level') + 1] as string | undefined;
const planArg = args[args.indexOf('--plan') + 1] as string | undefined;

const VALID_LEVELS = ['beginner', 'intermediate', 'advanced'];
const VALID_PLANS = ['free', 'premium', 'pro'];

if (!epubPath) {
  console.error('Usage: tsx scripts/ingest-ebook.ts <path.epub> [--level ...] [--plan ...] [--dry-run]');
  process.exit(1);
}

const level = VALID_LEVELS.includes(levelArg ?? '') ? levelArg! : 'intermediate';
const required_plan = VALID_PLANS.includes(planArg ?? '') ? planArg! : 'free';

// ─────────────────────────────────────────────────────────────────────────────
//  Strip HTML tags from chapter content
// ─────────────────────────────────────────────────────────────────────────────
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const absPath = path.resolve(epubPath!);
  console.log(`\nParsing EPUB: ${absPath}`);

  // Parse EPUB
  const epub = await EPub.createAsync(absPath);

  const { title, creator: author } = epub.metadata;
  const chapters = epub.flow.filter((ch) => ch.id);

  console.log(`Title:   ${title ?? '(unknown)'}`);
  console.log(`Author:  ${author ?? '(unknown)'}`);
  console.log(`Chapters found: ${chapters.length}`);

  if (dryRun) {
    console.log('\n[dry-run] Would insert ebook + chapters + paragraphs. No DB changes.');
    let totalParagraphs = 0;
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const html = await epub.getChapterAsync(ch.id!);
      const text = stripHtml(html);
      if (!text.trim()) continue;
      const paragraphs = segmentParagraphs(text);
      totalParagraphs += paragraphs.length;
      console.log(`  [${i}] "${ch.title ?? 'Untitled'}" → ${paragraphs.length} paragraphs`);
    }
    console.log(`\nTotal paragraphs: ${totalParagraphs}`);
    process.exit(0);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find super_admin for created_by
    const { rows: adminRows } = await client.query(
      `SELECT id FROM admin_accounts WHERE role = 'super_admin' LIMIT 1`
    );
    const createdBy: string | null = adminRows[0]?.id ?? null;

    // Insert ebook
    const { rows: [ebook] } = await client.query(
      `INSERT INTO ebooks (title, author, level, required_plan, status, created_by, epub_file_url)
       VALUES ($1, $2, $3, $4, 'published', $5, $6)
       RETURNING id`,
      [
        title ?? 'Untitled',
        author ?? 'Unknown',
        level,
        required_plan,
        createdBy,
        absPath,
      ]
    );

    console.log(`\nInserted ebook: ${ebook.id}`);

    let chapterIndex = 0;
    let totalWordCount = 0;
    let totalParagraphs = 0;

    for (const ch of chapters) {
      const html = await epub.getChapterAsync(ch.id!);
      const text = stripHtml(html);

      if (!text.trim()) continue; // skip empty chapters (nav, cover, etc.)

      const paragraphs = segmentParagraphs(text);
      if (paragraphs.length === 0) continue;

      const chapterWordCount = paragraphs.reduce((sum, p) => sum + countWords(p), 0);
      totalWordCount += chapterWordCount;

      const { rows: [chapter] } = await client.query(
        `INSERT INTO chapters (ebook_id, chapter_index, title, word_count, content_html)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [ebook.id, chapterIndex, ch.title ?? `Chapter ${chapterIndex + 1}`, chapterWordCount, html]
      );

      for (let pi = 0; pi < paragraphs.length; pi++) {
        const paraText = paragraphs[pi];
        await client.query(
          `INSERT INTO paragraphs (chapter_id, paragraph_index, text, word_count)
           VALUES ($1, $2, $3, $4)`,
          [chapter.id, pi, paraText, countWords(paraText)]
        );
      }

      console.log(`  [${chapterIndex}] "${ch.title ?? 'Untitled'}" — ${paragraphs.length} paragraphs, ${chapterWordCount} words`);
      chapterIndex++;
      totalParagraphs += paragraphs.length;
    }

    // Update totals
    await client.query(
      `UPDATE ebooks SET total_chapters = $1, total_words = $2 WHERE id = $3`,
      [chapterIndex, totalWordCount, ebook.id]
    );

    await client.query('COMMIT');
    console.log(`\n✅ Ingested ${chapterIndex} chapters, ${totalParagraphs} paragraphs, ${totalWordCount} words.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Ingest failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
