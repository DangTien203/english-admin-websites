/**
 * Smart Database Seed — v2 (Production-ready)
 *
 * npm run db:seed            → seed APP data (admins, users, plans, configs, ebooks)
 * npm run db:seed:all        → same as above (no content mode — dictionary imported separately)
 *
 * KHÔNG seed dictionary — dùng import-enriched.mts
 * KHÔNG seed flashcards — dùng seed-flashcards.ts
 * KHÔNG seed games — dùng seed-games.ts
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import pool from '../config/db';

async function ins(client: PoolClient, sql: string, params?: any[]): Promise<any> {
  const { rows } = await client.query(sql, params || []);
  return rows[0]?.id;
}
const hoursAgo  = (h: number) => new Date(Date.now() - h * 3600000);
const daysAgo   = (d: number) => new Date(Date.now() - d * 86400000);
const daysLater = (d: number) => new Date(Date.now() + d * 86400000);
const pick      = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const randInt   = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// ═══════════════════════════════════════════════
//  DATA: 10 Admin Accounts
// ═══════════════════════════════════════════════
const ADMINS: [string, string, string][] = [
  // [email, full_name, role]
  ['admin@english-app.com',        'Nguyễn Quốc Trung',   'super_admin'],
  ['trung.nguyen@english-app.com', 'Trần Minh Đức',       'super_admin'],
  ['duc.tran@english-app.com',     'Lê Thị Phương Anh',   'moderator'],
  ['phuonganh@english-app.com',    'Phạm Hoàng Nam',      'moderator'],
  ['nam.pham@english-app.com',     'Võ Ngọc Hà',         'moderator'],
  ['ha.vo@english-app.com',        'Đặng Xuân Bách',      'content_editor'],
  ['bach.dang@english-app.com',    'Bùi Thị Mai Linh',    'content_editor'],
  ['linh.bui@english-app.com',     'Hoàng Đức Thắng',     'content_editor'],
  ['thang.hoang@english-app.com',  'Ngô Phương Thảo',     'content_editor'],
  ['thao.ngo@english-app.com',     'Dương Văn Kiên',      'content_editor'],
];

// ═══════════════════════════════════════════════
//  DATA: 100 User Accounts (Vietnamese names)
// ═══════════════════════════════════════════════
const LAST_NAMES = ['Nguyễn','Trần','Lê','Phạm','Hoàng','Huỳnh','Võ','Đặng','Bùi','Đỗ','Hồ','Ngô','Dương','Lý','Vũ','Phan','Đinh','Tạ','Lương','Mai'];
const MIDDLE_MALE = ['Văn','Minh','Đức','Quang','Hữu','Thanh','Hoàng','Xuân','Công','Trọng'];
const MIDDLE_FEMALE = ['Thị','Ngọc','Phương','Thanh','Thùy','Hoài','Diệu','Bảo','Khánh','Như'];
const FIRST_MALE = ['An','Bình','Cường','Dũng','Huy','Khải','Long','Minh','Nam','Phong','Quân','Sơn','Tân','Tuấn','Vinh','Đạt','Hùng','Kiên','Lộc','Thịnh'];
const FIRST_FEMALE = ['Anh','Chi','Giang','Hà','Hương','Lan','Linh','Mai','Ngân','Oanh','Phượng','Quyên','Thảo','Trang','Uyên','Vân','Yến','Diễm','Hạnh','Thy'];
const EMAIL_DOMAINS = ['gmail.com','gmail.com','gmail.com','yahoo.com','outlook.com','hotmail.com'];

function generateUsers(count: number) {
  const users: { email: string; name: string; level: string; streak: number; longest: number; status: string; daysAgo: number }[] = [];
  const usedEmails = new Set<string>();

  for (let i = 0; i < count; i++) {
    const isFemale = i % 2 === 1;
    const last = LAST_NAMES[i % LAST_NAMES.length];
    const middle = isFemale
      ? MIDDLE_FEMALE[Math.floor(i / 2) % MIDDLE_FEMALE.length]
      : MIDDLE_MALE[Math.floor(i / 2) % MIDDLE_MALE.length];
    const first = isFemale
      ? FIRST_FEMALE[Math.floor(i / 4) % FIRST_FEMALE.length]
      : FIRST_MALE[Math.floor(i / 4) % FIRST_MALE.length];

    const fullName = `${last} ${middle} ${first}`;

    // Generate unique email
    const emailBase = `${first.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')}.${last.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')}`;
    let email = `${emailBase}@${EMAIL_DOMAINS[i % EMAIL_DOMAINS.length]}`;
    let suffix = 1;
    while (usedEmails.has(email)) {
      email = `${emailBase}${suffix}@${EMAIL_DOMAINS[i % EMAIL_DOMAINS.length]}`;
      suffix++;
    }
    usedEmails.add(email);

    // Realistic distribution: 40% beginner, 35% intermediate, 25% advanced
    const levelRoll = i % 20;
    const level = levelRoll < 8 ? 'beginner' : levelRoll < 15 ? 'intermediate' : 'advanced';

    // Streaks: most users low, some high
    const streak = i < 10 ? randInt(30, 120) : i < 30 ? randInt(5, 30) : randInt(0, 10);
    const longest = streak + randInt(0, 20);

    // 95 active, 3 inactive, 2 banned
    const status = i >= 95 && i < 98 ? 'inactive' : i >= 98 ? 'banned' : 'active';

    const lastActive = i < 20 ? randInt(0, 6) : i < 60 ? randInt(1, 48) : randInt(12, 168);

    users.push({ email, name: fullName, level, streak, longest, status, daysAgo: lastActive });
  }
  return users;
}

// ═══════════════════════════════════════════════
//  SEED FUNCTION
// ═══════════════════════════════════════════════
const seed = async () => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  DB Seed v2 — Production-ready                  ║');
    console.log('╚══════════════════════════════════════════════════╝');

    // ── 0. CLEANUP — Xóa dữ liệu seed cũ ──
    console.log('\n── 0. Cleanup old seed data ──');
    // Thứ tự: con trước, cha sau (FK constraints)
    const cleanupTables = [
      // User activity & progress
      'user_activity_log', 'reviews', 'user_card_progress',
      'retrieval_sessions', 'user_reading_progress',
      'word_lookups', 'user_lesson_progress',
      'user_saved_words', 'user_deck_favorites', 'user_ebook_favorites',
      // Commerce
      'transactions', 'user_subscriptions', 'plan_features', 'subscription_plans',
      // Content references (NOT dictionary — keep that!)
      'lesson_entries', 'lesson_tags', 'lessons',
      'ebook_glossary', 'chapters', 'ebooks',
      // Games (cleaned by seed-games.ts, but also clean here to be safe)
      'game_runs',
      // AI & System
      'batch_entries', 'micro_delta_batches',
      'moderation_logs', 'translation_cache',
      'translation_glossary', 'prompt_templates',
      'notifications', 'audit_logs',
      'system_configs',
      // Users & Admins (last — everything above depends on them)
      'users', 'admin_accounts',
    ];
    for (const table of cleanupTables) {
      try {
        const { rowCount } = await client.query(`DELETE FROM ${table}`);
        if (rowCount && rowCount > 0) process.stdout.write(`  ${table}(${rowCount}) `);
      } catch {
        // Table might not exist yet — skip silently
      }
    }
    console.log('\n  [✓] Cleanup complete');

    const hash = await bcrypt.hash('123123', 10);

    // ── 1. ADMIN ACCOUNTS (10) ──
    console.log('\n── 1. Admin Accounts ──');
    const adminIds: string[] = [];
    for (const [email, name, role] of ADMINS) {
      const id = await ins(client,
        `INSERT INTO admin_accounts (email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(email) DO UPDATE SET full_name=EXCLUDED.full_name, role=EXCLUDED.role
         RETURNING id`,
        [email, hash, name, role]);
      adminIds.push(id);
    }
    const [mainAdmin, , mainMod, , , mainEditor] = adminIds;
    console.log(`  [✓] ${ADMINS.length} admin accounts`);
    ADMINS.forEach(([e,,r]) => console.log(`      ${e.padEnd(38)} → ${r}`));

    // ── 2. USER ACCOUNTS (100) ──
    console.log('\n── 2. User Accounts ──');
    const usersData = generateUsers(100);
    const userIds: string[] = [];
    for (const u of usersData) {
      const id = await ins(client,
        `INSERT INTO users (email, password_hash, full_name, level, streak_current, streak_longest, status, last_active_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(email) DO UPDATE SET full_name=EXCLUDED.full_name, level=EXCLUDED.level
         RETURNING id`,
        [u.email, hash, u.name, u.level, u.streak, u.longest, u.status, hoursAgo(u.daysAgo)]);
      userIds.push(id);
    }
    const activeUsers = usersData.filter(u => u.status === 'active').length;
    const beginners = usersData.filter(u => u.level === 'beginner').length;
    const intermediates = usersData.filter(u => u.level === 'intermediate').length;
    const advanced = usersData.filter(u => u.level === 'advanced').length;
    console.log(`  [✓] ${usersData.length} users (${activeUsers} active, ${usersData.length - activeUsers} inactive/banned)`);
    console.log(`      Levels: ${beginners} beginner, ${intermediates} intermediate, ${advanced} advanced`);

    // ── 3. SUBSCRIPTION PLANS ──
    console.log('\n── 3. Subscription Plans ──');
    const fp = await ins(client,
      `INSERT INTO subscription_plans (name,description,icon_color,price_monthly,price_yearly,sort_order,status)
       VALUES ('Free','Gói miễn phí - bắt đầu học ngay','#94A3B8',0,0,1,'active')
       ON CONFLICT DO NOTHING RETURNING id`);
    const pp = await ins(client,
      `INSERT INTO subscription_plans (name,description,icon_color,price_monthly,price_yearly,trial_days,is_recommended,sort_order,status)
       VALUES ('Premium','Mở khóa toàn bộ tính năng','#2563EB',99000,899000,7,true,2,'active')
       ON CONFLICT DO NOTHING RETURNING id`);
    const pro = await ins(client,
      `INSERT INTO subscription_plans (name,description,icon_color,price_monthly,price_yearly,sort_order,status)
       VALUES ('Pro','Trải nghiệm cao cấp nhất','#F59E0B',199000,1790000,3,'active')
       ON CONFLICT DO NOTHING RETURNING id`);

    // Plan features — only insert if plans were created
    if (fp && pp && pro) {
      const features = [
        // Free: 'no_ads' intentionally absent → mobile treats missing key as "ads shown".
        [fp,'flashcard_max_decks','2'], [fp,'review_modes','swift_choice'], [fp,'premium_ebooks','3'],
        [fp,'offline_access','limited'], [fp,'retrieval_practice_daily','false'], [fp,'translation_daily','5'],
        [pp,'flashcard_max_decks','20'], [pp,'review_modes','swift_choice,cloze_craft,pair_link'],
        [pp,'premium_ebooks','50'], [pp,'no_ads','true'], [pp,'offline_access','full'],
        [pp,'retrieval_practice_daily','10'], [pp,'translation_daily','50'],
        [pro,'flashcard_max_decks','unlimited'], [pro,'review_modes','swift_choice,cloze_craft,pair_link'],
        [pro,'premium_ebooks','unlimited'], [pro,'no_ads','true'], [pro,'offline_access','full'],
        [pro,'retrieval_practice_daily','100'], [pro,'translation_daily','unlimited'],
      ];
      for (const [p,k,v] of features as [string,string,string][])
        await client.query('INSERT INTO plan_features (plan_id,feature_key,feature_value) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[p,k,v]);
      console.log(`  [✓] 3 plans + ${features.length} features`);

      // Subscriptions for some users
      // 60% Free (implicit), 25% Premium, 15% Pro
      let subCount = 0;
      for (let i = 0; i < userIds.length; i++) {
        if (i < 60) continue; // Free users — no row needed
        const plan = i < 85 ? pp : pro;
        const price = i < 85 ? 99000 : 199000;
        const cycle = i % 3 === 0 ? 'yearly' : 'monthly';
        const subId = await ins(client,
          `INSERT INTO user_subscriptions (user_id,plan_id,billing_cycle,price_paid,status,current_period_start,current_period_end)
           VALUES ($1,$2,$3,$4,'active',$5,$6)
           ON CONFLICT DO NOTHING RETURNING id`,
          [userIds[i], plan, cycle, price, daysAgo(randInt(5,25)), daysLater(randInt(5,25))]);
        if (subId) {
          await client.query(
            `INSERT INTO transactions (user_id,subscription_id,type,amount,payment_method,payment_ref,status)
             VALUES ($1,$2,'new',$3,$4,$5,'completed')`,
            [userIds[i], subId, price, pick(['momo','zalopay','bank_transfer']), `TXN_${Date.now()}_${i}`]);
          subCount++;
        }
      }
      console.log(`  [✓] ${subCount} subscriptions + transactions`);
    } else {
      console.log('  [!] Plans already exist — skipped features & subscriptions');
    }

    // // ── 4. EBOOKS (2 mẫu) ──
    // console.log('\n── 4. Sample Ebooks ──');
    // const b1 = await ins(client,
    //   `INSERT INTO ebooks (title,author,description,epub_file_url,level,genre,total_chapters,total_words,required_plan,status,created_by)
    //    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    //    ON CONFLICT DO NOTHING RETURNING id`,
    //   ['The Little Prince','Antoine de Saint-Exupéry','Câu chuyện triết lý về tình bạn, tình yêu và cuộc sống qua hành trình của chàng hoàng tử nhỏ.',
    //    '/uploads/ebooks/little-prince.epub','beginner',['fiction'],5,15200,'free','published',mainEditor]);
    // const b2 = await ins(client,
    //   `INSERT INTO ebooks (title,author,description,epub_file_url,level,genre,total_chapters,total_words,required_plan,status,created_by)
    //    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    //    ON CONFLICT DO NOTHING RETURNING id`,
    //   ['Atomic Habits','James Clear','Phương pháp xây dựng thói quen tốt, loại bỏ thói quen xấu. Cuốn sách best-seller toàn cầu.',
    //    '/uploads/ebooks/atomic-habits.epub','intermediate',['non_fiction','self_help'],8,52000,'premium','published',mainEditor]);

    // if (b1) {
    //   for (const [idx, title, wc] of [[1,'The Pilot',2800],[2,'The Asteroid',3100],[3,'The Rose',2500],[4,'The Fox',3400],[5,'The Journey Home',3200]] as [number,string,number][])
    //     await client.query('INSERT INTO chapters (ebook_id,chapter_index,title,word_count) VALUES ($1,$2,$3,$4)', [b1,idx,title,wc]);
    // }
    // if (b2) {
    //   for (const [idx, title, wc] of [[1,'The Surprising Power of Atomic Habits',6200],[2,'How Your Habits Shape Your Identity',5800],[3,'How to Build Better Habits in 4 Steps',7100],[4,'Make It Obvious',6500],[5,'Make It Attractive',5900],[6,'Make It Easy',6100],[7,'Make It Satisfying',5500],[8,'Advanced Tactics',4900]] as [number,string,number][])
    //     await client.query('INSERT INTO chapters (ebook_id,chapter_index,title,word_count) VALUES ($1,$2,$3,$4)', [b2,idx,title,wc]);
    // }
    // console.log('  [✓] 2 ebooks + 13 chapters');

    // // Reading progress for some users
    // if (b1 && b2) {
    //   for (let i = 0; i < 15; i++) {
    //     const ebook = i < 10 ? b1 : b2;
    //     const maxCh = i < 10 ? 5 : 8;
    //     const ch = randInt(1, maxCh);
    //     await client.query(
    //       `INSERT INTO user_reading_progress (user_id,ebook_id,current_chapter,progress,total_time_sec,words_looked_up,started_at,last_read_at)
    //        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    //       [userIds[i], ebook, ch, +(ch/maxCh).toFixed(2), randInt(1200,9000), randInt(5,80), daysAgo(randInt(3,20)), hoursAgo(randInt(1,72))]);
    //   }
    //   console.log('  [✓] 15 reading progress records');
    // }

    // ── 5. SYSTEM CONFIGS ──
    console.log('\n── 5. System Configs ──');
    const configs = [
      ['leitner_intervals', JSON.stringify([1,2,4,7,14]), 'Days between reviews per box (Box 1→5)'],
      ['leitner_intervals_days', JSON.stringify([1,2,4,7,14]), 'Interval days for Box 1..5'],
      ['cards_per_session', JSON.stringify(20), 'Cards per study session'],
      ['gpt_active_model', JSON.stringify('gpt-4o'), 'Active GPT model for retrieval practice'],
      ['tts_default_voice', JSON.stringify('en-US-Wavenet-D'), 'Default TTS voice'],
      ['maintenance_mode', JSON.stringify({enabled: false}), 'Maintenance mode toggle'],
      ['app_version_min', JSON.stringify('1.0.0'), 'Minimum app version required'],
      ['daily_review_reminder', JSON.stringify({enabled: true, time: '08:00'}), 'Daily review reminder config'],
    ];
    for (const [k, v, d] of configs)
      await client.query(
        'INSERT INTO system_configs (config_key,config_value,description,updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT(config_key) DO NOTHING',
        [k, v, d, mainAdmin]);
    console.log(`  [✓] ${configs.length} system configs`);

    // ── 6. PROMPT TEMPLATE ──
    await client.query(
      `INSERT INTO prompt_templates (name,description,model,system_prompt,expected_schema,version,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      ['Retrieval Grader v1','Chấm ngữ pháp và ngữ cảnh cho Retrieval Practice','gpt-4o',
       'You are an expert English grammar checker and grader for Vietnamese learners. Grade sentences for grammar, vocabulary usage, and naturalness.',
       JSON.stringify({type:'object',properties:{score:{type:'number'},feedback:{type:'string'}}}), 1, 'active', mainAdmin]);
    console.log('  [✓] 1 prompt template');

    // ── 7. TRANSLATION GLOSSARY ──
    const glossary = [
      ['machine learning','học máy','tech'], ['database','cơ sở dữ liệu','tech'],
      ['spaced repetition','lặp lại ngắt quãng','education'], ['flashcard','thẻ ghi nhớ','education'],
      ['pronunciation','phát âm','language'], ['vocabulary','từ vựng','language'],
    ];
    for (const [en,vi,dom] of glossary)
      await client.query('INSERT INTO translation_glossary (term_en,translation_vi,domain,created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [en,vi,dom,mainEditor]);
    console.log(`  [✓] ${glossary.length} glossary terms`);

    // ── 8. AUDIT LOG + NOTIFICATIONS ──
    await client.query(
      `INSERT INTO audit_logs (admin_id,action,module,target_type,target_label,details,ip_address)
       VALUES ($1,'LOGIN','auth','admin',$2,$3,'103.45.67.89')`,
      [mainAdmin, ADMINS[0][0], JSON.stringify({method:'password',browser:'Chrome 128'})]);
    await client.query(
      `INSERT INTO notifications (admin_id,type,title,message,link_url)
       VALUES ($1,'system_alert','Hệ thống đã sẵn sàng','Database seeded thành công. Sẵn sàng sử dụng.','/dashboard')`,
      [mainAdmin]);
    console.log('  [✓] audit log + notification');

    // ── 9. ACTIVITY LOGS (realistic user activity) ──
    console.log('\n── 6. User Activity Logs ──');
    const activities = [
      'flashcard_session', 'review_session', 'ebook_read', 'game_play',
      'lesson_view', 'dictionary_lookup', 'retrieval_practice',
    ];
    let actCount = 0;
    for (let i = 0; i < 30; i++) {
      const userId = userIds[i % userIds.length];
      const numActivities = randInt(1, 5);
      for (let j = 0; j < numActivities; j++) {
        const action = pick(activities);
        await client.query(
          'INSERT INTO user_activity_log (user_id,action,details,duration_sec,created_at) VALUES ($1,$2,$3,$4,$5)',
          [userId, action, JSON.stringify({session: j+1}), randInt(60, 3600), hoursAgo(randInt(1, 168))]);
        actCount++;
      }
    }
    console.log(`  [✓] ${actCount} activity logs`);

    await client.query('COMMIT');

    console.log('\n══════════════════════════════════════════════════');
    console.log('✅ Seed v2 complete!');
    console.log('══════════════════════════════════════════════════\n');
    console.log('  ADMIN ACCOUNTS (password: 123123)');
    console.log('  ─────────────────────────────────────────────');
    ADMINS.forEach(([e,,r]) => console.log(`  ${e.padEnd(38)} → ${r}`));
    console.log('\n  USER ACCOUNTS (password: 123123)');
    console.log(`  100 users — first: ${usersData[0].email}`);
    console.log(`              last:  ${usersData[99].email}\n`);

  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('\n❌ Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

seed();