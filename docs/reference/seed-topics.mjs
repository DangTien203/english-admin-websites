// scripts/seed-topics.mjs
// Tạo 30 topics chuẩn vào bảng tags
// Chạy: node scripts/seed-topics.mjs
//
// Thiết kế dựa trên phân tích toàn bộ Oxford 5000 (5,944 entries):
//   Group 1 — Foundations     (A1/A2): core language, time, colors, greetings
//   Group 2 — People & Life   (A1/B1): family, body, emotions, food, home, clothes, transport
//   Group 3 — World & Nature  (A2/B1): animals, plants, weather, geography
//   Group 4 — Society         (B1/B2): education, work, sports, arts, media, shopping
//   Group 5 — Advanced        (B2/C1): technology, science, health, business, politics,
//                                       environment, psychology, academic

import 'dotenv/config';
import pg from 'pg';

const DB_CONFIG = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'your_database',
  user:     process.env.DB_USER     || 'your_user',
  password: process.env.DB_PASSWORD || 'your_password',
};

// ══════════════════════════════════════════════════════════════
//  30 TOPICS — được thiết kế dựa trên phân tích Oxford 5000
// ══════════════════════════════════════════════════════════════
const TOPICS = [

  // ── GROUP 1: FOUNDATIONS / NỀN TẢNG (A1/A2) ──────────────
  {
    name:        'core_language',
    label_en:    'Core Language',
    label_vi:    'Ngôn ngữ cơ bản',
    cefr_focus:  'A1/A2',
    description: 'Articles, pronouns, prepositions, conjunctions, numbers, basic expressions',
    sort_order:  1,
  },
  {
    name:        'time_calendar',
    label_en:    'Time & Calendar',
    label_vi:    'Thời gian & Lịch',
    cefr_focus:  'A1/A2',
    description: 'Days, months, seasons, time expressions, dates, frequency words',
    sort_order:  2,
  },
  {
    name:        'colors_shapes',
    label_en:    'Colors & Shapes',
    label_vi:    'Màu sắc & Hình dạng',
    cefr_focus:  'A1/A2',
    description: 'Colors, shapes, sizes, textures, basic visual descriptors',
    sort_order:  3,
  },
  {
    name:        'greetings_social',
    label_en:    'Greetings & Social',
    label_vi:    'Chào hỏi & Xã giao',
    cefr_focus:  'A1/A2',
    description: 'Greetings, farewells, polite phrases, basic social interactions',
    sort_order:  4,
  },

  // ── GROUP 2: PEOPLE & DAILY LIFE / CON NGƯỜI & CUỘC SỐNG (A1/B1) ──
  {
    name:        'family_relationships',
    label_en:    'Family & Relationships',
    label_vi:    'Gia đình & Mối quan hệ',
    cefr_focus:  'A1/A2',
    description: 'Family members, relatives, friendships, social relationships, love',
    sort_order:  5,
  },
  {
    name:        'body_appearance',
    label_en:    'Body & Appearance',
    label_vi:    'Cơ thể & Ngoại hình',
    cefr_focus:  'A1/B1',
    description: 'Body parts, physical features, appearance, posture, movement',
    sort_order:  6,
  },
  {
    name:        'emotions_feelings',
    label_en:    'Emotions & Feelings',
    label_vi:    'Cảm xúc & Tâm trạng',
    cefr_focus:  'A2/B1',
    description: 'Emotions, feelings, moods, mental states, reactions, attitudes',
    sort_order:  7,
  },
  {
    name:        'character_values',
    label_en:    'Character & Values',
    label_vi:    'Tính cách & Phẩm chất',
    cefr_focus:  'B1/B2',
    description: 'Personality traits, moral values, character descriptions, virtues',
    sort_order:  8,
  },
  {
    name:        'food_drink',
    label_en:    'Food & Drink',
    label_vi:    'Ẩm thực & Đồ uống',
    cefr_focus:  'A1/B1',
    description: 'Foods, drinks, meals, cooking, nutrition, flavors, diet',
    sort_order:  9,
  },
  {
    name:        'home_household',
    label_en:    'Home & Household',
    label_vi:    'Nhà cửa & Gia đình',
    cefr_focus:  'A1/B1',
    description: 'Rooms, furniture, household items, housing, neighborhood',
    sort_order:  10,
  },
  {
    name:        'clothes_fashion',
    label_en:    'Clothes & Fashion',
    label_vi:    'Thời trang & Quần áo',
    cefr_focus:  'A1/B1',
    description: 'Clothing, accessories, fabrics, style, fashion, dress codes',
    sort_order:  11,
  },
  {
    name:        'transport_travel',
    label_en:    'Transport & Travel',
    label_vi:    'Phương tiện & Du lịch',
    cefr_focus:  'A1/B1',
    description: 'Vehicles, transport, journeys, tourism, directions, accommodation',
    sort_order:  12,
  },

  // ── GROUP 3: WORLD & NATURE / THẾ GIỚI & TỰ NHIÊN (A2/B1) ──
  {
    name:        'animals_wildlife',
    label_en:    'Animals & Wildlife',
    label_vi:    'Động vật & Sinh vật',
    cefr_focus:  'A1/B1',
    description: 'Animals, insects, birds, sea creatures, habitats, wildlife',
    sort_order:  13,
  },
  {
    name:        'plants_nature',
    label_en:    'Plants & Nature',
    label_vi:    'Thực vật & Thiên nhiên',
    cefr_focus:  'A2/B1',
    description: 'Plants, trees, flowers, forests, gardens, farming, agriculture',
    sort_order:  14,
  },
  {
    name:        'weather_climate',
    label_en:    'Weather & Climate',
    label_vi:    'Thời tiết & Khí hậu',
    cefr_focus:  'A1/B1',
    description: 'Weather conditions, climate, natural events, temperature, seasons',
    sort_order:  15,
  },
  {
    name:        'geography_places',
    label_en:    'Geography & Places',
    label_vi:    'Địa lý & Địa danh',
    cefr_focus:  'A2/B1',
    description: 'Countries, cities, landforms, regions, directions, landmarks',
    sort_order:  16,
  },

  // ── GROUP 4: SOCIETY & CULTURE / XÃ HỘI & VĂN HÓA (B1/B2) ──
  {
    name:        'education_school',
    label_en:    'Education & School',
    label_vi:    'Giáo dục & Học đường',
    cefr_focus:  'A2/B2',
    description: 'School, university, learning, subjects, exams, academic life',
    sort_order:  17,
  },
  {
    name:        'work_career',
    label_en:    'Work & Career',
    label_vi:    'Nghề nghiệp & Công việc',
    cefr_focus:  'A2/B2',
    description: 'Jobs, workplace, professional life, skills, employment, career',
    sort_order:  18,
  },
  {
    name:        'sports_recreation',
    label_en:    'Sports & Recreation',
    label_vi:    'Thể thao & Giải trí',
    cefr_focus:  'A2/B2',
    description: 'Sports, games, fitness, competitions, leisure activities',
    sort_order:  19,
  },
  {
    name:        'arts_entertainment',
    label_en:    'Arts & Entertainment',
    label_vi:    'Nghệ thuật & Giải trí',
    cefr_focus:  'A2/B2',
    description: 'Music, film, literature, visual arts, performing arts, culture',
    sort_order:  20,
  },
  {
    name:        'media_communication',
    label_en:    'Media & Communication',
    label_vi:    'Truyền thông & Giao tiếp',
    cefr_focus:  'B1/B2',
    description: 'News, media, social networks, communication, journalism, language',
    sort_order:  21,
  },
  {
    name:        'shopping_commerce',
    label_en:    'Shopping & Commerce',
    label_vi:    'Mua sắm & Thương mại',
    cefr_focus:  'A2/B1',
    description: 'Shopping, prices, retail, consumer goods, services, commerce',
    sort_order:  22,
  },

  // ── GROUP 5: ADVANCED / NÂNG CAO (B2/C1) ─────────────────
  {
    name:        'technology_digital',
    label_en:    'Technology & Digital',
    label_vi:    'Công nghệ & Kỹ thuật số',
    cefr_focus:  'B2/C1',
    description: 'Computers, internet, software, digital world, innovation, AI',
    sort_order:  23,
  },
  {
    name:        'science_research',
    label_en:    'Science & Research',
    label_vi:    'Khoa học & Nghiên cứu',
    cefr_focus:  'B2/C1',
    description: 'Sciences, experiments, research methods, discoveries, data, theory',
    sort_order:  24,
  },
  {
    name:        'health_medicine',
    label_en:    'Health & Medicine',
    label_vi:    'Sức khỏe & Y tế',
    cefr_focus:  'B1/C1',
    description: 'Healthcare, medical terms, diseases, treatments, mental health',
    sort_order:  25,
  },
  {
    name:        'business_economy',
    label_en:    'Business & Economy',
    label_vi:    'Kinh doanh & Kinh tế',
    cefr_focus:  'B2/C1',
    description: 'Business, finance, economics, trade, investment, markets',
    sort_order:  26,
  },
  {
    name:        'politics_law',
    label_en:    'Politics & Law',
    label_vi:    'Chính trị & Pháp luật',
    cefr_focus:  'B2/C1',
    description: 'Government, elections, legal system, rights, justice, democracy',
    sort_order:  27,
  },
  {
    name:        'environment_society',
    label_en:    'Environment & Society',
    label_vi:    'Môi trường & Xã hội',
    cefr_focus:  'B2/C1',
    description: 'Environmental issues, climate change, social issues, inequality, diversity',
    sort_order:  28,
  },
  {
    name:        'psychology_mind',
    label_en:    'Psychology & Mind',
    label_vi:    'Tâm lý & Tư duy',
    cefr_focus:  'B2/C1',
    description: 'Psychology, cognition, behavior, mental processes, consciousness',
    sort_order:  29,
  },
  {
    name:        'academic_formal',
    label_en:    'Academic & Formal',
    label_vi:    'Học thuật & Trang trọng',
    cefr_focus:  'B2/C1',
    description: 'Academic writing, formal language, abstract concepts, argumentation',
    sort_order:  30,
  },
];

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Seed Topics → tags table');
  console.log(`  Tổng số topics: ${TOPICS.length}`);
  console.log('═══════════════════════════════════════════════\n');

  const pool   = new pg.Pool(DB_CONFIG);
  const client = await pool.connect();

  let inserted = 0, skipped = 0;

  for (const topic of TOPICS) {
    try {
      await client.query(`
        INSERT INTO tags (id, name, created_at)
        VALUES (uuid_generate_v4(), $1, NOW())
        ON CONFLICT (name) DO NOTHING
      `, [topic.name]);
      inserted++;
      console.log(`  ✅ [${String(topic.sort_order).padStart(2, '0')}] ${topic.name.padEnd(25)} — ${topic.label_vi} (${topic.cefr_focus})`);
    } catch (err) {
      if (err.code === '23505') {
        skipped++;
        console.log(`  ⏭️  [${String(topic.sort_order).padStart(2, '0')}] ${topic.name} — đã tồn tại`);
      } else {
        console.error(`  ❌ ${topic.name}: ${err.message}`);
      }
    }
  }

  console.log('\n══════════════════════════════════');
  console.log(`✅ Đã insert : ${inserted} topics`);
  console.log(`⏭️  Bỏ qua   : ${skipped} topics (đã có)`);
  console.log('══════════════════════════════════\n');

  // Hiển thị bảng tổng kết theo nhóm
  console.log('📋 TOPICS THEO NHÓM:');
  const groups = [
    { label: 'Group 1 — Foundations  (A1/A2)', range: [1, 4]  },
    { label: 'Group 2 — People&Life  (A1/B1)', range: [5, 12] },
    { label: 'Group 3 — World&Nature (A2/B1)', range: [13, 16]},
    { label: 'Group 4 — Society      (B1/B2)', range: [17, 22]},
    { label: 'Group 5 — Advanced     (B2/C1)', range: [23, 30]},
  ];

  for (const g of groups) {
    const inGroup = TOPICS.filter(t => t.sort_order >= g.range[0] && t.sort_order <= g.range[1]);
    console.log(`\n  ${g.label}:`);
    inGroup.forEach(t => {
      console.log(`    ${String(t.sort_order).padStart(2)} | ${t.name.padEnd(25)} | ${t.label_vi}`);
    });
  }

  client.release();
  await pool.end();
  console.log('\n✅ Seed topics hoàn tất!\n');
}

main().catch(err => {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
});

// Export để dùng trong file khác nếu cần
export { TOPICS };
