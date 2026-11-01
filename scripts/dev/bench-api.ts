/**
 * Latency / query-count benchmark of the mobile API (/api/v1) and of the admin pages, run IN-PROCESS against the database of .env.
 *
 *   npm run bench:api                                  # every scenario, 7 measured runs each (after 2 warm-up runs)
 *   npm run bench:api -- --only search,dashboard       # scenarios whose name contains one of the words
 *   npm run bench:api -- --runs 11 --out before.json   # more runs, write the numbers to a file
 *   npm run bench:api -- --compare before.json         # print this run next to a saved one (delta in ms and in queries)
 *   npm run bench:api -- --idle-test                   # also: one request after 12 s of silence (what an idle pool costs)
 *   npm run bench:api -- --only games.runs --trace     # also: print the statements of the last run of each scenario (before / after the response)
 *
 * What it reports, per scenario (median of the measured runs):
 *   ms        wall time of the request, from the client's side, through the whole Express stack
 *   queries   database statements started BEFORE the response was sent (pool.query and client.query)
 *   bg        statements that ran AFTER the response (fire-and-forget work), counted until the pool is quiet again
 *   conns     new database connections opened during the request (a handshake costs far more than a query)
 *   bytes     size of the response on the wire (compressed, when the response was)
 *
 * Why queries matter more than anything else here: the database is remote (Neon), so every statement is a network round trip
 * (about 60 ms from a laptop), and most handlers ran their statements one after the other. The query count and the wall time move
 * together; the count does not depend on the network, so it is the number to compare between two runs on different days.
 *
 * Safety: it creates its own fixtures (users "test-bench-<run>-…@example.com", one admin account) and deletes them in `finally`;
 * a run that is killed leaves them behind, and `npm run clean:test-data` sweeps "test-…@example.com" accounts older than an hour.
 * OpenAI / Anthropic / Google keys are removed from the environment BEFORE the app is loaded, so no scenario can spend money:
 * answers are sent as text that matches the stored meaning exactly (graded without a model), and no unknown word is looked up.
 * It refuses NODE_ENV=production and NODE_ENV=test (the production caches are what is measured, and the tests switch them off).
 */
import 'dotenv/config';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

// ── environment: before anything of the app is loaded ───────────────────────────────────────────────────────────────────
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_TRANSLATE_API_KEY', 'GOOGLE_TTS_API_KEY', 'GOOGLE_CLOUD_API_KEY', 'GEMINI_API_KEY']) {
  delete process.env[key];
}
process.env.ENRICHMENT_ENABLED = 'false';
if (!process.env.NODE_ENV || process.env.NODE_ENV === 'test') process.env.NODE_ENV = 'development';
if (process.env.NODE_ENV === 'production') {
  console.error('bench:api refuses NODE_ENV=production');
  process.exit(2);
}

type Method = 'get' | 'post' | 'patch' | 'delete';

interface Args {
  only: string[];
  runs: number;
  warmup: number;
  out?: string;
  compare?: string;
  idleTest: boolean;
  trace: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { only: [], runs: 7, warmup: 2, idleTest: false, trace: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--only') a.only = String(argv[++i] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (k === '--runs') a.runs = Math.max(1, parseInt(argv[++i], 10) || 7);
    else if (k === '--warmup') a.warmup = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--compare') a.compare = argv[++i];
    else if (k === '--idle-test') a.idleTest = true;
    else if (k === '--trace') a.trace = true;
    else throw new Error(`Unknown option: ${k}`);
  }
  return a;
}

interface Row {
  name: string;
  status: number | string;
  ms: number;
  minMs: number;
  maxMs: number;
  queries: number;
  bg: number;
  conns: number;
  bytes: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number, d = 0) => n.toFixed(d);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { default: request } = await import('supertest');
  const jwt = (await import('jsonwebtoken')).default;
  const bcrypt = (await import('bcryptjs')).default;
  const { default: pool } = await import('../../config/db');
  const { buildAnswerCandidates } = await import('../../utils/answerMatcher');
  const { default: app } = await import('../../app');

  // ── instrumentation ────────────────────────────────────────────────────────────────────────────────────────────────
  const counters = { queries: 0, connects: 0 };
  const statements: string[] = [];
  const note = (a: any[]) => {
    counters.queries++;
    if (args.trace) statements.push(String(typeof a[0] === 'string' ? a[0] : a[0]?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 150));
  };
  // Every statement of the app, whether it goes through pool.query or through a client of pool.connect(), ends in pg's
  // Client.prototype.query, so that is the one place to count. (Wrapping pool.query AND the checked-out clients counted a statement
  // twice whenever pool.query happened to pick a client that an earlier pool.connect() had wrapped.)
  const pg: any = await import('pg');
  const ClientClass = pg.Client ?? pg.default?.Client;
  const origClientQuery = ClientClass.prototype.query;
  ClientClass.prototype.query = function (this: unknown, ...a: any[]) {
    note(a);
    return origClientQuery.apply(this, a);
  };
  pool.on('connect', () => {
    counters.connects++;
  });
  const quiesce = async () => {
    await sleep(40);
    let stable = 0;
    for (let guard = 0; guard < 400 && stable < 3; guard++) {
      if (pool.totalCount - pool.idleCount === 0 && pool.waitingCount === 0) stable++;
      else stable = 0;
      await sleep(40);
    }
  };
  const realLog = console.log;
  const quiet = () => {
    console.log = () => undefined;
    console.info = () => undefined;
  };
  const loud = () => {
    console.log = realLog;
  };

  // ── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  const emailOf = (tag: string) => `test-bench-${RUN}-${tag}@example.com`;
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  const tokenFor = (id: string, email: string) => jwt.sign({ userId: id, email }, secret, { expiresIn: '2h' });

  const needFresh = args.runs + args.warmup + 2;
  const rows: Row[] = [];
  let admin: ReturnType<typeof request.agent> | null = null;

  try {
    realLog('Preparing fixtures …');
    const rtts: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      await pool.query('SELECT 1');
      rtts.push(performance.now() - t);
    }
    realLog(`database round trip (SELECT 1, median of 7): ${fmt(median(rtts), 1)} ms · NODE_ENV=${process.env.NODE_ENV}\n`);

    const hash = bcrypt.hashSync('bench-pass-123', 4);
    const tags = ['primary', ...Array.from({ length: needFresh }, (_, i) => `fresh${i}`)];
    const ins = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, level)
       SELECT t.email, $2, 'Bench User', 'beginner' FROM unnest($1::text[]) AS t(email) RETURNING id, email`,
      [tags.map(emailOf), hash]
    );
    const userByEmail = new Map<string, { id: string; email: string }>(ins.rows.map((r: any) => [r.email, r]));
    const mk = (tag: string) => {
      const u = userByEmail.get(emailOf(tag))!;
      return { id: u.id, email: u.email, token: tokenFor(u.id, u.email) };
    };
    const primary = mk('primary');
    const fresh = Array.from({ length: needFresh }, (_, i) => mk(`fresh${i}`));

    // The biggest published system deck: its cards feed practice sessions and the Leitner boxes of the primary user.
    const deck = (
      await pool.query(
        `SELECT d.id FROM decks d WHERE d.is_system AND d.status = 'published'
          ORDER BY (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id) DESC LIMIT 1`
      )
    ).rows[0];
    const deckCards: Array<{ card_id: string; entry_id: string }> = deck
      ? (
          await pool.query(
            `SELECT c.id AS card_id, c.entry_id FROM cards c
              WHERE c.deck_id = $1 AND (EXISTS (SELECT 1 FROM entry_senses s WHERE s.entry_id = c.entry_id AND s.definition_vi IS NOT NULL)
                                        OR EXISTS (SELECT 1 FROM dictionary_entries e WHERE e.id = c.entry_id AND e.meaning_vi IS NOT NULL))
              ORDER BY c.sort_order LIMIT 90`,
            [deck.id]
          )
        ).rows
      : [];
    if (deckCards.length < 60) throw new Error('not enough cards in a published system deck to benchmark with');

    // Leitner cards of the primary user: all in boxes 1-3 and due, so a typed Vietnamese answer is the only check (no English check).
    const leitnerEntries = deckCards.slice(0, 60).map((c) => c.entry_id);
    const seedLeitner = async () => {
      await pool.query(
        `INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at, source, added_from_mode)
         SELECT $1, e, (row_number() OVER ())::int % 3 + 1, NOW() - INTERVAL '1 day', 'practice', 'bench'
           FROM unnest($2::uuid[]) AS e
         ON CONFLICT (user_id, entry_id) DO UPDATE SET box_number = EXCLUDED.box_number, due_at = EXCLUDED.due_at`,
        [primary.id, leitnerEntries]
      );
    };
    await seedLeitner();
    const resetLeitner = () =>
      pool.query(`UPDATE leitner_cards SET box_number = 1, due_at = NOW() - INTERVAL '1 day', total_reviews = 0 WHERE user_id = $1`, [primary.id]);
    const leitnerCards = (await pool.query(`SELECT id, entry_id FROM leitner_cards WHERE user_id = $1 ORDER BY id`, [primary.id])).rows as Array<{ id: string; entry_id: string }>;

    // An answer the grader accepts without a model: the first accepted text it builds itself from the same stored meaning.
    const acceptedAnswer = async (entryId: string): Promise<string> => {
      const [{ rows: e }, { rows: s }, { rows: al }] = await Promise.all([
        pool.query(`SELECT meaning_vi FROM dictionary_entries WHERE id = $1`, [entryId]),
        pool.query(`SELECT definition_vi FROM entry_senses WHERE entry_id = $1 AND definition_vi IS NOT NULL ORDER BY sense_order`, [entryId]),
        pool.query(`SELECT answer_text FROM entry_answer_aliases WHERE entry_id = $1 AND status = 'active' ORDER BY created_at`, [entryId]),
      ]);
      const c = buildAnswerCandidates({ meaningVi: e[0]?.meaning_vi, senseDefinitions: s.map((r: any) => r.definition_vi), aliases: al.map((r: any) => r.answer_text) });
      return c[0]?.text ?? 'x';
    };

    const word = (
      await pool.query(`SELECT id, headword FROM dictionary_entries WHERE published AND frequency_rank IS NOT NULL AND headword ~ '^[a-z]{4,8}$' ORDER BY frequency_rank LIMIT 1 OFFSET 40`)
    ).rows[0];
    const ebook = (
      await pool.query(
        `SELECT e.id AS ebook_id, c.id AS chapter_id, c.chapter_index, p.id AS paragraph_id
           FROM ebooks e JOIN chapters c ON c.ebook_id = e.id JOIN paragraphs p ON p.chapter_id = c.id
          WHERE e.status = 'published' AND p.paragraph_index = 3
          ORDER BY (SELECT COUNT(*) FROM paragraphs x WHERE x.chapter_id = c.id) DESC LIMIT 1`
      )
    ).rows[0];
    const anagram = (await pool.query(`SELECT id FROM game_word_lists WHERE game_type = 'anagram' AND status = 'published' LIMIT 1`)).rows[0];
    const anagramLevel = (await pool.query(`SELECT id FROM game_levels WHERE game_type = 'anagram' AND status = 'active' LIMIT 1`)).rows[0];
    const ladderSet = (await pool.query(`SELECT id FROM semantic_sets WHERE status = 'published' LIMIT 1`)).rows[0];
    const ladderOrder: string[] = ladderSet
      ? (await pool.query(`SELECT entry_id FROM semantic_set_items WHERE set_id = $1 ORDER BY correct_order`, [ladderSet.id])).rows.map((r: any) => r.entry_id)
      : [];

    const adminEmail = emailOf('admin');
    await pool.query(`INSERT INTO admin_accounts (email, password_hash, full_name, role) VALUES ($1, $2, 'Bench Admin', 'super_admin')`, [adminEmail, hash]);

    // ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
    const call = (method: Method, url: string, token?: string, body?: unknown) => {
      let r: any = (request(app) as any)[method](url);
      if (token) r = r.set('Authorization', `Bearer ${token}`);
      if (body !== undefined) r = r.send(body);
      return r;
    };
    const body = async (method: Method, url: string, token: string, payload?: unknown) => (await call(method, url, token, payload)).body?.data;
    const fresh$ = (i: number) => fresh[i % fresh.length];

    interface Scenario {
      name: string;
      /** not measured; its result is handed to run() */
      prepare?: (i: number) => Promise<any>;
      run: (prep: any, i: number) => any;
      /** fewer runs for scenarios that consume fixtures */
      runs?: number;
    }
    const API = '/api/v1';
    const P = primary.token;

    const scenarios: Scenario[] = [
      { name: 'auth.me', run: () => call('get', `${API}/auth/me`, P) },
      {
        // The dashboard is cached 30 s per user, so every run uses another user; each gets a little history first (not measured).
        name: 'home.dashboard (first load, other user each run)',
        prepare: async (i) => {
          const u = fresh$(i);
          await pool.query(
            `INSERT INTO user_activity_log (user_id, action, details, created_at)
             SELECT $1, 'flashcard', '{}'::jsonb, NOW() - (g || ' days')::interval FROM generate_series(0, 4) AS g`,
            [u.id]
          );
          await pool.query(
            `INSERT INTO game_runs (user_id, game_type, score, accuracy, time_sec, completed, details_json)
             VALUES ($1, 'anagram', 200, 0.8, 60, TRUE, '{}'::jsonb)`,
            [u.id]
          );
          await pool.query(
            `INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at, source, added_from_mode)
             SELECT $1, e, 1, NOW() - INTERVAL '1 day', 'practice', 'bench' FROM unnest($2::uuid[]) AS e ON CONFLICT DO NOTHING`,
            [u.id, leitnerEntries.slice(0, 10)]
          );
          return u;
        },
        run: (u) => call('get', `${API}/home/dashboard`, u.token),
      },
      { name: 'dictionary.search', run: () => call('get', `${API}/dictionary/search?q=act&limit=20`) },
      { name: 'dictionary.search (pos+cefr)', run: () => call('get', `${API}/dictionary/search?q=an&pos=noun&cefr=B1`) },
      { name: 'dictionary.categories', run: () => call('get', `${API}/dictionary/categories`) },
      { name: 'dictionary.entry (signed in)', run: () => call('get', `${API}/dictionary/entries/${word.id}`, P) },
      { name: 'dictionary.entry (guest)', run: () => call('get', `${API}/dictionary/entries/${word.id}`) },
      { name: 'dictionary.saved-words', run: () => call('get', `${API}/dictionary/saved-words`, P) },
      ...(ebook
        ? [
            {
              name: 'ebook.lookup (dictionary hit, with paragraph)',
              run: () => call('post', `${API}/ebooks/${ebook.ebook_id}/lookup`, P, { word: word.headword, paragraph_id: ebook.paragraph_id }),
            } as Scenario,
            { name: 'ebooks.list', run: () => call('get', `${API}/ebooks`, P) },
            { name: 'ebooks.detail', run: () => call('get', `${API}/ebooks/${ebook.ebook_id}`, P) },
            { name: 'ebooks.chapter', run: () => call('get', `${API}/ebooks/${ebook.ebook_id}/chapters/${ebook.chapter_id}`, P) },
            {
              name: 'ebooks.progress',
              run: (_p, i) => call('post', `${API}/ebooks/${ebook.ebook_id}/chapters/${ebook.chapter_id}/progress`, P, { current_paragraph_index: i % 8, time_spent_sec: 5 }),
            } as Scenario,
            { name: 'ebooks.reading-stats', run: () => call('get', `${API}/ebooks/reading-stats`, P) },
          ]
        : []),
      { name: 'decks.system', run: () => call('get', `${API}/decks/system`, P) },
      { name: 'decks.mine', run: () => call('get', `${API}/decks/mine`, P) },
      { name: 'decks.detail', run: () => call('get', `${API}/decks/${deck.id}`, P) },
      { name: 'decks.cards', run: () => call('get', `${API}/decks/${deck.id}/cards`, P) },
      { name: 'leitner.overview', run: () => call('get', `${API}/leitner/overview`, P) },
      { name: 'leitner.due', run: () => call('get', `${API}/leitner/due?limit=20`, P) },
      { name: 'leitner.box', run: () => call('get', `${API}/leitner/box/2`, P) },
      { name: 'leitner.stats', run: (_p, i) => call('get', `${API}/leitner/stats?range=${['7d', '30d', 'all'][i % 3]}`, P) },
      {
        name: 'leitner.review (typed answer, legacy endpoint)',
        runs: 12,
        prepare: async (i) => {
          const card = leitnerCards[i % leitnerCards.length];
          await pool.query(`UPDATE leitner_cards SET box_number = 1, due_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [card.id]);
          return { card, answer: await acceptedAnswer(card.entry_id) };
        },
        run: (p) => call('post', `${API}/leitner/review`, P, { leitner_card_id: p.card.id, user_answer: p.answer, time_ms: 1200 }),
      },
      {
        name: 'leitner.session.start',
        prepare: () => resetLeitner(),
        run: () => call('post', `${API}/leitner/session/start`, P, { limit: 10 }),
      },
      {
        name: 'leitner.session.answer (typed, exact match)',
        prepare: async () => {
          await resetLeitner();
          const s = await body('post', `${API}/leitner/session/start`, P, { limit: 5 });
          const step = s.steps[0];
          return { sessionId: s.session_id, step, answer: await acceptedAnswer(step.entry_id) };
        },
        run: (p) => call('post', `${API}/leitner/session/answer`, P, { session_id: p.sessionId, step_index: p.step.step_index, user_answer: p.answer, time_ms: 900 }),
      },
      {
        name: 'leitner.session.complete',
        prepare: async () => {
          await resetLeitner();
          const s = await body('post', `${API}/leitner/session/start`, P, { limit: 3 });
          for (const step of s.steps) await call('post', `${API}/leitner/session/answer`, P, { session_id: s.session_id, step_index: step.step_index, correct: true, time_ms: 500 });
          return s.session_id;
        },
        run: (sid) => call('post', `${API}/leitner/session/complete`, P, { session_id: sid }),
      },
      {
        name: 'leitner.swift-choice.question',
        run: (_p, i) => call('post', `${API}/leitner/swift-choice/question`, P, { leitner_card_id: leitnerCards[i % leitnerCards.length].id }),
      },
      {
        name: 'leitner.cloze.question',
        run: (_p, i) => call('post', `${API}/leitner/cloze/question`, P, { leitner_card_id: leitnerCards[i % leitnerCards.length].id, level: 1 }),
      },
      { name: 'practice.session.start (random 5)', run: () => call('post', `${API}/practice/session/start`, P, { deck_id: deck.id, mode: 'flashcard', limit: 5 }) },
      {
        name: 'practice.session.answer (typed, exact match)',
        prepare: async () => {
          const s = await body('post', `${API}/practice/session/start`, P, { deck_id: deck.id, mode: 'flashcard', limit: 5 });
          const card = s.cards[0];
          return { sessionId: s.session_id, card, answer: await acceptedAnswer(card.entry_id) };
        },
        run: (p) => call('post', `${API}/practice/session/answer`, P, { session_id: p.sessionId, card_id: p.card.card_id, user_answer: p.answer, time_ms: 1500 }),
      },
      {
        name: 'practice.session.complete',
        runs: 5,
        prepare: async () => {
          const s = await body('post', `${API}/practice/session/start`, P, { deck_id: deck.id, mode: 'flashcard', limit: 4 });
          for (const c of s.cards) await call('post', `${API}/practice/session/answer`, P, { session_id: s.session_id, card_id: c.card_id, correct: true, time_ms: 800 });
          return s.session_id;
        },
        run: (sid) => call('post', `${API}/practice/session/complete`, P, { session_id: sid }),
      },
      {
        name: 'practice.swift-choice.question',
        run: (_p, i) => call('post', `${API}/practice/swift-choice/question`, P, { card_id: deckCards[i % deckCards.length].card_id }),
      },
      {
        name: 'practice.cloze.question',
        run: (_p, i) => call('post', `${API}/practice/cloze/question`, P, { card_id: deckCards[i % deckCards.length].card_id, level: 1 }),
      },
      {
        name: 'practice.pair-link',
        run: () => call('post', `${API}/practice/pair-link/session`, P, { deck_id: deck.id, count: 5 }),
      },
      { name: 'practice.history', run: () => call('get', `${API}/practice/history`, P) },
      { name: 'subscriptions.plans', run: () => call('get', `${API}/subscriptions/plans`) },
      { name: 'subscriptions.me', run: () => call('get', `${API}/subscriptions/me`, P) },
      { name: 'games.levels', run: () => call('get', `${API}/games/levels`) },
      { name: 'games.word-lists', run: () => call('get', `${API}/games/word-lists`) },
      { name: 'games.semantic-sets', run: () => call('get', `${API}/games/semantic-sets`) },
      { name: 'games.leaderboard', run: () => call('get', `${API}/games/leaderboard?game_type=anagram&range=weekly`, P) },
      { name: 'games.me.stats', run: () => call('get', `${API}/games/me/stats`, P) },
      ...(anagram
        ? [
            {
              name: 'games.runs (anagram)',
              run: () => call('post', `${API}/games/runs`, P, { game_type: 'anagram', list_id: anagram.id, level_id: anagramLevel?.id, score: 240, accuracy: 0.8, time_sec: 70, completed: true, details: { anagrams_solved: 6 } }),
            } as Scenario,
          ]
        : []),
      ...(ladderSet && ladderOrder.length > 1
        ? [
            {
              name: 'games.runs (ladder, perfect order)',
              run: () => call('post', `${API}/games/runs`, P, { game_type: 'ladder', set_id: ladderSet.id, score: 300, time_sec: 60, completed: true, details: { user_order: ladderOrder } }),
            } as Scenario,
          ]
        : []),
      { name: 'notifications.list', run: () => call('get', `${API}/notifications`, P) },
      { name: 'notifications.unread-count', run: () => call('get', `${API}/notifications/unread-count`, P) },
      { name: 'profile.me', run: () => call('get', `${API}/profile/me`, P) },
      { name: 'profile.stats', run: () => call('get', `${API}/profile/stats`, P) },
      { name: 'profile.patch', run: (_p, i) => call('patch', `${API}/profile/me`, P, { full_name: `Bench User ${i % 5}` }) },
      { name: 'retrieval.start', run: () => call('post', `${API}/retrieval/start`, P, {}) },
    ];

    // ── admin pages (session cookie) ─────────────────────────────────────────────────────────────────────────────────
    const adminPages = ['/dashboard', '/dictionary', '/dictionary?search=act', '/users', '/lessons', '/decks', '/ebooks', '/subscriptions', '/games', '/approvals', '/lookup', '/admins'];
    const adminScenarios: Scenario[] = adminPages.map((p) => ({ name: `admin ${p}`, run: () => admin!.get(p) }));

    const selected = (name: string) => args.only.length === 0 || args.only.some((w) => name.toLowerCase().includes(w));

    const measure = async (s: Scenario): Promise<Row> => {
      const total = args.warmup + (s.runs ?? args.runs);
      const times: number[] = [];
      const queries: number[] = [];
      const bg: number[] = [];
      const conns: number[] = [];
      const bytes: number[] = [];
      let status: number | string = '-';
      for (let i = 0; i < total; i++) {
        const prep = s.prepare ? await s.prepare(i) : undefined;
        await quiesce();
        counters.queries = 0;
        counters.connects = 0;
        statements.length = 0;
        const t0 = performance.now();
        const res = await s.run(prep, i);
        const ms = performance.now() - t0;
        const inReq = counters.queries;
        const connected = counters.connects;
        await quiesce();
        status = res.status;
        if (args.trace && i === total - 1) {
          realLog(`── ${s.name}: ${inReq} statement(s) before the response, ${statements.length - inReq} after`);
          statements.forEach((sql, n) => realLog(`   ${n < inReq ? 'fg' : 'bg'} ${String(n + 1).padStart(2)}  ${sql}`));
        }
        if (i >= args.warmup) {
          times.push(ms);
          queries.push(inReq);
          bg.push(counters.queries - inReq);
          conns.push(connected);
          bytes.push(Number(res.headers['content-length']) || (res.text ? Buffer.byteLength(res.text) : 0));
        }
      }
      return {
        name: s.name,
        status,
        ms: median(times),
        minMs: Math.min(...times),
        maxMs: Math.max(...times),
        queries: median(queries),
        bg: median(bg),
        conns: median(conns),
        bytes: median(bytes),
      };
    };

    quiet();
    // first request of the process: a cold pool (what the first visitor after a deploy pays)
    const cold0 = performance.now();
    await call('get', `${API}/auth/me`, P);
    const coldMs = performance.now() - cold0;

    for (const s of scenarios.filter((x) => selected(x.name))) {
      try {
        rows.push(await measure(s));
      } catch (err: any) {
        rows.push({ name: s.name, status: `ERR ${String(err?.message ?? err).slice(0, 40)}`, ms: 0, minMs: 0, maxMs: 0, queries: 0, bg: 0, conns: 0, bytes: 0 });
      }
    }

    if (adminScenarios.some((x) => selected(x.name))) {
      const agent = request.agent(app);
      const login = await agent.post('/auth/login').type('form').send({ email: adminEmail, password: 'bench-pass-123' });
      if (login.status === 302 && login.headers.location === '/dashboard') {
        admin = agent;
        for (const s of adminScenarios.filter((x) => selected(x.name))) {
          try {
            rows.push(await measure(s));
          } catch (err: any) {
            rows.push({ name: s.name, status: `ERR ${String(err?.message ?? err).slice(0, 40)}`, ms: 0, minMs: 0, maxMs: 0, queries: 0, bg: 0, conns: 0, bytes: 0 });
          }
        }
      } else {
        rows.push({ name: 'admin login', status: `${login.status} ${login.headers.location ?? ''}`, ms: 0, minMs: 0, maxMs: 0, queries: 0, bg: 0, conns: 0, bytes: 0 });
      }
    }

    let idleMs: number | null = null;
    let idleConns = 0;
    if (args.idleTest) {
      await quiesce();
      loud();
      realLog('idle test: waiting 12 s …');
      quiet();
      await sleep(12_000);
      counters.connects = 0;
      const t = performance.now();
      await call('get', `${API}/auth/me`, P);
      idleMs = performance.now() - t;
      idleConns = counters.connects;
    }
    loud();

    // ── report ────────────────────────────────────────────────────────────────────────────────────────────────────────
    const saved: { rows: Row[] } | null = args.compare && fs.existsSync(args.compare) ? JSON.parse(fs.readFileSync(args.compare, 'utf8')) : null;
    const before = new Map<string, Row>((saved?.rows ?? []).map((r) => [r.name, r]));
    const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
    const num = (s: string, n: number) => ' '.repeat(Math.max(0, n - s.length)) + s;
    const w = Math.max(...rows.map((r) => r.name.length), 10);
    realLog(`${pad('scenario', w)}  ${num('st', 4)}  ${num('ms', 7)}  ${num('min', 6)}  ${num('max', 6)}  ${num('queries', 7)}  ${num('bg', 3)}  ${num('conns', 5)}  ${num('bytes', 7)}${saved ? '   |  before: ms  queries   Δms   Δq' : ''}`);
    for (const r of rows) {
      let line = `${pad(r.name, w)}  ${num(String(r.status), 4)}  ${num(fmt(r.ms), 7)}  ${num(fmt(r.minMs), 6)}  ${num(fmt(r.maxMs), 6)}  ${num(fmt(r.queries, 1), 7)}  ${num(fmt(r.bg, 0), 3)}  ${num(fmt(r.conns, 0), 5)}  ${num(fmt(r.bytes), 7)}`;
      const b = before.get(r.name);
      if (saved && b) {
        const dm = r.ms - b.ms;
        const dq = r.queries - b.queries;
        line += `   |  ${num(fmt(b.ms), 10)}  ${num(fmt(b.queries, 1), 7)}  ${num((dm > 0 ? '+' : '') + fmt(dm), 5)}  ${num((dq > 0 ? '+' : '') + fmt(dq, 1), 4)}`;
      }
      realLog(line);
    }
    const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
    realLog(`\n${rows.length} scenarios · Σ median ms ${fmt(sum((r) => r.ms))} · Σ queries ${fmt(sum((r) => r.queries), 1)} · first request of the process (cold pool): ${fmt(coldMs)} ms`);
    if (saved) {
      const common = rows.filter((r) => before.has(r.name) && typeof r.status === 'number');
      realLog(`vs ${args.compare}: Σ ms ${fmt(sum((r) => (before.has(r.name) ? before.get(r.name)!.ms : 0)))} → ${fmt(common.reduce((a, r) => a + r.ms, 0))} on ${common.length} common scenarios; Σ queries ${fmt(common.reduce((a, r) => a + before.get(r.name)!.queries, 0), 1)} → ${fmt(common.reduce((a, r) => a + r.queries, 0), 1)}`);
    }
    if (idleMs !== null) realLog(`request after 12 s of silence: ${fmt(idleMs)} ms, ${idleConns} new connection(s)`);
    const odd = rows.filter((r) => typeof r.status !== 'number' || (r.status !== 200 && r.status !== 204));
    if (odd.length) realLog(`\nnot 200/204 (check that the scenario is meant to answer that): ${odd.map((r) => `${r.name} → ${r.status}`).join('; ')}`);

    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify({ at: new Date().toISOString(), nodeEnv: process.env.NODE_ENV, rttMs: median(rtts), coldMs, idleMs, rows }, null, 2));
      realLog(`\nwritten: ${args.out}`);
    }
  } finally {
    loud();
    try {
      await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`test-bench-${RUN}-%@example.com`]);
      await pool.query(`DELETE FROM admin_accounts WHERE email LIKE $1`, [`test-bench-${RUN}-%@example.com`]);
    } catch (err) {
      console.error('bench cleanup failed (npm run clean:test-data removes them after an hour):', (err as Error).message);
    }
    await pool.end().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('bench:api failed:', err?.stack ?? err);
    process.exit(1);
  });
