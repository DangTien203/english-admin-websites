/**
 * EXTRACT PDF → JSON cho import ebook
 *
 * Chạy:  npx tsx scripts/extract-pdf-ebook.mts <file.pdf>
 * VD:    npx tsx scripts/extract-pdf-ebook.mts "P:/Books/Harry Potter.pdf"
 *
 * Output: scripts/ebook-data/<tên-sách>.json
 *
 * Script tự phát hiện chapters bằng regex. SAU KHI CHẠY:
 *   → Mở file JSON, kiểm tra xem chapters đã đúng chưa
 *   → Sửa title, author, level nếu cần
 *   → Xóa/gộp chapters nếu bị tách sai
 */
import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// pdf-parse là CommonJS module — dùng createRequire trong ESM context
const require   = createRequire(import.meta.url);
const pdfParse  = require('pdf-parse') as (buf: Buffer) => Promise<{ numpages: number; text: string }>;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ══════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════

const OUTPUT_DIR = path.resolve(__dirname, 'ebook-data');

// Regex patterns để phát hiện chapter headings
const CHAPTER_PATTERNS = [
  /^chapter\s+(\d+)/i,                         // Chapter 1, Chapter 12
  /^chapter\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)/i,
  /^chương\s+(\d+)/i,                           // Chương 1 (Vietnamese)
  /^part\s+(\d+)/i,                              // Part 1
  /^section\s+(\d+)/i,                           // Section 1
  /^lesson\s+(\d+)/i,                            // Lesson 1
  /^unit\s+(\d+)/i,                              // Unit 1
  /^(\d+)\.\s+[A-Z]/,                            // 1. Title (numbered heading)
  /^CHAPTER\s+/,                                  // CHAPTER (all caps)
];

function isChapterHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 200) return false;
  return CHAPTER_PATTERNS.some(p => p.test(trimmed));
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

// ══════════════════════════════════════════════════════════════
//  EXTRACT
// ══════════════════════════════════════════════════════════════

interface ChapterData {
  chapter_index: number;
  title: string;
  paragraphs: string[];
  word_count: number;
}

interface EbookData {
  title: string;
  author: string;
  description: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  genre: string[];
  required_plan: 'free' | 'premium' | 'pro';
  status: 'published';
  total_chapters: number;
  total_words: number;
  chapters: ChapterData[];
}

async function extractPdf(filePath: string): Promise<EbookData> {
  console.log(`\n📖 Đọc PDF: ${filePath}\n`);

  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);

  console.log(`  Pages: ${data.numpages}`);
  console.log(`  Raw text length: ${data.text.length} chars`);

  // Tách text thành các dòng
  const rawLines = data.text.split('\n');
  console.log(`  Raw lines: ${rawLines.length}`);

  // Clean lines: bỏ dòng trống thừa, bỏ page numbers
  const lines = rawLines
    .map(l => l.trim())
    .filter(l => {
      if (!l) return false;
      // Bỏ page numbers đơn lẻ
      if (/^\d+$/.test(l)) return false;
      // Bỏ dòng quá ngắn (header/footer PDF)
      if (l.length < 3) return false;
      return true;
    });

  console.log(`  Clean lines: ${lines.length}`);

  // ── Phát hiện chapters ──
  const chapters: ChapterData[] = [];
  let currentChapter: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (isChapterHeading(line)) {
      // Lưu chapter cũ
      if (currentChapter && currentChapter.lines.length > 0) {
        chapters.push(buildChapter(currentChapter, chapters.length));
      }
      currentChapter = { title: line.trim(), lines: [] };
    } else if (currentChapter) {
      currentChapter.lines.push(line);
    } else {
      // Chưa gặp chapter heading → gom vào "Introduction"
      if (!currentChapter) {
        currentChapter = { title: 'Introduction', lines: [] };
      }
      currentChapter.lines.push(line);
    }
  }

  // Lưu chapter cuối
  if (currentChapter && currentChapter.lines.length > 0) {
    chapters.push(buildChapter(currentChapter, chapters.length));
  }

  // Nếu không phát hiện được chapter nào → toàn bộ text = 1 chapter
  if (chapters.length === 0) {
    console.log('\n  ⚠️ Không phát hiện được chapter headings!');
    console.log('  → Tạo 1 chapter duy nhất chứa toàn bộ nội dung.');
    console.log('  → Bạn có thể tách thủ công trong file JSON.\n');

    const allText = lines.join('\n');
    const paragraphs = segmentIntoParagraphs(allText);
    chapters.push({
      chapter_index: 0,
      title: 'Full Text',
      paragraphs,
      word_count: paragraphs.reduce((s, p) => s + countWords(p), 0),
    });
  }

  const totalWords = chapters.reduce((s, c) => s + c.word_count, 0);
  const fileName = path.basename(filePath, path.extname(filePath));

  const ebook: EbookData = {
    title: fileName,
    author: 'Unknown Author',
    description: `Imported from ${path.basename(filePath)}`,
    level: 'intermediate',
    genre: ['general'],
    required_plan: 'free',
    status: 'published',
    total_chapters: chapters.length,
    total_words: totalWords,
    chapters,
  };

  console.log(`\n  ✅ Phát hiện ${chapters.length} chapters, ${totalWords} words tổng\n`);
  for (const ch of chapters) {
    console.log(`    Ch ${ch.chapter_index}: "${ch.title}" — ${ch.paragraphs.length} đoạn, ${ch.word_count} words`);
  }

  return ebook;
}

function buildChapter(raw: { title: string; lines: string[] }, index: number): ChapterData {
  const fullText = raw.lines.join('\n');
  const paragraphs = segmentIntoParagraphs(fullText);
  return {
    chapter_index: index,
    title: raw.title,
    paragraphs,
    word_count: paragraphs.reduce((s, p) => s + countWords(p), 0),
  };
}

function segmentIntoParagraphs(text: string): string[] {
  // Tách bằng dòng trống (double newline)
  const raw = text.split(/\n\s*\n/);
  const result: string[] = [];

  for (const block of raw) {
    const cleaned = block.replace(/\s+/g, ' ').trim();
    if (cleaned.length < 10) continue; // Bỏ đoạn quá ngắn

    // Nếu đoạn quá dài (>500 words) → tách theo câu
    if (countWords(cleaned) > 500) {
      const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
      let chunk = '';
      for (const sent of sentences) {
        if (countWords(chunk + ' ' + sent) > 200) {
          if (chunk.trim()) result.push(chunk.trim());
          chunk = sent;
        } else {
          chunk += ' ' + sent;
        }
      }
      if (chunk.trim()) result.push(chunk.trim());
    } else {
      result.push(cleaned);
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════

async function main() {
  const pdfPath = process.argv[2];

  if (!pdfPath) {
    console.log('');
    console.log('Cách dùng:');
    console.log('  npx tsx scripts/extract-pdf-ebook.mts "đường-dẫn/file.pdf"');
    console.log('');
    console.log('Ví dụ:');
    console.log('  npx tsx scripts/extract-pdf-ebook.mts "P:/Books/The Great Gatsby.pdf"');
    console.log('  npx tsx scripts/extract-pdf-ebook.mts "./ebooks/Harry Potter.pdf"');
    console.log('');
    process.exit(1);
  }

  if (!fs.existsSync(pdfPath)) {
    console.error(`❌ File không tồn tại: ${pdfPath}`);
    process.exit(1);
  }

  // Tạo output dir
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const ebook = await extractPdf(pdfPath);

  // Lưu JSON
  const fileName = slugify(ebook.title);
  const outputPath = path.join(OUTPUT_DIR, `${fileName}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(ebook, null, 2), 'utf-8');

  console.log(`\n📁 Đã lưu: ${outputPath}`);
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  BƯỚC TIẾP THEO:                                      ║');
  console.log('║  1. Mở file JSON, kiểm tra chapters đã đúng chưa      ║');
  console.log('║  2. Sửa title, author, level, genre nếu cần           ║');
  console.log('║  3. Chạy: npx tsx scripts/import-ebook.mts            ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
}

main().catch(console.error);
