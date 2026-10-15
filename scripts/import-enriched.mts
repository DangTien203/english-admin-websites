// ══════════════════════════════════════════════════════════════
//  IMPORT ENRICHED DICTIONARY — Đọc JSON batches → PostgreSQL
// ══════════════════════════════════════════════════════════════
//
//  Chạy LOCAL:   npx tsx scripts/import-enriched.mts
//  Chạy RAILWAY: railway run npx tsx scripts/import-enriched.mts
//
//  Đọc tất cả file dict-batch-*.json trong scripts/dict-data/
//  và insert vào database.
//
//  CẦN CHẠY TRƯỚC: cleanup-dictionary.mts (dọn dữ liệu cũ)

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg   from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, 'dict-data');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'english_learning_app',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

// ══════════════════════════════════════════════════════════════
//  TYPES
// ══════════════════════════════════════════════════════════════

interface SenseData {
  pos: string;
  sense_order: number;
  definition_en: string;
  definition_vi: string;
  grammar_note?: string | null;
  domain?: string | null;
  register?: string | null;
  examples?: { en: string; vi: string }[];
  synonyms?: string[];
  antonyms?: string[];
}

interface WordData {
  headword: string;
  meaning_vi: string;
  pos: string[];
  cefr_level: string;
  ipa_uk?: string | null;
  ipa_us?: string | null;
  audio_uk?: string | null;
  audio_us?: string | null;
  etymology?: string | null;
  is_countable?: boolean | null;
  is_transitive?: boolean | null;
  register?: string | null;
  senses: SenseData[];
  word_forms?: { form_type: string; form_value: string; tags?: string[] }[];
  phrasal_verbs?: {
    phrasal_verb: string;
    particle: string;
    is_separable: boolean;
    definition_en: string;
    definition_vi: string;
    example_en: string;
    example_vi: string;
  }[];
  idioms?: {
    idiom_text: string;
    definition_en: string;
    definition_vi: string;
    example_en: string;
    example_vi: string;
  }[];
  collocations?: {
    collocation: string;
    pattern: string;
    example_en: string;
    example_vi: string;
  }[];
}

// ══════════════════════════════════════════════════════════════
//  INSERT LOGIC
// ══════════════════════════════════════════════════════════════

async function insertWord(client: pg.PoolClient, word: WordData) {
  // 1. Upsert dictionary_entries
  const { rows } = await client.query(`
    INSERT INTO dictionary_entries (
      headword, lemma,
      ipa_us, ipa_uk,
      audio_us_url, audio_uk_url,
      pos, meaning_vi, meaning_en,
      cefr_level, etymology,
      is_countable, is_transitive, register,
      source, published
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, NULL,
      $9, $10, $11, $12, $13,
      'wiktionary', true
    )
    ON CONFLICT (headword, lemma) DO UPDATE SET
      ipa_us       = COALESCE(EXCLUDED.ipa_us, dictionary_entries.ipa_us),
      ipa_uk       = COALESCE(EXCLUDED.ipa_uk, dictionary_entries.ipa_uk),
      pos          = EXCLUDED.pos,
      meaning_vi   = EXCLUDED.meaning_vi,
      cefr_level   = EXCLUDED.cefr_level,
      etymology    = EXCLUDED.etymology,
      is_countable = EXCLUDED.is_countable,
      is_transitive= EXCLUDED.is_transitive,
      register     = EXCLUDED.register,
      updated_at   = NOW()
    RETURNING id
  `, [
    word.headword, word.headword.toLowerCase(),
    word.ipa_us || null, word.ipa_uk || null,
    word.audio_us || null, word.audio_uk || null,
    word.pos,
    word.meaning_vi,
    word.cefr_level?.toUpperCase(),
    word.etymology || null,
    word.is_countable ?? null,
    word.is_transitive ?? null,
    word.register || null,
  ]);

  const entryId = rows[0].id;

  // 2. Word Forms
  if (word.word_forms?.length) {
    for (const f of word.word_forms) {
      await client.query(`
        INSERT INTO word_forms (entry_id, form_type, form_value, tags)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (entry_id, form_type, form_value) DO NOTHING
      `, [entryId, f.form_type, f.form_value, f.tags || []]);
    }
  }

  // 3. Senses + Examples + Synonyms + Antonyms
  if (word.senses?.length) {
    for (const sense of word.senses) {
      const { rows: sRows } = await client.query(`
        INSERT INTO entry_senses (entry_id, pos, sense_order, definition_en, definition_vi, grammar_note, domain, register)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (entry_id, pos, sense_order) DO UPDATE SET
          definition_en = EXCLUDED.definition_en,
          definition_vi = EXCLUDED.definition_vi,
          grammar_note  = EXCLUDED.grammar_note
        RETURNING id
      `, [
        entryId, sense.pos, sense.sense_order,
        sense.definition_en, sense.definition_vi,
        sense.grammar_note || null, sense.domain || null, sense.register || null,
      ]);
      const senseId = sRows[0]?.id;
      if (!senseId) continue;

      if (sense.examples?.length) {
        for (let i = 0; i < sense.examples.length; i++) {
          await client.query(
            'INSERT INTO sense_examples (sense_id, example_en, example_vi, sort_order) VALUES ($1,$2,$3,$4)',
            [senseId, sense.examples[i].en, sense.examples[i].vi || null, i]
          );
        }
      }
      if (sense.synonyms?.length) {
        for (const s of sense.synonyms) {
          await client.query(
            'INSERT INTO sense_synonyms (sense_id, synonym_text) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [senseId, s]
          );
        }
      }
      if (sense.antonyms?.length) {
        for (const a of sense.antonyms) {
          await client.query(
            'INSERT INTO sense_antonyms (sense_id, antonym_text) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [senseId, a]
          );
        }
      }
    }
  }

  // 4. Phrasal Verbs
  if (word.phrasal_verbs?.length) {
    for (const pv of word.phrasal_verbs) {
      await client.query(`
        INSERT INTO phrasal_verbs (entry_id, phrasal_verb, particle, is_separable, definition_en, definition_vi, example_en, example_vi)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [entryId, pv.phrasal_verb, pv.particle, pv.is_separable, pv.definition_en, pv.definition_vi, pv.example_en, pv.example_vi]);
    }
  }

  // 5. Idioms
  if (word.idioms?.length) {
    for (const idm of word.idioms) {
      await client.query(`
        INSERT INTO entry_idioms (entry_id, idiom_text, definition_en, definition_vi, example_en, example_vi)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [entryId, idm.idiom_text, idm.definition_en, idm.definition_vi, idm.example_en, idm.example_vi]);
    }
  }

  // 6. Collocations
  if (word.collocations?.length) {
    for (const col of word.collocations) {
      await client.query(`
        INSERT INTO collocations (entry_id, collocation, pattern, example_en, example_vi)
        VALUES ($1,$2,$3,$4,$5)
      `, [entryId, col.collocation, col.pattern, col.example_en, col.example_vi]);
    }
  }

  return entryId;
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  📥 IMPORT ENRICHED DICTIONARY');
  console.log('═══════════════════════════════════════════════════\n');

  // Tìm tất cả file JSON trong dict-data/
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`❌ Thư mục ${DATA_DIR} không tồn tại!`);
    console.error('   Tạo thư mục scripts/dict-data/ rồi copy các file dict-batch-*.json vào.');
    process.exit(1);
  }

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error('❌ Không tìm thấy file JSON nào trong dict-data/');
    process.exit(1);
  }

  console.log(`📁 Tìm thấy ${files.length} file JSON:\n`);
  files.forEach(f => console.log(`   ${f}`));
  console.log('');

  // Đọc tất cả files → merge thành 1 array
  const allWords: WordData[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
    const data = JSON.parse(content);
    const words = Array.isArray(data) ? data : (data.words || []);
    allWords.push(...words);
    console.log(`  ✓ ${file}: ${words.length} từ`);
  }

  console.log(`\n📊 Tổng: ${allWords.length} từ cần import\n`);

  // Drop NOT NULL trên meaning_vi nếu có
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE dictionary_entries ALTER COLUMN meaning_vi DROP NOT NULL');
  } catch { /* đã drop rồi */ }

  // Import từng từ
  const stats = {
    words: 0, senses: 0, examples: 0, forms: 0,
    phrasal: 0, idioms: 0, collocations: 0,
    synonyms: 0, antonyms: 0, errors: 0,
  };

  for (const word of allWords) {
    try {
      await insertWord(client, word);
      stats.words++;
      stats.senses      += word.senses?.length || 0;
      stats.examples     += word.senses?.reduce((a, s) => a + (s.examples?.length || 0), 0) || 0;
      stats.forms        += word.word_forms?.length || 0;
      stats.phrasal      += word.phrasal_verbs?.length || 0;
      stats.idioms       += word.idioms?.length || 0;
      stats.collocations += word.collocations?.length || 0;
      stats.synonyms     += word.senses?.reduce((a, s) => a + (s.synonyms?.length || 0), 0) || 0;
      stats.antonyms     += word.senses?.reduce((a, s) => a + (s.antonyms?.length || 0), 0) || 0;

      if (stats.words % 50 === 0) {
        process.stdout.write(`\r  💾 ${stats.words}/${allWords.length} imported...`);
      }
    } catch (err: any) {
      console.error(`\n  ❌ [${word.headword}]: ${err.message}`);
      stats.errors++;
    }
  }

  // Thống kê
  console.log('\n\n═══════════════════════════════════════════════════');
  console.log('  ✅ IMPORT HOÀN TẤT');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Words              : ${stats.words}`);
  console.log(`  Senses             : ${stats.senses}`);
  console.log(`  Examples           : ${stats.examples}`);
  console.log(`  Word Forms         : ${stats.forms}`);
  console.log(`  Phrasal Verbs      : ${stats.phrasal}`);
  console.log(`  Idioms             : ${stats.idioms}`);
  console.log(`  Collocations       : ${stats.collocations}`);
  console.log(`  Synonyms           : ${stats.synonyms}`);
  console.log(`  Antonyms           : ${stats.antonyms}`);
  console.log(`  Errors             : ${stats.errors}`);
  const total = stats.senses + stats.examples + stats.forms + stats.phrasal + stats.idioms + stats.collocations + stats.synonyms + stats.antonyms;
  console.log(`  ─────────────────────────────`);
  console.log(`  TỔNG ROWS           : ${stats.words + total}`);
  console.log('═══════════════════════════════════════════════════\n');

  client.release();
  await pool.end();
}

main();
