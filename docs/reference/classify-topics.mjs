// scripts/classify-topics.mjs
// Phân loại 5,000 từ Oxford vào 30 topics bằng Claude Haiku API
// Chạy: node scripts/classify-topics.mjs
//
// Prerequisites:
//   1. Đã chạy seed-topics.mjs để tạo tags trong DB
//   2. Đã import oxford_5000.json vào dictionary_entries
//   3. File .env có: ANTHROPIC_API_KEY, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import pg        from 'pg';
import fs        from 'fs';
import path      from 'path';

// ══════════════════════════════════════════════════════════════
//  CẤU HÌNH
// ══════════════════════════════════════════════════════════════
const DB_CONFIG = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'your_database',
  user:     process.env.DB_USER     || 'your_user',
  password: process.env.DB_PASSWORD || 'your_password',
};

const BATCH_SIZE      = 50;    // số từ mỗi lần gọi API (tối ưu giữa cost & speed)
const BATCH_DELAY_MS  = 600;   // ms chờ giữa các batch (tránh rate limit)
const RESULT_FILE     = './topic-classifications.json'; // backup kết quả
const MAX_RETRIES     = 3;     // số lần thử lại nếu API lỗi

// ── Anthropic Client ─────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ══════════════════════════════════════════════════════════════
//  30 TOPICS — phải khớp với seed-topics.mjs
// ══════════════════════════════════════════════════════════════
const TOPIC_NAMES = [
  // Group 1: Foundations (A1/A2)
  'core_language',        // Articles, pronouns, prepositions, numbers, basic expressions
  'time_calendar',        // Days, months, time, seasons
  'colors_shapes',        // Colors, shapes, sizes, textures
  'greetings_social',     // Greetings, polite phrases, social interactions

  // Group 2: People & Daily Life (A1/B1)
  'family_relationships', // Family, relatives, friendships
  'body_appearance',      // Body parts, physical appearance
  'emotions_feelings',    // Emotions, moods, feelings
  'character_values',     // Personality, moral values, virtues
  'food_drink',           // Food, drinks, meals, cooking
  'home_household',       // Rooms, furniture, household
  'clothes_fashion',      // Clothing, accessories, style
  'transport_travel',     // Vehicles, journeys, tourism

  // Group 3: World & Nature (A2/B1)
  'animals_wildlife',     // Animals, insects, birds, habitats
  'plants_nature',        // Plants, trees, forests, agriculture
  'weather_climate',      // Weather, climate, natural events
  'geography_places',     // Countries, cities, landforms

  // Group 4: Society & Culture (B1/B2)
  'education_school',     // School, university, learning
  'work_career',          // Jobs, workplace, employment
  'sports_recreation',    // Sports, games, fitness, leisure
  'arts_entertainment',   // Music, film, literature, visual arts
  'media_communication',  // News, social media, journalism
  'shopping_commerce',    // Shopping, retail, consumer goods

  // Group 5: Advanced (B2/C1)
  'technology_digital',   // Computers, internet, software, AI
  'science_research',     // Sciences, experiments, theory
  'health_medicine',      // Healthcare, diseases, treatments
  'business_economy',     // Finance, economics, trade, markets
  'politics_law',         // Government, elections, justice
  'environment_society',  // Climate change, social issues, equality
  'psychology_mind',      // Psychology, cognition, behavior
  'academic_formal',      // Academic writing, abstract concepts
];

// Mô tả ngắn cho từng topic (giúp AI phân loại chính xác hơn)
const TOPIC_DESCRIPTIONS = {
  core_language:        'grammar words: articles (a/an/the), pronouns, prepositions, conjunctions, auxiliaries, numbers, basic adverbs like "very/just/also"',
  time_calendar:        'time: days of week, months, years, seasons, morning/afternoon/evening, before/after/during, always/never/sometimes',
  colors_shapes:        'colors (red/blue/green), shapes (circle/square), sizes (big/small/tall), textures (smooth/rough), basic physical descriptors',
  greetings_social:     'social phrases: hello/goodbye, please/thank you, sorry/excuse me, yes/no, okay/sure, conversation basics',
  family_relationships: 'family: mother/father/sibling/aunt/uncle/cousin, relationships: friend/partner/neighbor/colleague',
  body_appearance:      'body parts: head/arm/leg/heart/blood, physical appearance: height/weight/hair/skin, looking/feeling physically',
  emotions_feelings:    'emotions: happy/sad/angry/afraid/excited/anxious/proud/lonely/jealous, mood, emotional states',
  character_values:     'personality: kind/honest/brave/generous/patient/loyal, moral qualities: respect/trust/dignity/fairness/integrity',
  food_drink:           'food: apple/bread/meat/fish/vegetable/fruit/cake, drinks: water/coffee/juice/wine, meals: breakfast/lunch/dinner, cooking, nutrition',
  home_household:       'home: house/apartment/room/bedroom/kitchen, furniture: bed/chair/table, household: door/window/carpet/garden',
  clothes_fashion:      'clothing: shirt/dress/coat/shoes/hat/jacket, fabrics: cotton/silk/wool, fashion: style/trend/outfit',
  transport_travel:     'transport: car/bus/train/plane/boat, travel: journey/trip/airport/station/ticket/passport/tourist',
  animals_wildlife:     'animals: dog/cat/horse/lion/bird/fish/insect/shark/whale, wildlife, habitat, creature, species, predator/prey',
  plants_nature:        'plants: tree/flower/grass/leaf/root/seed/forest, agriculture: farm/crop/harvest/soil, garden, jungle',
  weather_climate:      'weather: rain/snow/wind/cloud/sun/storm/fog/temperature, seasons: spring/summer/autumn/winter, climate, flood/drought',
  geography_places:     'geography: mountain/river/ocean/desert/valley/island, places: city/country/region/coast, directions: north/south/east/west',
  education_school:     'education: school/university/class/exam/grade/degree, learning: study/teach/lesson/textbook/homework/essay/research',
  work_career:          'work: job/office/employee/salary/contract/career, professional: manager/engineer/lawyer/doctor/teacher/staff/colleague',
  sports_recreation:    'sports: football/tennis/swim/run/gym/race/team/goal/medal, leisure: game/play/compete/champion/tournament',
  arts_entertainment:   'arts: music/film/painting/literature/theatre/dance, entertainment: concert/gallery/museum/novel/poem/artist/musician',
  media_communication:  'media: newspaper/television/radio/internet/social media, communication: message/email/broadcast/journalist/interview/report',
  shopping_commerce:    'shopping: buy/sell/price/discount/market/store/product, money: pay/cost/afford/spend/earn/invoice/receipt',
  technology_digital:   'technology: computer/phone/internet/software/app/data/digital, innovation: AI/robot/device/network/code/website/download',
  science_research:     'science: biology/chemistry/physics/experiment/theory/research, concepts: atom/cell/molecule/energy/gravity/formula/data/discovery',
  health_medicine:      'health: doctor/hospital/disease/treatment/medicine/surgery, medical: cancer/infection/blood pressure/therapy/symptom/diagnosis/vaccine',
  business_economy:     'business: company/market/profit/revenue/investment/trade, economy: inflation/budget/debt/tax/stock/finance/industry/enterprise',
  politics_law:         'politics: government/election/democracy/parliament/president/policy, law: court/judge/crime/legal/rights/justice/constitution/police',
  environment_society:  'environment: pollution/climate change/conservation/recycling, society: poverty/inequality/immigration/racism/protest/welfare/rights',
  psychology_mind:      'psychology: behavior/cognition/mental health/trauma/therapy/consciousness, thinking: logic/reason/memory/creativity/intelligence',
  academic_formal:      'academic: analysis/theory/hypothesis/methodology/significant/subsequent, formal language: therefore/however/furthermore/establish/demonstrate',
};

// ══════════════════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const now = new Date().toLocaleTimeString('vi-VN');
  console.log(`[${now}] ${msg}`);
}

// ── Load backup file ─────────────────────────────────────────
function loadSavedResults() {
  if (fs.existsSync(RESULT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveResults(results) {
  fs.writeFileSync(RESULT_FILE, JSON.stringify(results, null, 2));
}

// ══════════════════════════════════════════════════════════════
//  CLAUDE API — PHÂN LOẠI BATCH
// ══════════════════════════════════════════════════════════════
async function classifyBatch(words, retryCount = 0) {
  // Tạo word list với context: word (pos) [cefr]: short definition hint
  const wordList = words.map(w => {
    const pos  = w.pos?.[0] || 'unknown';
    const cefr = w.cefr_level || '';
    // Chỉ lấy 5 từ đầu của definition làm hint để tiết kiệm tokens
    const hint = (w.meaning_en || '').split(' ').slice(0, 5).join(' ');
    return `${w.headword} (${pos}, ${cefr}): "${hint}..."`;
  }).join('\n');

  // Tạo topic summary ngắn cho prompt
  const topicSummary = TOPIC_NAMES.map(t => `${t}: ${TOPIC_DESCRIPTIONS[t]}`).join('\n');

  const prompt = `You are classifying English vocabulary words into learning topics.

TOPICS (use EXACTLY these names):
${topicSummary}

WORDS TO CLASSIFY:
${wordList}

RULES:
1. Return ONLY a valid JSON object, no markdown, no explanation
2. Format: {"word": "topic_name"}
3. Each word gets exactly ONE topic from the list above
4. Use "core_language" for: articles, pronouns, prepositions, conjunctions, auxiliaries, very common function words
5. Use "academic_formal" for abstract C1 words that don't fit other topics
6. Consider the part of speech AND the definition hint

Return JSON only:`;

  try {
    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001', // nhanh + rẻ: $1/$5 per 1M tokens
      max_tokens: 2048,
      messages:   [{ role: 'user', content: prompt }],
    });

    const rawText = message.content?.[0]?.text?.trim() || '{}';

    // Parse an toàn — xử lý cả trường hợp có markdown fence
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const cleaned = rawText.replace(/```json\n?|```\n?/g, '').trim();
      parsed = JSON.parse(cleaned);
    }

    // Validate: chỉ giữ kết quả có topic hợp lệ
    const validTopics = new Set(TOPIC_NAMES);
    const validated   = {};
    for (const [word, topic] of Object.entries(parsed)) {
      if (validTopics.has(topic)) {
        validated[word] = topic;
      } else {
        // Map về academic_formal nếu topic không hợp lệ
        validated[word] = 'academic_formal';
      }
    }
    return validated;

  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      const delay = (retryCount + 1) * 2000;
      log(`⚠️  Batch lỗi (retry ${retryCount + 1}/${MAX_RETRIES}) sau ${delay}ms: ${err.message}`);
      await sleep(delay);
      return classifyBatch(words, retryCount + 1);
    }
    log(`❌ Batch thất bại sau ${MAX_RETRIES} lần retry: ${err.message}`);
    return {};
  }
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Oxford 5000 — Topic Classification');
  console.log('  Model: claude-haiku-4-5-20251001');
  console.log('═══════════════════════════════════════════════\n');

  // Kiểm tra API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ Thiếu ANTHROPIC_API_KEY trong .env');
    process.exit(1);
  }

  const pool   = new pg.Pool(DB_CONFIG);
  const client = await pool.connect();
  log('✓ Đã kết nối PostgreSQL');

  // ── Load backup để resume nếu bị ngắt ────────────────────
  const savedResults = loadSavedResults();
  const savedCount   = Object.keys(savedResults).length;
  if (savedCount > 0) {
    log(`📁 Tìm thấy ${savedCount} từ đã phân loại từ lần trước → tiếp tục từ điểm dừng`);
  }

  // ── Lấy tag map từ DB ─────────────────────────────────────
  const { rows: tags } = await client.query(
    `SELECT id, name FROM tags WHERE name = ANY($1)`,
    [TOPIC_NAMES]
  );
  const tagMap = Object.fromEntries(tags.map(t => [t.name, t.id]));

  const missingTopics = TOPIC_NAMES.filter(t => !tagMap[t]);
  if (missingTopics.length > 0) {
    console.error(`❌ Topics chưa có trong DB: ${missingTopics.join(', ')}`);
    console.error('   Hãy chạy: node scripts/seed-topics.mjs trước');
    process.exit(1);
  }
  log(`✓ Loaded ${tags.length} topics từ DB`);

  // ── Lấy tất cả từ vựng cần phân loại ─────────────────────
  const { rows: allWords } = await client.query(`
    SELECT de.id, de.headword, de.pos, de.cefr_level, de.meaning_en
    FROM dictionary_entries de
    WHERE de.published = true
    ORDER BY
      CASE de.cefr_level
        WHEN 'A1' THEN 1 WHEN 'A2' THEN 2
        WHEN 'B1' THEN 3 WHEN 'B2' THEN 4
        WHEN 'C1' THEN 5 WHEN 'C2' THEN 6
        ELSE 7
      END,
      de.headword ASC
  `);

  log(`📊 Tổng từ trong DB: ${allWords.length}`);

  // Lọc ra từ chưa được phân loại (chưa có trong backup)
  const unclassified = allWords.filter(w => !savedResults[w.headword]);
  log(`🎯 Chưa phân loại: ${unclassified.length} từ`);
  log(`⏭️  Đã phân loại:  ${allWords.length - unclassified.length} từ\n`);

  if (unclassified.length === 0) {
    log('✅ Tất cả từ đã được phân loại! Tiến hành insert vào DB...\n');
  } else {
    // Ước tính chi phí
    const estimatedBatches = Math.ceil(unclassified.length / BATCH_SIZE);
    const estimatedMinutes = Math.ceil(estimatedBatches * BATCH_DELAY_MS / 60000);
    const estimatedCost    = ((unclassified.length * 120) / 1_000_000 * 1).toFixed(4); // ~$1/1M input
    log(`📈 Ước tính: ${estimatedBatches} batches | ~${estimatedMinutes} phút | ~$${estimatedCost}`);
    log(`   (Haiku 4.5: $1/1M input tokens, $5/1M output tokens)\n`);

    // ── Phase 1: Gọi API phân loại ─────────────────────────
    let processed = 0, apiCalls = 0, apiErrors = 0;

    for (let i = 0; i < unclassified.length; i += BATCH_SIZE) {
      const batch = unclassified.slice(i, i + BATCH_SIZE);

      const result = await classifyBatch(batch);

      if (Object.keys(result).length > 0) {
        Object.assign(savedResults, result);
        saveResults(savedResults); // auto-save sau mỗi batch
        apiCalls++;
      } else {
        apiErrors++;
      }

      processed += batch.length;
      const total = unclassified.length;
      const pct   = ((processed / total) * 100).toFixed(1);
      process.stdout.write(
        `\r🔄 API ${processed}/${total} (${pct}%) | ✅ ${apiCalls} batches OK | ❌ ${apiErrors} errors  `
      );

      if (i + BATCH_SIZE < unclassified.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    console.log('\n');
    log(`✅ API phase xong! Kết quả: ${Object.keys(savedResults).length} từ đã phân loại`);
  }

  // ── Phase 2: Insert vào entry_tags ──────────────────────
  log('\n🗄️  Phase 2: Insert entry_tags vào DB...');

  // Xóa tags cũ nếu có (để re-classify sạch)
  // Chỉ xóa các tag thuộc 30 topics của mình
  const topicTagIds = Object.values(tagMap);
  await client.query(`
    DELETE FROM entry_tags
    WHERE tag_id = ANY($1::uuid[])
  `, [topicTagIds]);
  log('  ✓ Đã xóa entry_tags cũ của 30 topics');

  // Build lookup: headword → entry_id
  const wordIdMap = Object.fromEntries(allWords.map(w => [w.headword, w.id]));

  let insertCount = 0, skipCount = 0;

  // Insert theo batch để nhanh hơn
  const insertValues = [];
  for (const [headword, topicName] of Object.entries(savedResults)) {
    const entryId = wordIdMap[headword];
    const tagId   = tagMap[topicName];
    if (!entryId || !tagId) { skipCount++; continue; }
    insertValues.push([entryId, tagId]);
  }

  // Bulk insert theo nhóm 100
  for (let i = 0; i < insertValues.length; i += 100) {
    const chunk = insertValues.slice(i, i + 100);
    const values = chunk.map((_, idx) =>
      `($${idx * 2 + 1}, $${idx * 2 + 2})`
    ).join(', ');
    const flat = chunk.flat();

    await client.query(`
      INSERT INTO entry_tags (entry_id, tag_id)
      VALUES ${values}
      ON CONFLICT DO NOTHING
    `, flat);
    insertCount += chunk.length;

    const pct = ((Math.min(i + 100, insertValues.length) / insertValues.length) * 100).toFixed(0);
    process.stdout.write(`\r  🗄️  Insert: ${insertCount}/${insertValues.length} (${pct}%)  `);
  }

  console.log('\n');

  // ── Phase 3: Thống kê kết quả ────────────────────────────
  log('📊 Thống kê phân bổ từ theo topic:\n');

  const { rows: stats } = await client.query(`
    SELECT
      t.name,
      COUNT(et.entry_id) AS word_count
    FROM tags t
    LEFT JOIN entry_tags et ON t.id = et.tag_id
    WHERE t.name = ANY($1)
    GROUP BY t.name
    ORDER BY word_count DESC
  `, [TOPIC_NAMES]);

  const maxCount = Math.max(...stats.map(s => parseInt(s.word_count)));

  console.log('  Topic                      Count  Distribution');
  console.log('  ' + '─'.repeat(60));
  for (const s of stats) {
    const count = parseInt(s.word_count);
    const bar   = '█'.repeat(Math.round((count / maxCount) * 25));
    const empty = '░'.repeat(25 - bar.length);
    console.log(
      `  ${s.name.padEnd(28)} ${String(count).padStart(4)}  ${bar}${empty}`
    );
  }

  const totalTagged = stats.reduce((sum, s) => sum + parseInt(s.word_count), 0);
  const totalWords  = allWords.length;
  console.log(`\n  TỔNG: ${totalTagged}/${totalWords} từ đã được phân loại`);

  // Báo cáo từ chưa phân loại (nếu có)
  const { rows: untagged } = await client.query(`
    SELECT COUNT(*) AS cnt
    FROM dictionary_entries de
    WHERE de.published = true
      AND NOT EXISTS (
        SELECT 1 FROM entry_tags et
        JOIN tags t ON et.tag_id = t.id
        WHERE et.entry_id = de.id AND t.name = ANY($1)
      )
  `, [TOPIC_NAMES]);

  const untaggedCount = parseInt(untagged[0].cnt);
  if (untaggedCount > 0) {
    log(`\n⚠️  ${untaggedCount} từ chưa được tag → chạy lại script để phân loại tiếp`);
  } else {
    log('\n🎉 Tất cả từ đã được phân loại thành công!');
  }

  console.log('\n══════════════════════════════════');
  log(`✅ Hoàn tất! Insert: ${insertCount} | Skip: ${skipCount}`);
  console.log('══════════════════════════════════\n');

  client.release();
  await pool.end();
}

main().catch(err => {
  console.error('\n❌ Lỗi nghiêm trọng:', err.message);
  console.error(err.stack);
  process.exit(1);
});
