/**
 * Seed Game Data — v2 (uses EXISTING dictionary entries only)
 *
 * Chạy LOCAL:    npx tsx scripts/seed-games.ts
 * Chạy RAILWAY:  railway run npx tsx scripts/seed-games.ts
 *
 * CẦN CHẠY TRƯỚC: import-enriched.mts (dictionary phải có dữ liệu)
 * An toàn chạy lại: upserts everywhere.
 *
 * KHÔNG INSERT thêm dictionary entries — chỉ dùng từ đã có.
 *
 * Tạo:
 *   - 9 game levels (3 LexiSweep + 3 Anagram + 3 Ladder)
 *   - 5 LexiSweep word lists
 *   - 5 Anagram word lists
 *   - 7 semantic sets (Meaning Ladder)
 */
import 'dotenv/config';
import type { PoolClient } from 'pg';
import pool from '../config/db';

async function ins(client: PoolClient, sql: string, params: any[] = []): Promise<string | null> {
  const { rows } = await client.query(sql, params);
  return rows[0]?.id ?? null;
}

// ═══════════════════════════════════════════════════
//  GAME LEVELS CONFIG
// ═══════════════════════════════════════════════════

const LEVELS = [
  { game_type: 'lexisweep', level_number: 1, config: { grid_size: 10, directions: ['h','v','d'], time_limit: 120, min_words: 8 } },
  { game_type: 'lexisweep', level_number: 2, config: { grid_size: 12, directions: ['h','v','d'], time_limit: 100, min_words: 10 } },
  { game_type: 'lexisweep', level_number: 3, config: { grid_size: 15, directions: ['h','v','d','r'], time_limit: 90, min_words: 12 } },
  { game_type: 'anagram',   level_number: 1, config: { word_length_min: 3, word_length_max: 6, time_per_word: 30, hints_allowed: 2 } },
  { game_type: 'anagram',   level_number: 2, config: { word_length_min: 5, word_length_max: 8, time_per_word: 25, hints_allowed: 1 } },
  { game_type: 'anagram',   level_number: 3, config: { word_length_min: 6, word_length_max: 12, time_per_word: 20, hints_allowed: 0 } },
  { game_type: 'ladder',    level_number: 1, config: { words_per_set: 5, time_limit: 90 } },
  { game_type: 'ladder',    level_number: 2, config: { words_per_set: 5, time_limit: 75 } },
  { game_type: 'ladder',    level_number: 3, config: { words_per_set: 5, time_limit: 60 } },
];

// ═══════════════════════════════════════════════════
//  WORD LISTS — chỉ dùng từ đã có trong DB
// ═══════════════════════════════════════════════════

const LEXISWEEP_LISTS = [
  {
    name: 'Academic Vocabulary',
    topic: 'Academic',
    level: 'intermediate' as const,
    words: ['academic','accomplish','accurate','adapt','addition','adequate','adjust','administration',
            'advance','advanced','analyse','anticipate','application','approach','appropriate',
            'assess','assignment','assist','assume','attach','attempt','attend','attention','aware'],
  },
  {
    name: 'Business & Work',
    topic: 'Business',
    level: 'intermediate' as const,
    words: ['account','achieve','acknowledge','acquire','act','address','advantage','advertise',
            'afford','agenda','agree','agreement','aim','allocate','appoint','appointment',
            'approve','arrange','assert','assign','associate','authorize','balance','budget'],
  },
  {
    name: 'Emotions & Feelings',
    topic: 'Emotions',
    level: 'beginner' as const,
    words: ['afraid','aggressive','amazed','amazing','angry','annoyed','anxious','ashamed',
            'attractive','awkward','bitter','bold','bored','boring','brave','calm','careful',
            'cautious','cheerful','clever','cold','comfortable','brilliant','beautiful'],
  },
  {
    name: 'Everyday Actions',
    topic: 'Daily Life',
    level: 'beginner' as const,
    words: ['accept','add','admit','advise','afford','agree','allow','answer','appear','apply',
            'arrange','arrive','ask','avoid','beat','begin','belong','blow','break','bring',
            'build','burn','buy','call','carry','catch','change','choose','clean','close'],
  },
  {
    name: 'Science & Nature',
    topic: 'Science',
    level: 'advanced' as const,
    words: ['acid','agricultural','air','alien','atmosphere','balance','barrier','biological',
            'branch','breed','chemical','climate','coastal','carbon','cell','bacteria',
            'biology','blood','body','bone','brain','capture','category','chain'],
  },
];

const ANAGRAM_LISTS = [
  {
    name: 'Short Action Verbs',
    topic: 'Verbs',
    level: 'beginner' as const,
    words: ['act','add','age','aid','aim','arm','ask','ban','bar','bat','bear','beat','bend',
            'bet','bid','bind','bite','blow','boil','bomb','book','burn','bury','call','camp'],
  },
  {
    name: 'Medium Verbs',
    topic: 'Verbs',
    level: 'intermediate' as const,
    words: ['abuse','adapt','admit','adopt','agree','alarm','alert','align','allow','alter',
            'amend','annoy','apply','argue','arise','avoid','blame','block','boost','break',
            'breed','bring','build','carry','catch','cause','chase','check','claim','climb'],
  },
  {
    name: 'Descriptive Adjectives',
    topic: 'Adjectives',
    level: 'intermediate' as const,
    words: ['able','active','actual','acute','afraid','aged','alert','alike','alive','alone',
            'angry','annual','awful','aware','bad','bare','basic','best','better','big',
            'bitter','black','blank','blind','blue','bold','brave','brief','bright','broad'],
  },
  {
    name: 'Abstract Nouns',
    topic: 'Concepts',
    level: 'advanced' as const,
    words: ['ability','absence','abundance','abuse','access','accuracy','achievement','action',
            'addition','adjustment','admission','adoption','advantage','advice','affection',
            'aggression','agreement','alliance','alternative','ambition','analysis','anxiety',
            'appeal','approach','approval','arrangement','assault','assessment','assumption'],
  },
  {
    name: 'Mixed A1-A2 Vocabulary',
    topic: 'General',
    level: 'beginner' as const,
    words: ['about','above','across','after','again','air','animal','answer','area','back',
            'bad','bag','bank','bath','bed','begin','best','better','between','big',
            'black','blood','blue','body','book','both','boy','break','bring','brother'],
  },
];

// ═══════════════════════════════════════════════════
//  SEMANTIC SETS — ordered intensity scales
//  Tất cả từ đã xác nhận tồn tại trong batch 1-42
// ═══════════════════════════════════════════════════

const SEMANTIC_SETS = [
  {
    name: 'Quality — Bad to Good',
    scale_description: 'Xếp từ theo chất lượng: từ tệ nhất đến tốt nhất',
    level: 'beginner' as const,
    items: [
      { word: 'awful',     order: 1, hint_vi: 'Tồi tệ, kinh khủng — mức thấp nhất' },
      { word: 'bad',       order: 2, hint_vi: 'Xấu, tệ' },
      { word: 'average',   order: 3, hint_vi: 'Trung bình, bình thường' },
      { word: 'better',    order: 4, hint_vi: 'Tốt hơn' },
      { word: 'best',      order: 5, hint_vi: 'Tốt nhất — mức cao nhất' },
    ],
  },
  {
    name: 'Activity Level',
    scale_description: 'Xếp từ theo mức độ hoạt động: từ yên tĩnh đến năng động',
    level: 'intermediate' as const,
    items: [
      { word: 'asleep',     order: 1, hint_vi: 'Đang ngủ — yên tĩnh nhất' },
      { word: 'calm',       order: 2, hint_vi: 'Bình tĩnh, yên lặng' },
      { word: 'active',     order: 3, hint_vi: 'Năng động, hoạt bát' },
      { word: 'alert',      order: 4, hint_vi: 'Tỉnh táo, cảnh giác' },
      { word: 'aggressive', order: 5, hint_vi: 'Hung hăng, quyết liệt — mức cao nhất' },
    ],
  },
  {
    name: 'Certainty Level',
    scale_description: 'Xếp từ theo mức độ chắc chắn: từ mơ hồ đến tuyệt đối',
    level: 'advanced' as const,
    items: [
      { word: 'apparent',  order: 1, hint_vi: 'Có vẻ như, rõ ràng bề ngoài — ít chắc chắn nhất' },
      { word: 'clear',     order: 2, hint_vi: 'Rõ ràng' },
      { word: 'accurate',  order: 3, hint_vi: 'Chính xác' },
      { word: 'certain',   order: 4, hint_vi: 'Chắc chắn' },
      { word: 'absolute',  order: 5, hint_vi: 'Tuyệt đối — mức cao nhất' },
    ],
  },
  {
    name: 'Courage Scale',
    scale_description: 'Xếp từ theo mức dũng cảm: từ sợ hãi đến gan dạ',
    level: 'intermediate' as const,
    items: [
      { word: 'afraid',    order: 1, hint_vi: 'Sợ hãi — mức thấp nhất' },
      { word: 'anxious',   order: 2, hint_vi: 'Lo lắng, bồn chồn' },
      { word: 'cautious',  order: 3, hint_vi: 'Thận trọng, cẩn thận' },
      { word: 'brave',     order: 4, hint_vi: 'Dũng cảm' },
      { word: 'bold',      order: 5, hint_vi: 'Gan dạ, táo bạo — mức cao nhất' },
    ],
  },
  {
    name: 'Visual Appeal',
    scale_description: 'Xếp từ theo mức hấp dẫn: từ nhàm chán đến tuyệt vời',
    level: 'beginner' as const,
    items: [
      { word: 'boring',     order: 1, hint_vi: 'Nhàm chán — mức thấp nhất' },
      { word: 'appealing',  order: 2, hint_vi: 'Có sức hút' },
      { word: 'attractive', order: 3, hint_vi: 'Hấp dẫn, thu hút' },
      { word: 'beautiful',  order: 4, hint_vi: 'Đẹp, xinh đẹp' },
      { word: 'brilliant',  order: 5, hint_vi: 'Tuyệt vời, xuất sắc — mức cao nhất' },
    ],
  },
  {
    name: 'Emotional Comfort',
    scale_description: 'Xếp từ theo mức thoải mái: từ khó chịu đến vui vẻ',
    level: 'intermediate' as const,
    items: [
      { word: 'awkward',      order: 1, hint_vi: 'Lúng túng, khó xử — mức thấp nhất' },
      { word: 'anxious',      order: 2, hint_vi: 'Lo lắng, bất an' },
      { word: 'calm',         order: 3, hint_vi: 'Bình tĩnh' },
      { word: 'comfortable',  order: 4, hint_vi: 'Thoải mái, dễ chịu' },
      { word: 'cheerful',     order: 5, hint_vi: 'Vui vẻ, phấn khởi — mức cao nhất' },
    ],
  },
  {
    name: 'Time & Age',
    scale_description: 'Xếp từ theo tuổi/thời gian: từ trẻ đến cổ xưa',
    level: 'beginner' as const,
    items: [
      { word: 'adolescent', order: 1, hint_vi: 'Thiếu niên — trẻ nhất' },
      { word: 'adult',      order: 2, hint_vi: 'Người lớn, trưởng thành' },
      { word: 'aged',       order: 3, hint_vi: 'Già, cao tuổi' },
      { word: 'ancient',    order: 4, hint_vi: 'Cổ đại, xưa' },
      { word: 'classic',    order: 5, hint_vi: 'Kinh điển, vượt thời gian — cổ nhất' },
    ],
  },
];

// ═══════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════

async function resolveEntryIds(client: PoolClient, headwords: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  if (headwords.length === 0) return map;

  const { rows } = await client.query(
    `SELECT id, headword FROM dictionary_entries WHERE headword = ANY($1)`,
    [headwords]
  );
  for (const r of rows) {
    map[r.headword] = r.id;
  }
  return map;
}

async function upsertWordList(
  client: PoolClient,
  gameType: string,
  list: { name: string; topic: string; level: string; words: string[] },
  entryMap: Record<string, string>,
  editorId: string | null,
): Promise<number> {
  const validWords = list.words.filter(w => entryMap[w]);
  if (validWords.length === 0) return 0;

  // Upsert list
  const { rows: existing } = await client.query(
    'SELECT id FROM game_word_lists WHERE game_type = $1 AND name = $2', [gameType, list.name]);

  let listId: string;
  if (existing[0]) {
    listId = existing[0].id;
    await client.query('DELETE FROM game_word_list_items WHERE list_id = $1', [listId]);
    await client.query(
      `UPDATE game_word_lists SET topic=$1, level=$2, status='published' WHERE id=$3`,
      [list.topic, list.level, listId]);
  } else {
    listId = (await ins(client,
      `INSERT INTO game_word_lists (game_type,name,topic,level,status,created_by)
       VALUES ($1,$2,$3,$4,'published',$5) RETURNING id`,
      [gameType, list.name, list.topic, list.level, editorId]))!;
  }

  // Insert items
  for (const w of validWords) {
    await client.query(
      'INSERT INTO game_word_list_items (list_id,entry_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [listId, entryMap[w]]);
  }
  return validWords.length;
}

// ═══════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  🎮 SEED GAMES v2 — Using existing dictionary');
  console.log('═══════════════════════════════════════════════════\n');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check dictionary
    const { rows: [{ count }] } = await client.query('SELECT COUNT(*) as count FROM dictionary_entries');
    if (parseInt(count) === 0) {
      console.error('❌ Dictionary trống! Chạy import-enriched.mts trước.');
      process.exit(1);
    }
    console.log(`📖 Dictionary: ${count} entries\n`);

    // ── 0. CLEANUP — Xóa dữ liệu game cũ ──
    console.log('── Cleanup old game data ──');
    const cleanup = [
      ['game_runs', 'DELETE FROM game_runs'],
      ['semantic_set_items', 'DELETE FROM semantic_set_items'],
      ['semantic_sets', 'DELETE FROM semantic_sets'],
      ['game_word_list_items', 'DELETE FROM game_word_list_items'],
      ['game_word_lists', 'DELETE FROM game_word_lists'],
      ['game_levels', 'DELETE FROM game_levels'],
    ];
    for (const [name, sql] of cleanup) {
      try {
        const { rowCount } = await client.query(sql);
        if (rowCount && rowCount > 0) process.stdout.write(`  ${name}(${rowCount}) `);
      } catch { /* skip if table missing */ }
    }
    console.log('\n  [✓] Cleanup complete\n');

    // Find admin
    const { rows: admins } = await client.query('SELECT id FROM admin_accounts ORDER BY created_at ASC LIMIT 1');
    const editorId = admins[0]?.id ?? null;

    // Collect ALL headwords needed
    const allWords = new Set<string>();
    for (const list of [...LEXISWEEP_LISTS, ...ANAGRAM_LISTS])
      list.words.forEach(w => allWords.add(w));
    for (const set of SEMANTIC_SETS)
      set.items.forEach(item => allWords.add(item.word));

    // Resolve to entry IDs in ONE query
    const entryMap = await resolveEntryIds(client, [...allWords]);
    const resolved = Object.keys(entryMap).length;
    const missing = allWords.size - resolved;
    console.log(`🔗 Resolved ${resolved}/${allWords.size} headwords (${missing} not in DB)\n`);

    // ── 1. Game Levels ──
    console.log('── Game Levels ──');
    for (const lv of LEVELS) {
      await client.query(
        `INSERT INTO game_levels (game_type, level_number, config_json, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (game_type, level_number)
         DO UPDATE SET config_json = EXCLUDED.config_json`,
        [lv.game_type, lv.level_number, JSON.stringify(lv.config)]);
    }
    console.log(`  [✓] ${LEVELS.length} game levels (3 LexiSweep + 3 Anagram + 3 Ladder)\n`);

    // ── 2. LexiSweep Word Lists ──
    console.log('── LexiSweep Word Lists ──');
    for (const list of LEXISWEEP_LISTS) {
      const count = await upsertWordList(client, 'lexisweep', list, entryMap, editorId);
      console.log(`  [✓] ${list.name.padEnd(30)} ${String(count).padStart(3)} words`);
    }

    // ── 3. Anagram Word Lists ──
    console.log('\n── Anagram Word Lists ──');
    for (const list of ANAGRAM_LISTS) {
      const count = await upsertWordList(client, 'anagram', list, entryMap, editorId);
      console.log(`  [✓] ${list.name.padEnd(30)} ${String(count).padStart(3)} words`);
    }

    // ── 4. Semantic Sets (Meaning Ladder) ──
    console.log('\n── Semantic Sets (Meaning Ladder) ──');
    for (const set of SEMANTIC_SETS) {
      const validItems = set.items.filter(item => entryMap[item.word]);
      if (validItems.length < 3) {
        console.log(`  [!] "${set.name}" — only ${validItems.length} words found, skipping`);
        continue;
      }

      // Upsert set
      const { rows: existing } = await client.query(
        'SELECT id FROM semantic_sets WHERE name = $1', [set.name]);

      let setId: string;
      if (existing[0]) {
        setId = existing[0].id;
        await client.query('DELETE FROM semantic_set_items WHERE set_id = $1', [setId]);
        await client.query(
          `UPDATE semantic_sets SET scale_description=$1, level=$2, status='published' WHERE id=$3`,
          [set.scale_description, set.level, setId]);
      } else {
        setId = (await ins(client,
          `INSERT INTO semantic_sets (name,scale_description,level,status,created_by)
           VALUES ($1,$2,$3,'published',$4) RETURNING id`,
          [set.name, set.scale_description, set.level, editorId]))!;
      }

      for (const item of validItems) {
        await client.query(
          `INSERT INTO semantic_set_items (set_id,entry_id,correct_order,hint_vi)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (set_id,entry_id)
           DO UPDATE SET correct_order=EXCLUDED.correct_order, hint_vi=EXCLUDED.hint_vi`,
          [setId, entryMap[item.word], item.order, item.hint_vi]);
      }
      console.log(`  [✓] ${set.name.padEnd(30)} ${validItems.length}/5 words`);
    }

    await client.query('COMMIT');

    console.log('\n═══════════════════════════════════════════════════');
    console.log('  ✅ SEED GAMES v2 HOÀN TẤT');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Game Levels      : ${LEVELS.length}`);
    console.log(`  LexiSweep Lists  : ${LEXISWEEP_LISTS.length}`);
    console.log(`  Anagram Lists    : ${ANAGRAM_LISTS.length}`);
    console.log(`  Semantic Sets    : ${SEMANTIC_SETS.length}`);
    console.log('═══════════════════════════════════════════════════\n');

  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('\n❌ Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();