/**
 * Seed fixed mobile test users and realistic per-user data.
 *
 * Run:
 *   npx tsx scripts/seed-mobile-test-users.ts
 *
 * Scope:
 * - Creates/updates 6 fixed Gmail accounts for mobile testing.
 * - Does not create dictionary entries, ebooks, system flashcard decks, or game configs.
 * - Reads existing content from the database and attaches user-specific data to it.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import pool from '../config/db';

type Tier = 'free' | 'premium' | 'pro';
type Level = 'beginner' | 'intermediate' | 'advanced';
type GameType = 'lexisweep' | 'anagram' | 'ladder';

interface TestUserDef {
  email: string;
  fullName: string;
  tier: Tier;
  level: Level;
}

interface SeededUser extends TestUserDef {
  id: string;
}

interface PlanInfo {
  id: string;
  name: string;
  priceMonthly: number;
  priceYearly: number;
  priceWeekly: number;
}

interface EntryFixture {
  id: string;
  headword: string;
}

interface DeckFixture {
  id: string;
  title: string;
}

interface CardFixture {
  id: string;
  entry_id: string;
  headword: string;
}

interface GameFixtures {
  levels: Record<GameType, string>;
  lexisweepList: { id: string; words: string[] };
  anagramList: { id: string; words: string[] };
  semanticSet: { id: string; entryIds: string[] };
}

interface EbookFixture {
  id: string;
  title: string;
  chapterId: string;
  paragraphIds: string[];
}

interface Fixtures {
  entries: EntryFixture[];
  systemDecks: DeckFixture[];
  systemCards: CardFixture[];
  games: GameFixtures;
  ebook: EbookFixture;
}

const PASSWORD = '123123';

const TEST_USERS: TestUserDef[] = [
  { email: 'johnson113@gmail.com', tier: 'free', fullName: 'Johnson Miller', level: 'beginner' },
  { email: 'peterpan.study@gmail.com', tier: 'free', fullName: 'Peter Pan', level: 'intermediate' },
  { email: 'emilytran27@gmail.com', tier: 'premium', fullName: 'Emily Tran', level: 'intermediate' },
  { email: 'michaelnguyen88@gmail.com', tier: 'premium', fullName: 'Michael Nguyen', level: 'advanced' },
  { email: 'sarahpham2024@gmail.com', tier: 'pro', fullName: 'Sarah Pham', level: 'advanced' },
  { email: 'daviddo.english@gmail.com', tier: 'pro', fullName: 'David Do', level: 'intermediate' },
];

const FEATURE_SETS: Record<Tier, Record<string, string>> = {
  free: {
    flashcard_max_decks: '2',
    review_modes: 'swift_choice',
    premium_ebooks: '3',
    offline_access: 'limited',
    retrieval_practice_daily: 'false',
    translation_daily: '5',
  },
  premium: {
    flashcard_max_decks: '20',
    review_modes: 'swift_choice,cloze_craft,pair_link',
    premium_ebooks: '50',
    no_ads: 'true',
    offline_access: 'full',
    retrieval_practice_daily: '10',
    translation_daily: '50',
  },
  pro: {
    flashcard_max_decks: 'unlimited',
    review_modes: 'swift_choice,cloze_craft,pair_link',
    premium_ebooks: 'unlimited',
    no_ads: 'true',
    offline_access: 'full',
    retrieval_practice_daily: '100',
    translation_daily: 'unlimited',
  },
};

const PLAN_DEFS: Record<Tier, Omit<PlanInfo, 'id'>> = {
  free: {
    name: 'Free',
    priceMonthly: 0,
    priceYearly: 0,
    priceWeekly: 0,
  },
  premium: {
    name: 'Premium',
    priceMonthly: 99000,
    priceYearly: 899000,
    priceWeekly: 25000,
  },
  pro: {
    name: 'Pro',
    priceMonthly: 199000,
    priceYearly: 1790000,
    priceWeekly: 49000,
  },
};

const GAME_SCORE_PROFILES: Record<string, Record<GameType, number>> = {
  'johnson113@gmail.com': { lexisweep: 1320, anagram: 880, ladder: 720 },
  'peterpan.study@gmail.com': { lexisweep: 1450, anagram: 970, ladder: 790 },
  'emilytran27@gmail.com': { lexisweep: 1710, anagram: 1180, ladder: 930 },
  'michaelnguyen88@gmail.com': { lexisweep: 1840, anagram: 1275, ladder: 1010 },
  'sarahpham2024@gmail.com': { lexisweep: 2120, anagram: 1530, ladder: 1220 },
  'daviddo.english@gmail.com': { lexisweep: 1985, anagram: 1410, ladder: 1135 },
};

function daysAgo(days: number, hour = 10): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function addMonths(base: Date, months: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

function emailLocal(email: string): string {
  return email.split('@')[0].replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function takeCircular<T>(items: T[], start: number, count: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    out.push(items[(start + i) % items.length]);
  }
  return out;
}

function asJson(value: unknown): string {
  return JSON.stringify(value);
}

async function upsertPlan(client: PoolClient, tier: Tier): Promise<PlanInfo> {
  const def = PLAN_DEFS[tier];
  const iconColor = tier === 'free' ? '#94A3B8' : tier === 'premium' ? '#2563EB' : '#F59E0B';
  const description = tier === 'free'
    ? 'Free mobile testing plan'
    : tier === 'premium'
      ? 'Premium mobile testing plan'
      : 'Pro mobile testing plan';
  const sortOrder = tier === 'free' ? 1 : tier === 'premium' ? 2 : 3;

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM subscription_plans
      WHERE LOWER(name) = LOWER($1)
      ORDER BY status = 'active' DESC, sort_order ASC, created_at ASC
      LIMIT 1`,
    [def.name],
  );

  let id = existing.rows[0]?.id;
  if (id) {
    await client.query(
      `UPDATE subscription_plans
          SET description = COALESCE(description, $2),
              icon_color = COALESCE(icon_color, $3),
              price_monthly = $4,
              price_yearly = $5,
              price_weekly = $6,
              status = 'active',
              sort_order = $7,
              is_recommended = $8,
              updated_at = NOW()
        WHERE id = $1`,
      [
        id,
        description,
        iconColor,
        def.priceMonthly,
        def.priceYearly,
        def.priceWeekly,
        sortOrder,
        tier === 'premium',
      ],
    );
  } else {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO subscription_plans
         (name, description, icon_color, price_monthly, price_yearly,
          price_weekly, trial_days, is_recommended, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
       RETURNING id`,
      [
        def.name,
        description,
        iconColor,
        def.priceMonthly,
        def.priceYearly,
        def.priceWeekly,
        tier === 'premium' ? 7 : 0,
        tier === 'premium',
        sortOrder,
      ],
    );
    id = inserted.rows[0].id;
  }

  const features = FEATURE_SETS[tier];
  for (const [featureKey, featureValue] of Object.entries(features)) {
    await client.query(
      `INSERT INTO plan_features (plan_id, feature_key, feature_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (plan_id, feature_key)
       DO UPDATE SET feature_value = EXCLUDED.feature_value`,
      [id, featureKey, featureValue],
    );
  }

  return { id, ...def };
}

async function ensurePlans(client: PoolClient): Promise<Record<Tier, PlanInfo>> {
  return {
    free: await upsertPlan(client, 'free'),
    premium: await upsertPlan(client, 'premium'),
    pro: await upsertPlan(client, 'pro'),
  };
}

async function ensurePaymentMethods(
  client: PoolClient,
  plans: Record<Tier, PlanInfo>,
): Promise<string[]> {
  const methods = [
    ['momo', 'Vi Momo', 'ewallet', 1],
    ['bank_transfer', 'Bank Transfer', 'bank', 2],
    ['visa_master', 'Visa / Mastercard', 'card', 3],
  ] as const;

  const methodIds: string[] = [];
  for (const [code, displayName, methodType, sortOrder] of methods) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payment_methods
         (code, display_name, method_type, fee_percent, is_active, sort_order)
       VALUES ($1, $2, $3, 0, TRUE, $4)
       ON CONFLICT (code)
       DO UPDATE SET display_name = payment_methods.display_name,
                     method_type = payment_methods.method_type,
                     is_active = TRUE,
                     sort_order = EXCLUDED.sort_order,
                     updated_at = NOW()
       RETURNING id`,
      [code, displayName, methodType, sortOrder],
    );
    methodIds.push(rows[0].id);
  }

  for (const tier of ['premium', 'pro'] as const) {
    for (const methodId of methodIds) {
      await client.query(
        `INSERT INTO plan_payment_methods (plan_id, payment_method_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [plans[tier].id, methodId],
      );
    }
  }

  return methods.map(([code]) => code);
}

async function loadEntries(client: PoolClient): Promise<EntryFixture[]> {
  const { rows } = await client.query<EntryFixture>(
    `SELECT id, headword
       FROM dictionary_entries
      WHERE published = TRUE
        AND meaning_vi IS NOT NULL
      ORDER BY frequency_rank ASC NULLS LAST, headword ASC
      LIMIT 160`,
  );
  if (rows.length < 40) {
    throw new Error(
      `Need at least 40 existing dictionary entries, found ${rows.length}. Restore/import dictionary first.`,
    );
  }
  return rows;
}

async function loadSystemDecks(client: PoolClient): Promise<DeckFixture[]> {
  const { rows } = await client.query<DeckFixture>(
    `SELECT d.id, d.title
       FROM decks d
      WHERE d.status = 'published'
        AND d.deck_type IN ('premade', 'system_generated')
        AND EXISTS (SELECT 1 FROM cards c WHERE c.deck_id = d.id)
      ORDER BY d.sort_order ASC, d.created_at ASC
      LIMIT 6`,
  );
  if (rows.length < 2) {
    throw new Error(
      `Need at least 2 published system decks with cards, found ${rows.length}. Run scripts/seed-flashcards.ts first.`,
    );
  }
  return rows;
}

async function loadSystemCards(
  client: PoolClient,
  deckIds: string[],
): Promise<CardFixture[]> {
  const { rows } = await client.query<CardFixture>(
    `SELECT c.id, c.entry_id, de.headword
       FROM cards c
       JOIN decks d ON d.id = c.deck_id
       JOIN dictionary_entries de ON de.id = c.entry_id
      WHERE d.id = ANY($1::uuid[])
      ORDER BY d.sort_order ASC, c.sort_order ASC
      LIMIT 80`,
    [deckIds],
  );
  if (rows.length < 20) {
    throw new Error(
      `Need at least 20 cards in existing system decks, found ${rows.length}. Run scripts/seed-flashcards.ts first.`,
    );
  }
  return rows;
}

async function loadGameFixtures(client: PoolClient): Promise<GameFixtures> {
  const levels = {} as Record<GameType, string>;
  for (const type of ['lexisweep', 'anagram', 'ladder'] as const) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM game_levels
        WHERE game_type = $1 AND status = 'active'
        ORDER BY level_number ASC
        LIMIT 1`,
      [type],
    );
    if (!rows[0]) {
      throw new Error(`Missing active game level for ${type}. Run scripts/seed-games.ts first.`);
    }
    levels[type] = rows[0].id;
  }

  const loadWordList = async (type: 'lexisweep' | 'anagram') => {
    const { rows } = await client.query<{ id: string; words: string[] }>(
      `SELECT gwl.id,
              ARRAY_AGG(de.headword ORDER BY de.headword) AS words
         FROM game_word_lists gwl
         JOIN game_word_list_items gwli ON gwli.list_id = gwl.id
         JOIN dictionary_entries de ON de.id = gwli.entry_id
        WHERE gwl.game_type = $1 AND gwl.status = 'published'
        GROUP BY gwl.id, gwl.name
        HAVING COUNT(gwli.entry_id) >= 5
        ORDER BY gwl.name ASC
        LIMIT 1`,
      [type],
    );
    if (!rows[0]) {
      throw new Error(`Missing published ${type} word list. Run scripts/seed-games.ts first.`);
    }
    return rows[0];
  };

  const { rows: semanticRows } = await client.query<{ id: string; entry_ids: string[] }>(
    `SELECT ss.id,
            ARRAY_AGG(ssi.entry_id ORDER BY ssi.correct_order ASC) AS entry_ids
       FROM semantic_sets ss
       JOIN semantic_set_items ssi ON ssi.set_id = ss.id
      WHERE ss.status = 'published'
      GROUP BY ss.id, ss.name
      HAVING COUNT(ssi.entry_id) >= 5
      ORDER BY ss.name ASC
      LIMIT 1`,
  );
  if (!semanticRows[0]) {
    throw new Error('Missing published semantic set. Run scripts/seed-games.ts first.');
  }

  return {
    levels,
    lexisweepList: await loadWordList('lexisweep'),
    anagramList: await loadWordList('anagram'),
    semanticSet: { id: semanticRows[0].id, entryIds: semanticRows[0].entry_ids },
  };
}

async function loadEbookFixture(client: PoolClient): Promise<EbookFixture> {
  const { rows } = await client.query<{
    ebook_id: string;
    title: string;
    chapter_id: string;
    paragraph_ids: string[];
  }>(
    `SELECT e.id AS ebook_id,
            e.title,
            c.id AS chapter_id,
            ARRAY_AGG(p.id ORDER BY p.paragraph_index ASC) AS paragraph_ids
       FROM ebooks e
       JOIN chapters c ON c.ebook_id = e.id
       JOIN paragraphs p ON p.chapter_id = c.id
      WHERE e.status = 'published'
      GROUP BY e.id, e.title, e.required_plan, e.created_at, c.id, c.chapter_index
      HAVING COUNT(p.id) >= 3
      ORDER BY CASE WHEN e.required_plan = 'free' THEN 0 ELSE 1 END,
               e.created_at DESC,
               c.chapter_index ASC
      LIMIT 1`,
  );
  if (!rows[0]) {
    throw new Error(
      'Need at least 1 published ebook with chapters and paragraphs. Import existing ebook data first.',
    );
  }
  return {
    id: rows[0].ebook_id,
    title: rows[0].title,
    chapterId: rows[0].chapter_id,
    paragraphIds: rows[0].paragraph_ids,
  };
}

async function loadFixtures(client: PoolClient): Promise<Fixtures> {
  const entries = await loadEntries(client);
  const systemDecks = await loadSystemDecks(client);
  const systemCards = await loadSystemCards(client, systemDecks.map((d) => d.id));
  const games = await loadGameFixtures(client);
  const ebook = await loadEbookFixture(client);
  return { entries, systemDecks, systemCards, games, ebook };
}

async function cleanupExistingTestData(client: PoolClient): Promise<number> {
  const emails = TEST_USERS.map((u) => u.email);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE email = ANY($1::text[])`,
    [emails],
  );
  const userIds = rows.map((r) => r.id);
  if (userIds.length === 0) return 0;

  const params = [userIds];
  const deleteSql = [
    `DELETE FROM transactions WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM user_subscriptions WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM practice_sessions WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM reviews WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM user_card_progress WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM leitner_reviews WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM leitner_cards WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM retrieval_sessions WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM user_reading_progress WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM word_lookups WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM user_saved_words WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM user_deck_favorites WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM user_ebook_favorites WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM user_notifications WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM user_fcm_tokens WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM game_runs WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM user_activity_log WHERE user_id = ANY($1::uuid[])`,
    `DELETE FROM decks WHERE user_id = ANY($1::uuid[])`,
  ];

  for (const sql of deleteSql) {
    await client.query(sql, params);
  }

  return userIds.length;
}

async function upsertUsers(client: PoolClient): Promise<SeededUser[]> {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const seeded: SeededUser[] = [];

  for (let i = 0; i < TEST_USERS.length; i++) {
    const user = TEST_USERS[i];
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users
         (email, password_hash, full_name, level, status,
          streak_current, streak_longest, last_active_at, last_login_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, NOW(), NOW())
       ON CONFLICT (email)
       DO UPDATE SET password_hash = EXCLUDED.password_hash,
                     full_name = EXCLUDED.full_name,
                     level = EXCLUDED.level,
                     status = 'active',
                     streak_current = EXCLUDED.streak_current,
                     streak_longest = EXCLUDED.streak_longest,
                     last_active_at = NOW(),
                     last_login_at = NOW(),
                     updated_at = NOW()
       RETURNING id`,
      [user.email, passwordHash, user.fullName, user.level, 5 + i, 12 + i * 2],
    );
    seeded.push({ ...user, id: rows[0].id });
  }

  return seeded;
}

async function seedSubscriptions(
  client: PoolClient,
  user: SeededUser,
  plans: Record<Tier, PlanInfo>,
  paymentMethods: string[],
): Promise<number> {
  if (user.tier === 'free') return 0;

  const plan = plans[user.tier];
  const months = user.tier === 'premium' ? 3 : 6;
  const now = new Date();
  let transactionCount = 0;

  for (let monthsBack = months - 1; monthsBack >= 0; monthsBack--) {
    const periodStart = addMonths(now, -monthsBack);
    periodStart.setHours(8, 0, 0, 0);
    const periodEnd = addMonths(periodStart, 1);
    const isCurrentPeriod = monthsBack === 0;
    const status = isCurrentPeriod ? 'active' : 'expired';
    const paymentMethod = paymentMethods[(months - 1 - monthsBack) % paymentMethods.length];
    const txType = monthsBack === months - 1 ? 'new' : 'renew';
    const yyyymm = `${periodStart.getFullYear()}${String(periodStart.getMonth() + 1).padStart(2, '0')}`;

    const { rows: subRows } = await client.query<{ id: string }>(
      `INSERT INTO user_subscriptions
         (user_id, plan_id, billing_cycle, price_paid, status,
          current_period_start, current_period_end, created_at, updated_at)
       VALUES ($1, $2, 'monthly', $3, $4, $5, $6, $5, NOW())
       RETURNING id`,
      [user.id, plan.id, plan.priceMonthly, status, periodStart, periodEnd],
    );

    await client.query(
      `INSERT INTO transactions
         (user_id, subscription_id, type, amount, payment_method,
          payment_ref, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7)`,
      [
        user.id,
        subRows[0].id,
        txType,
        plan.priceMonthly,
        paymentMethod,
        `MBTEST-${emailLocal(user.email)}-${yyyymm}`,
        new Date(periodStart.getTime() + 2 * 60 * 60 * 1000),
      ],
    );
    transactionCount++;
  }

  return transactionCount;
}

async function seedFavoriteSystemDecks(
  client: PoolClient,
  user: SeededUser,
  fixtures: Fixtures,
  index: number,
): Promise<void> {
  const favorites = takeCircular(fixtures.systemDecks, index, 2);
  for (const deck of favorites) {
    await client.query(
      `INSERT INTO user_deck_favorites (user_id, deck_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [user.id, deck.id],
    );
  }
}

async function createUserDeck(
  client: PoolClient,
  user: SeededUser,
  title: string,
  description: string,
  level: Level,
  entries: EntryFixture[],
): Promise<CardFixture[]> {
  const { rows: deckRows } = await client.query<{ id: string }>(
    `INSERT INTO decks
       (title, description, level, deck_type, user_id, status, sort_order)
     VALUES ($1, $2, $3, 'user_created', $4, 'published', 0)
     RETURNING id`,
    [title, description, level, user.id],
  );
  const deckId = deckRows[0].id;
  const cards: CardFixture[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { rows } = await client.query<CardFixture>(
      `INSERT INTO cards (deck_id, entry_id, note_html, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (deck_id, entry_id) DO UPDATE
       SET note_html = EXCLUDED.note_html,
           sort_order = EXCLUDED.sort_order
       RETURNING id, entry_id, $5::text AS headword`,
      [
        deckId,
        entry.id,
        `<p>Mobile test note for <strong>${entry.headword}</strong>.</p>`,
        i + 1,
        entry.headword,
      ],
    );
    cards.push(rows[0]);
  }

  return cards;
}

async function seedUserCreatedFlashcards(
  client: PoolClient,
  user: SeededUser,
  fixtures: Fixtures,
  index: number,
): Promise<CardFixture[]> {
  if (user.tier === 'free') return [];

  const start = 18 + index * 14;
  const dailyEntries = takeCircular(fixtures.entries, start, 8);
  const focusEntries = takeCircular(fixtures.entries, start + 8, 8);
  const shortName = user.fullName.split(' ')[0];

  const dailyCards = await createUserDeck(
    client,
    user,
    `${shortName}'s Daily Review`,
    'Personal mobile test deck with daily review vocabulary.',
    user.level,
    dailyEntries,
  );
  const focusCards = await createUserDeck(
    client,
    user,
    `${shortName}'s Focus Words`,
    'Personal mobile test deck with words saved for focused practice.',
    user.level,
    focusEntries,
  );

  return [...dailyCards, ...focusCards];
}

async function seedCardProgress(
  client: PoolClient,
  user: SeededUser,
  cards: CardFixture[],
  index: number,
): Promise<void> {
  for (let i = 0; i < cards.length; i++) {
    const seen = 2 + ((i + index) % 7);
    const correct = Math.max(1, seen - ((i + index) % 3));
    await client.query(
      `INSERT INTO user_card_progress
         (user_id, card_id, first_seen_at, times_seen, times_correct, last_review)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, card_id)
       DO UPDATE SET first_seen_at = EXCLUDED.first_seen_at,
                     times_seen = EXCLUDED.times_seen,
                     times_correct = EXCLUDED.times_correct,
                     last_review = EXCLUDED.last_review,
                     updated_at = NOW()`,
      [user.id, cards[i].id, daysAgo(14 - (i % 5)), seen, correct, daysAgo(i % 4)],
    );

    if (i < 6) {
      await client.query(
        `INSERT INTO reviews (user_id, card_id, rating, mode, time_ms, correct, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user.id,
          cards[i].id,
          correct >= seen - 1 ? 4 : 2,
          i % 2 === 0 ? 'flashcard' : 'swift_choice',
          900 + i * 170,
          correct >= seen - 1,
          daysAgo(i % 6),
        ],
      );
    }
  }
}

async function seedLeitner(
  client: PoolClient,
  user: SeededUser,
  cards: CardFixture[],
  fallbackEntries: EntryFixture[],
  index: number,
): Promise<void> {
  const entryMap = new Map<string, string>();
  for (const card of cards) entryMap.set(card.entry_id, card.id);

  const entryIds = Array.from(new Set([
    ...cards.map((c) => c.entry_id),
    ...fallbackEntries.map((e) => e.id),
  ])).slice(0, 10);

  for (let i = 0; i < entryIds.length; i++) {
    const boxNumber = (i % 5) + 1;
    const correctStreak = Math.max(0, boxNumber - 1);
    const totalReviews = boxNumber + 2 + (index % 3);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO leitner_cards
         (user_id, entry_id, box_number, due_at, last_reviewed_at,
          correct_streak, total_reviews, source, added_from_mode, created_at, updated_at)
       VALUES ($1, $2, $3::smallint, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (user_id, entry_id)
       DO UPDATE SET box_number = EXCLUDED.box_number,
                     due_at = EXCLUDED.due_at,
                     last_reviewed_at = EXCLUDED.last_reviewed_at,
                     correct_streak = EXCLUDED.correct_streak,
                     total_reviews = EXCLUDED.total_reviews,
                     source = EXCLUDED.source,
                     added_from_mode = EXCLUDED.added_from_mode,
                     updated_at = NOW()
       RETURNING id`,
      [
        user.id,
        entryIds[i],
        boxNumber,
        daysAgo((i % 4) + 1, 7),
        daysAgo(boxNumber + 1, 8),
        correctStreak,
        totalReviews,
        entryMap.has(entryIds[i]) ? 'practice' : 'system_deck',
        ['flashcard', 'swift_choice', 'cloze_craft', 'pair_link'][i % 4],
        daysAgo(20 - (i % 5), 9),
      ],
    );

    const leitnerCardId = rows[0].id;
    const oldBox = Math.max(1, boxNumber - 1);
    await client.query(
      `INSERT INTO leitner_reviews
         (leitner_card_id, user_id, correct, old_box, new_box, time_ms, created_at)
       VALUES
         ($1, $2, TRUE,  $3::smallint, $4::smallint, $5, $6),
         ($1, $2, $7,    $4::smallint, $8::smallint, $9, $10)`,
      [
        leitnerCardId,
        user.id,
        oldBox,
        boxNumber,
        900 + i * 100,
        daysAgo(10 - (i % 5), 11),
        i % 4 !== 0,
        i % 4 === 0 ? 1 : boxNumber,
        1100 + i * 120,
        daysAgo(3 - (i % 3), 12),
      ],
    );
  }
}

async function seedGames(
  client: PoolClient,
  user: SeededUser,
  fixtures: Fixtures,
  index: number,
): Promise<void> {
  const scores = GAME_SCORE_PROFILES[user.email];

  for (const type of ['lexisweep', 'anagram', 'ladder'] as const) {
    for (let run = 0; run < 2; run++) {
      const best = scores[type];
      const score = run === 0 ? Math.round(best * 0.82) : best;
      const createdAt = daysAgo(run === 0 ? 9 + index : index + 1, 15 + run);
      const accuracy = Math.min(0.99, 0.72 + index * 0.035 + run * 0.04);
      const timeSec = type === 'ladder' ? 60 - index * 3 : 95 - index * 4;
      const details =
        type === 'lexisweep'
          ? {
              words_found: fixtures.games.lexisweepList.words.slice(0, 8 + index),
              mistakes: Math.max(0, 3 - run),
              source: 'mobile_test_seed',
            }
          : type === 'anagram'
            ? {
                anagrams_solved: 6 + index + run,
                hints_used: Math.max(0, 2 - run),
                sample_words: fixtures.games.anagramList.words.slice(0, 6),
                source: 'mobile_test_seed',
              }
            : {
                user_order: run === 0
                  ? [...fixtures.games.semanticSet.entryIds].reverse()
                  : fixtures.games.semanticSet.entryIds,
                source: 'mobile_test_seed',
              };

      await client.query(
        `INSERT INTO game_runs
           (user_id, game_type, level_id, list_id, set_id,
            score, accuracy, time_sec, completed, details_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, $10)`,
        [
          user.id,
          type,
          fixtures.games.levels[type],
          type === 'lexisweep' ? fixtures.games.lexisweepList.id : type === 'anagram' ? fixtures.games.anagramList.id : null,
          type === 'ladder' ? fixtures.games.semanticSet.id : null,
          score,
          accuracy,
          timeSec,
          asJson(details),
          createdAt,
        ],
      );
    }
  }
}

async function seedReading(
  client: PoolClient,
  user: SeededUser,
  fixtures: Fixtures,
  lookupEntries: EntryFixture[],
  index: number,
): Promise<void> {
  const progress = Math.min(0.85, 0.26 + index * 0.08);
  const totalTimeSec = 1800 + index * 720;
  const paragraphIndex = Math.min(index + 1, fixtures.ebook.paragraphIds.length - 1);

  await client.query(
    `INSERT INTO user_reading_progress
       (user_id, ebook_id, current_chapter, current_paragraph_index,
        progress, total_time_sec, words_looked_up, started_at, last_read_at)
     VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, ebook_id)
     DO UPDATE SET current_chapter = EXCLUDED.current_chapter,
                   current_paragraph_index = EXCLUDED.current_paragraph_index,
                   progress = EXCLUDED.progress,
                   total_time_sec = EXCLUDED.total_time_sec,
                   words_looked_up = EXCLUDED.words_looked_up,
                   started_at = EXCLUDED.started_at,
                   last_read_at = EXCLUDED.last_read_at`,
    [
      user.id,
      fixtures.ebook.id,
      paragraphIndex,
      progress,
      totalTimeSec,
      lookupEntries.length,
      daysAgo(20 - index, 6),
      daysAgo(index, 20),
    ],
  );

  if (index % 2 === 0) {
    await client.query(
      `INSERT INTO user_ebook_favorites (user_id, ebook_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [user.id, fixtures.ebook.id],
    );
  }

  for (let i = 0; i < lookupEntries.length; i++) {
    const entry = lookupEntries[i];
    await client.query(
      `INSERT INTO word_lookups
         (user_id, entry_id, word_text, source, lookup_result,
          ebook_id, paragraph_id, created_at)
       VALUES ($1, $2, $3, 'ebook', 'dictionary', $4, $5, $6)`,
      [
        user.id,
        entry.id,
        entry.headword,
        fixtures.ebook.id,
        fixtures.ebook.paragraphIds[i % fixtures.ebook.paragraphIds.length],
        daysAgo(i + index, 18),
      ],
    );
  }
}

async function seedSavedWordsAndNotifications(
  client: PoolClient,
  user: SeededUser,
  entries: EntryFixture[],
  index: number,
): Promise<void> {
  for (let i = 0; i < entries.length; i++) {
    await client.query(
      `INSERT INTO user_saved_words
         (user_id, entry_id, note, mastery_level, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, entry_id)
       DO UPDATE SET note = EXCLUDED.note,
                     mastery_level = EXCLUDED.mastery_level`,
      [
        user.id,
        entries[i].id,
        `Mobile test saved word: ${entries[i].headword}`,
        ['new', 'learning', 'mastered'][(i + index) % 3],
        daysAgo(i + 2, 13),
      ],
    );
  }

  const notifications = [
    {
      type: 'review_due',
      title: 'Review cards due today',
      message: 'Your Leitner queue has cards ready for practice.',
      link_url: '/leitner',
      is_read: false,
    },
    {
      type: 'system_update',
      title: 'Mobile test account ready',
      message: `Seeded data for ${user.tier.toUpperCase()} testing.`,
      link_url: '/home',
      is_read: index % 2 === 0,
    },
  ];

  for (const item of notifications) {
    await client.query(
      `INSERT INTO user_notifications
         (user_id, type, title, message, link_url, is_read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user.id,
        item.type,
        item.title,
        item.message,
        item.link_url,
        item.is_read,
        daysAgo(index, 9),
      ],
    );
  }
}

async function seedActivity(client: PoolClient, user: SeededUser, index: number): Promise<void> {
  const actions = [
    'flashcard_session',
    'leitner_review',
    'ebook_read',
    'game_play',
    'dictionary_lookup',
    'subscription_view',
  ];

  for (let i = 0; i < 7; i++) {
    await client.query(
      `INSERT INTO user_activity_log
         (user_id, action, details, duration_sec, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        user.id,
        actions[(i + index) % actions.length],
        asJson({ seed: 'mobile_test_users', tier: user.tier, day_offset: i }),
        180 + (i + index) * 45,
        daysAgo(i, 7 + (index % 5)),
      ],
    );
  }
}

async function seedForUser(
  client: PoolClient,
  user: SeededUser,
  plans: Record<Tier, PlanInfo>,
  paymentMethods: string[],
  fixtures: Fixtures,
  index: number,
): Promise<{ transactions: number; ownDeckCards: number }> {
  const transactions = await seedSubscriptions(client, user, plans, paymentMethods);
  await seedFavoriteSystemDecks(client, user, fixtures, index);

  const ownCards = await seedUserCreatedFlashcards(client, user, fixtures, index);
  const systemCards = takeCircular(fixtures.systemCards, index * 4, 12);
  const allProgressCards = [...systemCards, ...ownCards];
  await seedCardProgress(client, user, allProgressCards, index);

  const fallbackEntries = takeCircular(fixtures.entries, index * 9, 12);
  await seedLeitner(client, user, allProgressCards, fallbackEntries, index);

  await seedGames(client, user, fixtures, index);

  const lookupEntries = takeCircular(fixtures.entries, 60 + index * 6, 6);
  await seedReading(client, user, fixtures, lookupEntries, index);

  const savedWords = takeCircular(fixtures.entries, 100 + index * 4, 5);
  await seedSavedWordsAndNotifications(client, user, savedWords, index);
  await seedActivity(client, user, index);

  return { transactions, ownDeckCards: ownCards.length };
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const plans = await ensurePlans(client);
    const paymentMethods = await ensurePaymentMethods(client, plans);
    const fixtures = await loadFixtures(client);

    const cleanedUsers = await cleanupExistingTestData(client);
    const users = await upsertUsers(client);

    let transactionTotal = 0;
    let ownDeckCardTotal = 0;
    for (let i = 0; i < users.length; i++) {
      const result = await seedForUser(client, users[i], plans, paymentMethods, fixtures, i);
      transactionTotal += result.transactions;
      ownDeckCardTotal += result.ownDeckCards;
    }

    await client.query('COMMIT');

    console.log('\nMobile test users seeded successfully.');
    console.log(`Password for all accounts: ${PASSWORD}`);
    console.log(`Cleaned existing test users: ${cleanedUsers}`);
    console.log(`User-created flashcard cards: ${ownDeckCardTotal}`);
    console.log(`Subscription transactions: ${transactionTotal}`);
    console.log(`Reading ebook: ${fixtures.ebook.title}`);
    console.log('\nAccounts:');
    for (const user of users) {
      console.log(`  ${user.email.padEnd(28)} ${user.tier.toUpperCase().padEnd(7)} ${user.fullName}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nSeed mobile test users failed.');
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
