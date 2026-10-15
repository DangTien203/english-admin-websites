/**
 * Seed Flashcard Decks — 20 decks chuyên nghiệp
 *
 * Chạy LOCAL:    npx tsx scripts/seed-flashcards.ts
 * Chạy RAILWAY:  railway run npx tsx scripts/seed-flashcards.ts
 *
 * CẦN CHẠY TRƯỚC: import-enriched.mts (cần có dictionary_entries trong DB)
 * An toàn chạy lại: upsert decks, ON CONFLICT cards
 *
 * 20 DECKS:
 *   Nhóm 1 (5): CEFR Level    — A1 Starter, A2 Elementary, B1 Intermediate, B2 Upper, C1 Advanced
 *   Nhóm 2 (4): POS           — Power Verbs, Core Nouns, Adjectives, Adverbs
 *   Nhóm 3 (8): Thematic      — Business, Education, Communication, Emotions, Daily Life, Travel, Money, Law
 *   Nhóm 4 (3): Special       — Beginner 300, Irregular Verbs, Multi-POS Words
 */
import 'dotenv/config';
import type { PoolClient } from 'pg';
import pool from '../config/db';

async function ins(client: PoolClient, sql: string, params: any[] = []): Promise<string | null> {
  const { rows } = await client.query(sql, params);
  return rows[0]?.id ?? null;
}

// ═══════════════════════════════════════════════════
//  TAG DEFINITIONS
// ═══════════════════════════════════════════════════

const TAG_NAMES = [
  'IELTS', 'TOEIC', 'Business', 'Daily', 'Academic', 'Travel',
  'Technology', 'Science', 'Emotions', 'Communication', 'Finance',
  'Law & Politics', 'Education', 'Food & Home', 'Beginner', 'Intermediate', 'Advanced',
];

// ═══════════════════════════════════════════════════
//  DECK DEFINITIONS
// ═══════════════════════════════════════════════════

interface DeckDef {
  title: string;
  description: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  tags: string[];
  sort_order: number;
  // Query strategy to find entries
  query: {
    type: 'cefr' | 'pos' | 'cefr_combo' | 'headwords' | 'multi_pos' | 'irregular';
    cefr?: string | string[];
    pos?: string;
    headwords?: string[];
    limit?: number;
  };
}

const DECKS: DeckDef[] = [
  // ── NHÓM 1: CEFR Level (5 decks) ──
  {
    title: 'A1 Starter — Essential Words',
    description: 'Từ vựng nền tảng cho người mới bắt đầu. Những từ đầu tiên bạn cần biết khi học tiếng Anh.',
    level: 'beginner', tags: ['Beginner'], sort_order: 1,
    query: { type: 'cefr', cefr: 'A1' },
  },
  {
    title: 'A2 Elementary — Everyday English',
    description: 'Mở rộng vốn từ giao tiếp hàng ngày. Đủ để xử lý các tình huống thường gặp.',
    level: 'beginner', tags: ['Beginner', 'Daily'], sort_order: 2,
    query: { type: 'cefr', cefr: 'A2' },
  },
  {
    title: 'B1 Intermediate — Building Fluency',
    description: 'Từ vựng trung cấp giúp bạn diễn đạt ý tưởng phức tạp hơn trong giao tiếp và viết.',
    level: 'intermediate', tags: ['Intermediate', 'IELTS'], sort_order: 3,
    query: { type: 'cefr', cefr: 'B1' },
  },
  {
    title: 'B2 Upper-Intermediate — Academic & Professional',
    description: 'Từ vựng học thuật và chuyên nghiệp. Cần thiết cho IELTS 6.0+ và môi trường công sở.',
    level: 'intermediate', tags: ['Intermediate', 'IELTS', 'Academic'], sort_order: 4,
    query: { type: 'cefr', cefr: 'B2' },
  },
  {
    title: 'C1 Advanced — Mastery Level',
    description: 'Từ vựng nâng cao, formal và tinh tế. Dành cho người muốn đạt trình độ gần bản ngữ.',
    level: 'advanced', tags: ['Advanced', 'IELTS', 'Academic'], sort_order: 5,
    query: { type: 'cefr', cefr: 'C1' },
  },

  // ── NHÓM 2: POS (4 decks) ──
  {
    title: 'Power Verbs — Action Words',
    description: 'Những động từ quan trọng nhất trong tiếng Anh. Nắm vững verbs = nắm vững câu.',
    level: 'intermediate', tags: ['IELTS', 'TOEIC'], sort_order: 6,
    query: { type: 'pos', pos: 'verb', limit: 250 },
  },
  {
    title: 'Core Nouns — Things & Concepts',
    description: 'Danh từ cốt lõi mô tả thế giới xung quanh. Từ vật dụng hàng ngày đến khái niệm trừu tượng.',
    level: 'beginner', tags: ['Daily'], sort_order: 7,
    query: { type: 'pos', pos: 'noun', limit: 200 },
  },
  {
    title: 'Describing Words — Adjectives',
    description: 'Tính từ giúp bạn mô tả người, vật, sự việc sinh động và chính xác hơn.',
    level: 'intermediate', tags: ['IELTS', 'Communication'], sort_order: 8,
    query: { type: 'pos', pos: 'adjective', limit: 200 },
  },
  {
    title: 'Adverbs & Connectors',
    description: 'Trạng từ và từ nối nâng cao diễn đạt. Chìa khóa để viết và nói tự nhiên hơn.',
    level: 'intermediate', tags: ['Academic', 'IELTS'], sort_order: 9,
    query: { type: 'pos', pos: 'adverb' },
  },

  // ── NHÓM 3: Thematic (8 decks) ──
  {
    title: 'Business & Workplace',
    description: 'Từ vựng công sở, họp hành, email, đàm phán. Thiết yếu cho môi trường làm việc quốc tế.',
    level: 'intermediate', tags: ['Business', 'TOEIC'], sort_order: 10,
    query: { type: 'headwords', headwords: [
      'account','achieve','acquisition','administration','advantage','advertise','advertising',
      'agency','agenda','agree','agreement','allocate','annual','appoint','appointment',
      'approve','asset','assign','assignment','assist','assistant','associate','authorize',
      'balance','bank','benefit','bid','board','bonus','brand','budget','business',
      'career','client','colleague','commerce','commission','committee','communicate',
      'company','compete','competition','competitive','conduct','conference','confirm',
      'consult','contract','cooperate','corporate','cost','customer','deal','deadline',
      'delegate','deliver','demand','department','develop','director','dismiss','distribute',
      'economy','effective','efficient','employ','employee','employer','enterprise',
      'estimate','evaluate','executive','export','finance','fund','goal','growth',
      'headquarters','hire','import','income','industry','interview','invest','investment',
      'lead','leadership','loss','manage','management','manager','manufacture','market',
      'meeting','negotiate','network','office','operate','opportunity','organize','outcome',
      'partner','partnership','policy','presentation','president','procedure','produce',
      'product','production','professional','profit','progress','project','promote','proposal',
      'recruit','resign','resource','revenue','risk','salary','schedule','sector','share',
      'staff','stakeholder','strategy','supply','target','team','trade','turnover',
    ]},
  },
  {
    title: 'Education & Learning',
    description: 'Từ vựng về trường học, thi cử, nghiên cứu khoa học. Phù hợp cho học sinh, sinh viên.',
    level: 'intermediate', tags: ['Education', 'Academic'], sort_order: 11,
    query: { type: 'headwords', headwords: [
      'ability','academic','academy','access','accomplish','achievement','advanced',
      'analyse','analysis','application','apply','assess','assessment','assignment',
      'attend','attendance','attention','author','bachelor','campus','certificate',
      'chapter','class','classroom','coach','college','concentrate','concept','conclusion',
      'course','curriculum','debate','degree','demonstrate','discipline','discuss',
      'dissertation','educate','education','essay','evaluate','evidence','exam','examine',
      'exercise','experiment','expert','explain','explore','faculty','feedback','finding',
      'focus','foundation','grade','graduate','hypothesis','identify','illustrate',
      'instruction','intellectual','knowledge','learn','lecture','library','literature',
      'major','method','module','observe','participate','philosophy','practice','present',
      'principle','professor','program','qualify','question','quiz','read','reference',
      'research','result','review','scholar','scholarship','school','seminar','skill',
      'solution','student','study','subject','submit','summarize','summary','syllabus',
      'teach','teacher','test','theory','thesis','train','training','tutor','university',
    ]},
  },
  {
    title: 'Communication & Social',
    description: 'Từ vựng giao tiếp, tranh luận, thuyết phục. Kỹ năng sống thiết yếu.',
    level: 'intermediate', tags: ['Communication', 'Daily'], sort_order: 12,
    query: { type: 'headwords', headwords: [
      'accept','accuse','acknowledge','address','admit','advise','advice','advocate',
      'agree','agreement','announce','announcement','answer','apologize','apology',
      'appeal','argue','argument','ask','assert','attach','blame','call','claim',
      'clarify','comment','communicate','communication','complain','complaint','confirm',
      'convince','criticize','debate','declare','defend','deny','describe','discuss',
      'discussion','emphasize','encourage','excuse','explain','express','feedback',
      'forgive','greet','imply','indicate','inform','insist','interrupt','introduce',
      'invite','joke','justify','mention','message','negotiate','object','opinion',
      'persuade','praise','promise','propose','protest','question','recommend','refuse',
      'reject','remark','remind','reply','report','request','respond','reveal','say',
      'shout','speak','state','suggest','suggestion','support','tell','thank','threaten',
      'urge','voice','warn','welcome','whisper','write',
    ]},
  },
  {
    title: 'Emotions & Personality',
    description: 'Từ vựng cảm xúc, tính cách, trạng thái tâm lý. Diễn đạt nội tâm chính xác.',
    level: 'intermediate', tags: ['Emotions', 'Daily'], sort_order: 13,
    query: { type: 'headwords', headwords: [
      'admire','afraid','aggressive','amaze','amazed','amazing','anger','angry',
      'annoyed','anxious','anxiety','ashamed','astonished','attitude','attract',
      'attractive','aware','awareness','awkward','bitter','bold','bore','bored','boring',
      'brave','calm','care','careful','careless','cheerful','comfortable','confident',
      'confuse','confused','conscious','content','courage','crazy','cruel','curious',
      'delight','depressed','depression','desperate','determine','determined','disappoint',
      'disappointed','disgusted','eager','embarrass','embarrassed','emotion','emotional',
      'enthusiastic','envy','excited','excitement','exhausted','fear','fierce','fond',
      'fortunate','friendly','frightened','frustrate','frustrated','furious','generous',
      'gentle','glad','grateful','guilty','hate','honest','hope','hopeful','hostile',
      'humble','humour','impatient','impressed','inspire','irritated','jealous','joy',
      'keen','kind','lonely','love','loyal','mad','mercy','miserable','mood','nervous',
      'optimistic','passion','passionate','patient','peaceful','pleased','pride','proud',
      'regret','relief','reluctant','sad','satisfaction','satisfied','scared','sensitive',
      'shame','shock','shy','sincere','stress','stressed','stubborn','sympathy',
      'temper','tense','thankful','tired','trust','upset','warm','willing','worried','worry',
    ]},
  },
  {
    title: 'Food, Home & Daily Life',
    description: 'Từ vựng đời sống hàng ngày: ăn uống, nấu nướng, nhà cửa, sinh hoạt.',
    level: 'beginner', tags: ['Daily', 'Food & Home', 'Beginner'], sort_order: 14,
    query: { type: 'headwords', headwords: [
      'afternoon','alarm','apartment','apple','bag','bake','banana','bath','bathroom',
      'bean','bed','bedroom','beef','beer','bell','bite','bitter','blanket','block',
      'board','boil','bottle','bowl','box','bread','breakfast','bridge','brush','burn',
      'bus','butter','cake','candle','carpet','ceiling','chair','cheese','chicken',
      'clean','clock','clothes','coat','coffee','cook','cooker','cooking','cool','cup',
      'cupboard','curtain','cushion','cycle','dairy','decorate','dinner','dish','door',
      'dress','drink','drive','dry','dust','eat','egg','electricity','elevator','envelope',
      'evening','fan','fence','flat','floor','flower','food','fork','fresh','fridge',
      'fruit','furniture','garage','garden','gas','gate','glass','grocery','heat',
      'home','hot','house','household','hungry','iron','jam','jeans','juice','key',
      'kitchen','knife','lamp','laundry','lemon','lift','light','living','lunch',
      'meal','meat','menu','microwave','milk','mirror','morning','mug','neighbour',
      'night','noon','nut','oven','pan','pepper','pillow','plate','plug','pot',
      'recipe','refrigerator','rice','roof','room','salt','sandwich','sauce','shelf',
      'shirt','shoe','shop','shopping','shower','sink','sleep','slice','smoke','snack',
      'soap','sock','sofa','soup','spoon','stairs','stove','sugar','supper','table',
      'tea','toast','toilet','tomato','toothbrush','towel','vegetable','wall','wash',
      'water','window','wine',
    ]},
  },
  {
    title: 'Travel & Places',
    description: 'Từ vựng du lịch, địa điểm, phương tiện. Tự tin khám phá thế giới bằng tiếng Anh.',
    level: 'beginner', tags: ['Travel', 'Daily'], sort_order: 15,
    query: { type: 'headwords', headwords: [
      'abroad','accommodation','adventure','aircraft','airline','airport','arrive',
      'attraction','backpack','bag','beach','board','boat','book','border','bridge',
      'bus','cabin','camp','cancel','capital','car','check','city','climate','coast',
      'compass','continent','country','crowd','cruise','culture','customs','delay',
      'departure','desert','destination','discover','distance','downtown','east','embassy',
      'emergency','excursion','expedition','explore','ferry','flight','foreign','forest',
      'gallery','guide','harbour','highway','hike','holiday','horizon','hostel','hotel',
      'island','journey','jungle','lake','land','landscape','lane','luggage','map',
      'monument','mountain','museum','nature','north','ocean','park','passenger',
      'passport','path','peak','pier','pilot','planet','platform','port','railway',
      'region','resort','restaurant','river','road','route','sail','scenery','sea',
      'shore','sight','sightseeing','south','souvenir','station','subway','suitcase',
      'terminal','ticket','tour','tourism','tourist','traffic','trail','train','transport',
      'travel','trip','valley','vehicle','village','visit','visitor','voyage','west','zoo',
    ]},
  },
  {
    title: 'Money & Finance',
    description: 'Từ vựng tài chính, mua sắm, kinh tế. Quản lý tiền bạc bằng tiếng Anh.',
    level: 'intermediate', tags: ['Finance', 'Business'], sort_order: 16,
    query: { type: 'headwords', headwords: [
      'account','afford','allowance','amount','asset','auction','balance','bank',
      'bargain','bill','bond','bonus','borrow','brand','budget','buy','cash','charge',
      'cheap','cheque','coin','commerce','commission','compensation','consumer','cost',
      'credit','currency','customer','deal','debt','deficit','demand','deposit','discount',
      'distribute','dividend','donate','donation','earn','economic','economy','employ',
      'estimate','exchange','expense','export','fee','finance','financial','fine','fortune',
      'free','fund','funding','gain','goods','grant','gross','growth','import','income',
      'increase','inflation','insurance','interest','invest','investment','invoice','labour',
      'lend','loan','loss','manufacture','market','merchandise','money','mortgage','net',
      'offer','order','owe','own','pay','payment','pension','percentage','poverty',
      'premium','price','product','profit','property','purchase','rate','receipt','reduce',
      'reduction','refund','rent','retail','revenue','rich','risk','salary','sale','save',
      'saving','sell','share','shop','spend','stock','subsidy','supply','surplus','tax',
      'trade','transaction','transfer','turnover','value','wage','wealth','wholesale','worth',
    ]},
  },
  {
    title: 'Law, Politics & Society',
    description: 'Từ vựng pháp luật, chính trị, xã hội. Hiểu tin tức và thảo luận chủ đề xã hội.',
    level: 'advanced', tags: ['Law & Politics', 'Academic'], sort_order: 17,
    query: { type: 'headwords', headwords: [
      'abolish','abuse','accuse','acquit','act','administration','adopt','advocate',
      'allegation','allege','alliance','ambassador','amend','amendment','appeal',
      'appoint','approve','arrest','assembly','attorney','authority','authorize','ballot',
      'ban','bill','cabinet','campaign','candidate','capital','census','charge','citizen',
      'civil','claim','coalition','colony','commit','committee','community','congress',
      'conscience','conservative','constitution','consult','convention','convict','corrupt',
      'corruption','council','court','crime','criminal','crisis','crown','debate','decree',
      'defend','democracy','democratic','demonstrate','demonstration','diplomacy','dismiss',
      'dispute','elect','election','embassy','enforce','establish','evidence','execute',
      'federal','fine','forbid','fraud','freedom','govern','government','guilty','hearing',
      'illegal','immigration','impeach','impose','imprison','independence','inspect','jail',
      'judge','judicial','jury','justice','law','lawyer','legal','legislation','legitimate',
      'liberal','liberty','lobby','magistrate','mayor','military','minister','ministry',
      'monarchy','municipal','nation','negotiate','neutral','nominate','offence','official',
      'opposition','parliament','penalty','permit','petition','plaintiff','plea','pledge',
      'police','policy','political','politician','politics','poll','power','president',
      'prison','privacy','prohibit','prosecute','protest','province','refugee','regime',
      'regulation','reign','republic','resign','revolution','right','rule','sanction',
      'senate','sentence','sovereignty','state','statute','sue','supreme','suspect',
      'testimony','treaty','trial','tribunal','verdict','violation','vote','witness',
    ]},
  },

  // ── NHÓM 4: Special (3 decks) ──
  {
    title: 'Beginner Essentials 300',
    description: 'Bộ 300 từ A1+A2 thiết yếu nhất. Học xong bộ này, bạn đã có nền tảng vững chắc.',
    level: 'beginner', tags: ['Beginner', 'Daily'], sort_order: 18,
    query: { type: 'cefr_combo', cefr: ['A1','A2'], limit: 300 },
  },
  {
    title: 'Irregular Verbs — Must Know',
    description: 'Động từ bất quy tắc cần phải nhớ. Nền tảng ngữ pháp tiếng Anh không thể bỏ qua.',
    level: 'beginner', tags: ['Beginner', 'Education'], sort_order: 19,
    query: { type: 'irregular' },
  },
  {
    title: 'Multi-POS Words — Same Word, Different Meaning',
    description: 'Những từ có nhiều loại từ (vừa là noun vừa là verb). Hiểu đúng ngữ cảnh, dùng đúng nghĩa.',
    level: 'intermediate', tags: ['IELTS', 'Academic'], sort_order: 20,
    query: { type: 'multi_pos' },
  },
];

// ═══════════════════════════════════════════════════
//  QUERY STRATEGIES
// ═══════════════════════════════════════════════════

async function getEntryIds(client: PoolClient, query: DeckDef['query']): Promise<string[]> {
  let sql: string;
  let params: any[] = [];

  switch (query.type) {
    case 'cefr':
      sql = `SELECT id FROM dictionary_entries WHERE cefr_level = $1 AND published = true ORDER BY frequency_rank ASC NULLS LAST, headword ASC`;
      params = [query.cefr];
      if (query.limit) sql += ` LIMIT ${query.limit}`;
      break;

    case 'cefr_combo':
      sql = `SELECT id FROM dictionary_entries WHERE cefr_level = ANY($1) AND published = true ORDER BY frequency_rank ASC NULLS LAST, headword ASC`;
      params = [query.cefr as string[]];
      if (query.limit) sql += ` LIMIT ${query.limit}`;
      break;

    case 'pos':
      sql = `SELECT id FROM dictionary_entries WHERE $1 = ANY(pos) AND published = true ORDER BY frequency_rank ASC NULLS LAST, headword ASC`;
      params = [query.pos];
      if (query.limit) sql += ` LIMIT ${query.limit}`;
      break;

    case 'headwords':
      // Find entries matching the given headwords (only those that exist in DB)
      sql = `SELECT id FROM dictionary_entries WHERE headword = ANY($1) AND published = true ORDER BY headword ASC`;
      params = [query.headwords];
      break;

    case 'irregular':
      // Find entries that have word_forms tagged as irregular
      sql = `SELECT DISTINCT de.id FROM dictionary_entries de
             JOIN word_forms wf ON wf.entry_id = de.id
             WHERE 'irregular' = ANY(wf.tags) AND de.published = true
             ORDER BY de.id`;
      break;

    case 'multi_pos':
      // Find entries with 2+ different POS values
      sql = `SELECT id FROM dictionary_entries
             WHERE array_length(pos, 1) >= 2 AND published = true
             ORDER BY frequency_rank ASC NULLS LAST, headword ASC`;
      if (query.limit) sql += ` LIMIT ${query.limit}`;
      break;

    default:
      return [];
  }

  const { rows } = await client.query(sql, params);
  return rows.map((r: any) => r.id);
}

// ═══════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  📚 SEED FLASHCARDS — 20 Professional Decks');
  console.log('═══════════════════════════════════════════════════\n');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check dictionary has entries
    const { rows: [{ count: entryCount }] } = await client.query('SELECT COUNT(*) as count FROM dictionary_entries');
    if (parseInt(entryCount) === 0) {
      console.error('❌ Không có từ nào trong dictionary_entries!');
      console.error('   Chạy import-enriched.mts trước.');
      process.exit(1);
    }
    console.log(`📖 Dictionary: ${entryCount} entries\n`);

    // ── 0. CLEANUP — Xóa decks/cards cũ (chỉ premade, giữ user_created) ──
    console.log('── Cleanup old flashcard data ──');
    // Xóa cards trước (FK → decks), rồi deck_tags, rồi decks
    const { rowCount: cardsDeleted } = await client.query(`
      DELETE FROM cards WHERE deck_id IN (
        SELECT id FROM decks WHERE deck_type IN ('premade','system_generated')
      )
    `);
    const { rowCount: tagsDeleted } = await client.query(`
      DELETE FROM deck_tags WHERE deck_id IN (
        SELECT id FROM decks WHERE deck_type IN ('premade','system_generated')
      )
    `);
    // Xóa user_deck_favorites cho premade decks
    try {
      await client.query(`
        DELETE FROM user_deck_favorites WHERE deck_id IN (
          SELECT id FROM decks WHERE deck_type IN ('premade','system_generated')
        )
      `);
    } catch { /* table might not exist */ }
    const { rowCount: decksDeleted } = await client.query(`
      DELETE FROM decks WHERE deck_type IN ('premade','system_generated')
    `);
    console.log(`  [✓] Deleted: ${decksDeleted || 0} decks, ${cardsDeleted || 0} cards, ${tagsDeleted || 0} deck-tags\n`);

    // Find an admin for created_by
    const { rows: admins } = await client.query('SELECT id FROM admin_accounts ORDER BY created_at ASC LIMIT 1');
    const adminId: string | null = admins[0]?.id ?? null;

    // ── 1. Create tags ──
    console.log('── Tags ──');
    const tagIds: Record<string, string> = {};
    for (const name of TAG_NAMES) {
      const id = await ins(client,
        'INSERT INTO tags (name) VALUES ($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id',
        [name]);
      if (id) tagIds[name] = id;
    }
    console.log(`  [✓] ${TAG_NAMES.length} tags\n`);

    // ── 2. Create decks + cards ──
    console.log('── Decks ──');
    let totalCards = 0;

    for (const deck of DECKS) {
      // Get entry IDs for this deck
      const entryIds = await getEntryIds(client, deck.query);

      if (entryIds.length === 0) {
        console.log(`  [!] "${deck.title}" — 0 entries found, skipping`);
        continue;
      }

      // Upsert deck
      const deckId = await ins(client,
        `INSERT INTO decks (title, description, level, deck_type, status, sort_order, created_by)
         VALUES ($1, $2, $3, 'premade', 'published', $4, $5)
         ON CONFLICT DO NOTHING RETURNING id`,
        [deck.title, deck.description, deck.level, deck.sort_order, adminId]);

      // If deck already exists, find its ID
      let finalDeckId = deckId;
      if (!finalDeckId) {
        const { rows } = await client.query('SELECT id FROM decks WHERE title = $1', [deck.title]);
        finalDeckId = rows[0]?.id;
        if (!finalDeckId) {
          console.log(`  [!] "${deck.title}" — could not create/find deck`);
          continue;
        }
        // Clean existing cards for re-seed
        await client.query('DELETE FROM cards WHERE deck_id = $1', [finalDeckId]);
      }

      // Insert cards
      let cardCount = 0;
      for (let i = 0; i < entryIds.length; i++) {
        try {
          await client.query(
            'INSERT INTO cards (deck_id, entry_id, sort_order) VALUES ($1, $2, $3) ON CONFLICT (deck_id, entry_id) DO NOTHING',
            [finalDeckId, entryIds[i], i]);
          cardCount++;
        } catch { /* skip duplicate */ }
      }

      // Link tags
      for (const tagName of deck.tags) {
        if (tagIds[tagName]) {
          await client.query(
            'INSERT INTO deck_tags (deck_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [finalDeckId, tagIds[tagName]]);
        }
      }

      totalCards += cardCount;
      console.log(`  [✓] ${deck.title.padEnd(50)} ${String(cardCount).padStart(4)} cards`);
    }

    await client.query('COMMIT');

    console.log('\n═══════════════════════════════════════════════════');
    console.log('  ✅ SEED FLASHCARDS HOÀN TẤT');
    console.log(`  Decks: ${DECKS.length} | Total cards: ${totalCards}`);
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