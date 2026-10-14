// scripts/import-oxford.mjs
// Import Oxford 5000 JSON vào PostgreSQL + Dịch nghĩa VI bằng Claude Haiku
//
// Chạy: node scripts/import-oxford.mjs
//
// Prerequisites:
//   - File .env có đủ biến (xem phần CẤU HÌNH bên dưới)
//   - Đã clone repo oxford-5000-vocabulary-audio-definition
//   - Đã giải nén audio files vào thư mục audio/
//   - Đã tạo bảng dictionary_entries trong PostgreSQL

import 'dotenv/config';
import fs        from 'fs';
import path      from 'path';
import { fileURLToPath } from 'url';
import pg        from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ══════════════════════════════════════════════════════════════
//  CẤU HÌNH — Chỉnh sửa phần này cho đúng với môi trường của bạn
// ══════════════════════════════════════════════════════════════

const DB_CONFIG = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'your_database',  // ← đổi lại
  user:     process.env.DB_USER     || 'your_user',       // ← đổi lại
  password: process.env.DB_PASSWORD || 'your_password',   // ← đổi lại
};

// Đường dẫn tới repo oxford đã clone
// Ví dụ: '../oxford-5000-vocabulary-audio-definition'
const REPO_DIR = path.resolve(
  __dirname,
  '../oxford-5000-vocabulary-audio-definition'  // ← đổi lại nếu clone ở chỗ khác
);

const OXFORD_JSON = path.join(REPO_DIR, 'data/oxford_5000.json');
const AUDIO_DIR   = path.join(REPO_DIR, 'audio'); // thư mục đã giải nén *.mp3

// File backup để resume nếu script bị ngắt giữa chừng
const TRANSLATION_CACHE_FILE = path.resolve(__dirname, '../.translation-cache.json');

// Số từ dịch mỗi lần gọi API (tối ưu giữa cost & chất lượng)
const TRANSLATE_BATCH_SIZE = 20;

// Delay giữa các batch dịch (ms) — tránh rate limit
const TRANSLATE_DELAY_MS = 300;

// ══════════════════════════════════════════════════════════════
//  KHỞI TẠO CLIENTS
// ══════════════════════════════════════════════════════════════

const pool = new pg.Pool(DB_CONFIG);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ══════════════════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const time = new Date().toLocaleTimeString('vi-VN');
  console.log(`[${time}] ${msg}`);
}

function loadTranslationCache() {
  try {
    if (fs.existsSync(TRANSLATION_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(TRANSLATION_CACHE_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveTranslationCache(cache) {
  fs.writeFileSync(TRANSLATION_CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ══════════════════════════════════════════════════════════════
//  PARSE: Oxford JSON → DB fields
// ══════════════════════════════════════════════════════════════

function parseEntry(item) {
  const headword = item.word?.trim().toLowerCase();
  if (!headword) return null;

  // type → pos array: "indefinite article" → ["indefinite article"]
  const pos = item.type?.trim() ? [item.type.trim()] : [];

  // cefr: "a1" → "A1" (uppercase cho CHECK constraint)
  const cefr_level = item.cefr?.trim().toUpperCase() || null;

  // IPA: phon_br = UK, phon_n_am = US
  const ipa_uk = item.phon_br?.trim()    || null;
  const ipa_us = item.phon_n_am?.trim()  || null;

  // Definition & Example
  const meaning_en = item.definition?.trim() || null;
  const example_en = item.example?.trim()    || null;

  // Audio files: kiểm tra file tồn tại
  const ukFile = item.uk ? path.join(AUDIO_DIR, item.uk) : null;
  const usFile = item.us ? path.join(AUDIO_DIR, item.us) : null;
  const audio_uk_url = ukFile && fs.existsSync(ukFile) ? ukFile : null;
  const audio_us_url = usFile && fs.existsSync(usFile) ? usFile : null;

  return {
    headword,
    lemma: headword,  // lemma = headword (lowercase)
    pos,
    cefr_level,
    ipa_uk,
    ipa_us,
    audio_uk_url,
    audio_us_url,
    meaning_en,
    example_en,
  };
}

// ══════════════════════════════════════════════════════════════
//  CLAUDE HAIKU — DỊCH BATCH (20 TỪ / LẦN)
// ══════════════════════════════════════════════════════════════

// System prompt chuyên biệt cho từ điển Anh-Việt
const TRANSLATION_SYSTEM_PROMPT = `Bạn là chuyên gia biên soạn từ điển Anh-Việt chuyên nghiệp, chuẩn mực như từ điển Oxford Learner's Dictionary phiên bản tiếng Việt.

NHIỆM VỤ: Dịch định nghĩa (meaning) và câu ví dụ (example) từ tiếng Anh sang tiếng Việt.

NGUYÊN TẮC DỊCH:
1. Định nghĩa (meaning):
   - Dịch cô đọng, súc tích — không dài dòng
   - Dùng ngôn ngữ từ điển chuẩn mực (không nói chuyện, không khẩu ngữ)
   - Giữ chính xác nghĩa gốc, không thêm/bớt ý
   - Thuật ngữ chuyên ngành: dùng thuật ngữ tiếng Việt tương đương
   - Từ hư/ngữ pháp (article, preposition...): dịch theo chức năng ngữ pháp

2. Câu ví dụ (example):
   - Dịch tự nhiên, đúng ngữ cảnh — không dịch từng chữ
   - Giữ nguyên ý nghĩa và sắc thái
   - Nếu example là cụm từ ngắn (vd: "a man/horse/unit"), dịch linh hoạt

3. TUYỆT ĐỐI KHÔNG:
   - Không thêm giải thích ngoài lề
   - Không dùng dấu ngoặc đơn để giải thích thêm
   - Không để trống (nếu không có example thì trả về null)

OUTPUT: Chỉ trả về JSON thuần túy, không có markdown, không có giải thích.`;

async function translateBatch(items, retryCount = 0) {
  // items = [{idx, headword, pos, cefr, meaning_en, example_en}, ...]

  const inputJson = items.map((item, i) => ({
    idx:        i,
    word:       item.headword,
    pos:        item.pos?.[0] || '',
    cefr:       item.cefr_level || '',
    meaning_en: item.meaning_en || '',
    example_en: item.example_en || null,
  }));

  const userPrompt = `Dịch các từ sau sang tiếng Việt.

INPUT:
${JSON.stringify(inputJson, null, 2)}

OUTPUT FORMAT (JSON array, giữ đúng thứ tự idx):
[
  {
    "idx": 0,
    "meaning_vi": "định nghĩa tiếng Việt",
    "example_vi": "câu ví dụ tiếng Việt hoặc null"
  },
  ...
]

Trả về JSON array thuần túy:`;

  try {
    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system:     TRANSLATION_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const rawText = message.content?.[0]?.text?.trim() || '[]';

    // Parse an toàn
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Xử lý trường hợp có markdown fence
      const cleaned = rawText
        .replace(/^```json\n?/m, '')
        .replace(/^```\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim();
      parsed = JSON.parse(cleaned);
    }

    // Map kết quả theo idx
    const resultMap = {};
    if (Array.isArray(parsed)) {
      for (const r of parsed) {
        if (typeof r.idx === 'number') {
          resultMap[r.idx] = {
            meaning_vi: r.meaning_vi || null,
            example_vi: r.example_vi || null,
          };
        }
      }
    }

    return resultMap;

  } catch (err) {
    if (retryCount < 3) {
      const delay = (retryCount + 1) * 1500;
      await sleep(delay);
      return translateBatch(items, retryCount + 1);
    }
    log(`⚠️  Batch dịch thất bại (${items[0]?.headword}...): ${err.message}`);
    return {};
  }
}

// ══════════════════════════════════════════════════════════════
//  PHASE 1: IMPORT TỪ VỰNG (KHÔNG DỊCH)
// ══════════════════════════════════════════════════════════════

async function phase1_import(client) {
  log('📖 Phase 1: Đọc oxford_5000.json...');

  if (!fs.existsSync(OXFORD_JSON)) {
    console.error(`\n❌ Không tìm thấy file: ${OXFORD_JSON}`);
    console.error('   Hãy clone repo trước:\n   git clone https://github.com/winterdl/oxford-5000-vocabulary-audio-definition.git');
    process.exit(1);
  }

  const raw  = fs.readFileSync(OXFORD_JSON, 'utf-8');
  const data = JSON.parse(raw);

  // JSON dạng {"0": {...}, "1": {...}} → chuyển thành array
  const rawEntries = Object.values(data);
  log(`  ✓ Đọc được ${rawEntries.length} entries từ JSON`);

  // Tạm bỏ NOT NULL trên meaning_vi để import trước
  try {
    await client.query(
      `ALTER TABLE dictionary_entries ALTER COLUMN meaning_vi DROP NOT NULL`
    );
    log('  ✓ Tạm bỏ NOT NULL trên meaning_vi');
  } catch (err) {
    // Có thể đã bỏ rồi — bỏ qua
    if (!err.message.includes('does not exist')) {
      log(`  ⚠️  ${err.message}`);
    }
  }

  let success = 0, skip = 0, error = 0;
  const allEntries = [];

  for (const rawItem of rawEntries) {
    const item = parseEntry(rawItem);
    if (!item) { skip++; continue; }
    allEntries.push(item);

    try {
      await client.query(`
        INSERT INTO dictionary_entries (
          id,
          headword, lemma,
          ipa_us, ipa_uk,
          audio_us_url, audio_uk_url,
          pos,
          meaning_en, meaning_vi,
          example_en, example_vi,
          cefr_level,
          source, published,
          created_at, updated_at
        ) VALUES (
          $1,
          $2, $3,
          $4, $5,
          $6, $7,
          $8,
          $9,  NULL,
          $10, NULL,
          $11,
          'wiktionary', true,
          NOW(), NOW()
        )
        ON CONFLICT (headword, lemma) DO UPDATE SET
          ipa_us       = EXCLUDED.ipa_us,
          ipa_uk       = EXCLUDED.ipa_uk,
          audio_us_url = EXCLUDED.audio_us_url,
          audio_uk_url = EXCLUDED.audio_uk_url,
          pos          = EXCLUDED.pos,
          meaning_en   = EXCLUDED.meaning_en,
          example_en   = EXCLUDED.example_en,
          cefr_level   = EXCLUDED.cefr_level,
          updated_at   = NOW()
      `, [
        uuidv4(),
        item.headword, item.lemma,
        item.ipa_us,   item.ipa_uk,
        item.audio_us_url, item.audio_uk_url,
        item.pos,
        item.meaning_en,
        item.example_en,
        item.cefr_level,
      ]);
      success++;
    } catch (err) {
      if (err.code !== '23505') {
        log(`  ❌ Lỗi "${item.headword}": ${err.message}`);
        error++;
      } else {
        skip++;
      }
    }

    // Progress mỗi 200 từ
    if ((success + skip + error) % 200 === 0) {
      const total = rawEntries.length;
      const done  = success + skip + error;
      const pct   = ((done / total) * 100).toFixed(1);
      process.stdout.write(`\r  ⏳ [Phase 1] ${done}/${total} (${pct}%) | ✅ ${success} | ⏭️ ${skip} | ❌ ${error}  `);
    }
  }

  const total = rawEntries.length;
  process.stdout.write(`\r  ⏳ [Phase 1] ${total}/${total} (100%) | ✅ ${success} | ⏭️ ${skip} | ❌ ${error}  \n`);
  log(`✅ Phase 1 XONG! Import: ${success} | Bỏ qua: ${skip} | Lỗi: ${error}\n`);

  return allEntries;
}

// ══════════════════════════════════════════════════════════════
//  PHASE 2: DỊCH TIẾNG VIỆT BẰNG CLAUDE HAIKU
// ══════════════════════════════════════════════════════════════

async function phase2_translate(client) {
  log('🌐 Phase 2: Dịch tiếng Việt bằng Claude Haiku...');

  if (!process.env.ANTHROPIC_API_KEY) {
    log('⚠️  ANTHROPIC_API_KEY chưa được set → bỏ qua Phase 2');
    log('   Set key rồi chạy lại để dịch: ANTHROPIC_API_KEY=sk-ant-xxx node scripts/import-oxford.mjs');
    return;
  }

  // Load cache để resume nếu bị ngắt
  const cache = loadTranslationCache();
  const cachedCount = Object.keys(cache).length;
  if (cachedCount > 0) {
    log(`  📁 Tìm thấy ${cachedCount} từ đã dịch trong cache → tiếp tục từ điểm dừng`);
  }

  // Lấy tất cả từ cần dịch (chưa có meaning_vi hoặc là '[pending]')
  const { rows: toTranslate } = await client.query(`
    SELECT id, headword, pos, cefr_level, meaning_en, example_en
    FROM dictionary_entries
    WHERE (meaning_vi IS NULL OR meaning_vi = '[pending]')
      AND meaning_en IS NOT NULL
      AND meaning_en != ''
    ORDER BY
      CASE cefr_level
        WHEN 'A1' THEN 1 WHEN 'A2' THEN 2
        WHEN 'B1' THEN 3 WHEN 'B2' THEN 4
        WHEN 'C1' THEN 5 WHEN 'C2' THEN 6
        ELSE 7
      END,
      headword ASC
  `);

  if (toTranslate.length === 0) {
    log('  🎉 Tất cả từ đã có nghĩa tiếng Việt!\n');
    return;
  }

  // Lọc ra những từ chưa có trong cache
  const needTranslate = toTranslate.filter(w => !cache[w.headword]);
  log(`  → Tổng cần dịch: ${toTranslate.length} | Chưa cache: ${needTranslate.length}`);

  // Ước tính chi phí
  const batches    = Math.ceil(needTranslate.length / TRANSLATE_BATCH_SIZE);
  const estMinutes = Math.ceil(batches * TRANSLATE_DELAY_MS / 60000 + batches * 1.5);
  // ~$1/1M input, ~$5/1M output → mỗi batch ~500 input + 600 output tokens
  const estCost    = ((batches * 500 / 1_000_000 * 1) + (batches * 600 / 1_000_000 * 5)).toFixed(3);
  log(`  → ${batches} batches | ~${estMinutes} phút | ~$${estCost} USD\n`);

  let translated = 0, failed = 0;

  // ── Gọi API theo batch ──────────────────────────────────────
  for (let i = 0; i < needTranslate.length; i += TRANSLATE_BATCH_SIZE) {
    const batch = needTranslate.slice(i, i + TRANSLATE_BATCH_SIZE);

    const resultMap = await translateBatch(batch);

    // Lưu kết quả vào cache và update DB ngay
    for (let j = 0; j < batch.length; j++) {
      const word   = batch[j];
      const result = resultMap[j];

      if (result?.meaning_vi) {
        cache[word.headword] = result;
        translated++;
      } else {
        // Đánh dấu pending để retry lần sau
        cache[word.headword] = { meaning_vi: '[pending]', example_vi: null };
        failed++;
      }
    }

    // Lưu cache sau mỗi batch (để resume nếu ngắt)
    saveTranslationCache(cache);

    const processed = Math.min(i + TRANSLATE_BATCH_SIZE, needTranslate.length);
    const pct       = ((processed / needTranslate.length) * 100).toFixed(1);
    process.stdout.write(
      `\r  🔄 [API] ${processed}/${needTranslate.length} (${pct}%) | ✅ ${translated} | ⚠️ ${failed}  `
    );

    if (i + TRANSLATE_BATCH_SIZE < needTranslate.length) {
      await sleep(TRANSLATE_DELAY_MS);
    }
  }

  console.log('\n');

  // ── Update DB từ cache ──────────────────────────────────────
  log('  💾 Đang cập nhật database...');

  let dbUpdated = 0;

  for (const row of toTranslate) {
    const cached = cache[row.headword];
    if (!cached || cached.meaning_vi === '[pending]') continue;

    await client.query(`
      UPDATE dictionary_entries
      SET meaning_vi = $1,
          example_vi = $2,
          updated_at = NOW()
      WHERE id = $3
    `, [cached.meaning_vi, cached.example_vi || null, row.id]);
    dbUpdated++;

    if (dbUpdated % 200 === 0) {
      process.stdout.write(`\r  💾 Updated: ${dbUpdated}/${toTranslate.length}  `);
    }
  }

  console.log(`\r  💾 Updated: ${dbUpdated} từ trong DB              \n`);

  // Báo còn bao nhiêu pending
  const pendingCount = Object.values(cache).filter(v => v.meaning_vi === '[pending]').length;
  if (pendingCount > 0) {
    log(`  ⚠️  Còn ${pendingCount} từ dịch thất bại → chạy lại script để retry`);
  } else {
    log('  🎉 Tất cả từ đã được dịch thành công!');
  }
}

// ══════════════════════════════════════════════════════════════
//  PHASE 3: KHÔI PHỤC NOT NULL + THỐNG KÊ
// ══════════════════════════════════════════════════════════════

async function phase3_finalize(client) {
  log('📊 Phase 3: Kiểm tra và thống kê...\n');

  const { rows: stats } = await client.query(`
    SELECT
      COUNT(*)                                                    AS total,
      COUNT(*) FILTER (WHERE meaning_vi IS NOT NULL
        AND meaning_vi != '[pending]')                           AS has_vi,
      COUNT(*) FILTER (WHERE meaning_vi IS NULL
        OR meaning_vi = '[pending]')                             AS missing_vi,
      COUNT(*) FILTER (WHERE ipa_us IS NOT NULL)                 AS has_ipa_us,
      COUNT(*) FILTER (WHERE ipa_uk IS NOT NULL)                 AS has_ipa_uk,
      COUNT(*) FILTER (WHERE audio_us_url IS NOT NULL)           AS has_audio_us,
      COUNT(*) FILTER (WHERE audio_uk_url IS NOT NULL)           AS has_audio_uk,
      COUNT(*) FILTER (WHERE cefr_level IS NOT NULL)             AS has_cefr
    FROM dictionary_entries
    WHERE source = 'wiktionary'
  `);

  const s = stats[0];
  const viPct = ((parseInt(s.has_vi) / parseInt(s.total)) * 100).toFixed(1);

  console.log('  ┌────────────────────────────────────────┐');
  console.log('  │           THỐNG KÊ DATABASE            │');
  console.log('  ├────────────────────────────────────────┤');
  console.log(`  │  Tổng số từ       : ${String(s.total).padStart(6)}              │`);
  console.log(`  │  Có nghĩa VI      : ${String(s.has_vi).padStart(6)} (${viPct}%)      │`);
  console.log(`  │  Chưa có nghĩa VI : ${String(s.missing_vi).padStart(6)}              │`);
  console.log(`  │  Có IPA US        : ${String(s.has_ipa_us).padStart(6)}              │`);
  console.log(`  │  Có IPA UK        : ${String(s.has_ipa_uk).padStart(6)}              │`);
  console.log(`  │  Có audio US      : ${String(s.has_audio_us).padStart(6)}              │`);
  console.log(`  │  Có audio UK      : ${String(s.has_audio_uk).padStart(6)}              │`);
  console.log(`  │  Có CEFR level    : ${String(s.has_cefr).padStart(6)}              │`);
  console.log('  └────────────────────────────────────────┘\n');

  // Phân bổ theo CEFR
  const { rows: cefrStats } = await client.query(`
    SELECT cefr_level, COUNT(*) AS cnt
    FROM dictionary_entries
    WHERE source = 'wiktionary'
    GROUP BY cefr_level
    ORDER BY cefr_level
  `);

  console.log('  Phân bổ theo CEFR:');
  for (const r of cefrStats) {
    const bar = '█'.repeat(Math.round(parseInt(r.cnt) / 50));
    console.log(`    ${(r.cefr_level || 'N/A').padEnd(4)} ${String(r.cnt).padStart(5)}  ${bar}`);
  }

  // Khôi phục NOT NULL nếu tất cả từ đã có nghĩa VI
  if (parseInt(s.missing_vi) === 0) {
    try {
      await client.query(
        `ALTER TABLE dictionary_entries ALTER COLUMN meaning_vi SET NOT NULL`
      );
      log('\n✅ Đã khôi phục NOT NULL constraint trên meaning_vi');
    } catch { /* ignore */ }
  } else {
    log(`\n⚠️  Còn ${s.missing_vi} từ chưa có meaning_vi → chưa khôi phục NOT NULL`);
    log('   Chạy lại script để tiếp tục dịch.');
  }
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Oxford 5000 → PostgreSQL Importer');
  console.log('  Translation Engine: Claude Haiku 4.5');
  console.log('═══════════════════════════════════════════════════\n');

  const client = await pool.connect();

  try {
    log('✓ Đã kết nối PostgreSQL\n');

    // Kiểm tra đã import chưa
    const { rows: existing } = await client.query(
      `SELECT COUNT(*) AS cnt FROM dictionary_entries WHERE source = 'wiktionary'`
    );
    const alreadyImported = parseInt(existing[0].cnt);

    if (alreadyImported === 0) {
      // Lần đầu chạy → import toàn bộ
      await phase1_import(client);
    } else {
      log(`ℹ️  Đã có ${alreadyImported} từ (source='wiktionary') → bỏ qua Phase 1\n`);
    }

    // Luôn chạy phase dịch (để resume / retry)
    await phase2_translate(client);

    // Thống kê & finalize
    await phase3_finalize(client);

  } catch (err) {
    console.error('\n❌ Lỗi nghiêm trọng:', err.message);
    console.error(err.stack);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
