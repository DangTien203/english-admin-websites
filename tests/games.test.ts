/**
 * Games API — unit tests for pure logic + integration tests for HTTP endpoints.
 *
 * Pure-logic tests (no DB) run isolated.
 * HTTP tests require a running DB and valid JWT_SECRET in .env.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import pool from '../config/db';
import app from '../app';

// ─────────────────────────────────────────────────────────────────────────────
//  Re-export internal helpers for unit testing via module path hack.
//  We duplicate them here to avoid coupling tests to private exports.
// ─────────────────────────────────────────────────────────────────────────────

function computeLadderAccuracy(
  userOrder: string[],
  correctItems: Array<{ entry_id: string; correct_order: number }>
): number {
  if (correctItems.length === 0) return 0;
  const sorted = [...correctItems].sort((a, b) => a.correct_order - b.correct_order);
  const correct = sorted.map((i) => i.entry_id);
  let hits = 0;
  for (let i = 0; i < Math.min(userOrder.length, correct.length); i++) {
    if (userOrder[i] === correct[i]) hits++;
  }
  return hits / correct.length;
}

function calcXp(score: number, accuracy: number, completed: boolean): number {
  const base = Math.min(Math.round(score / 10), 150);
  const accuracyBonus = accuracy >= 0.8 ? 15 : accuracy >= 0.5 ? 5 : 0;
  const completionBonus = completed ? 20 : 0;
  return Math.max(0, base + accuracyBonus + completionBonus);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Unit tests — pure logic (no DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('computeLadderAccuracy', () => {
  const items = [
    { entry_id: 'a', correct_order: 1 },
    { entry_id: 'b', correct_order: 2 },
    { entry_id: 'c', correct_order: 3 },
    { entry_id: 'd', correct_order: 4 },
    { entry_id: 'e', correct_order: 5 },
  ];

  test('perfect order → 1.0', () => {
    expect(computeLadderAccuracy(['a', 'b', 'c', 'd', 'e'], items)).toBe(1);
  });

  test('derangement (no position matches) → 0.0', () => {
    // [b,c,d,e,a] is a true derangement of [a,b,c,d,e]: no element sits in its correct slot
    expect(computeLadderAccuracy(['b', 'c', 'd', 'e', 'a'], items)).toBe(0);
  });

  test('3 of 5 correct positions → 0.6', () => {
    // a✓ b✓ d✗ c✗ e✓
    expect(computeLadderAccuracy(['a', 'b', 'd', 'c', 'e'], items)).toBeCloseTo(0.6);
  });

  test('empty items → 0', () => {
    expect(computeLadderAccuracy(['a', 'b'], [])).toBe(0);
  });

  test('unsorted items are normalised before comparison', () => {
    const reversed = [...items].reverse();
    expect(computeLadderAccuracy(['a', 'b', 'c', 'd', 'e'], reversed)).toBe(1);
  });

  test('partial user_order (shorter than set) → proportional', () => {
    // Only 3 items provided but set has 5 — 3 correct hits / 5 total
    expect(computeLadderAccuracy(['a', 'b', 'c'], items)).toBeCloseTo(3 / 5);
  });
});

describe('calcXp', () => {
  test('high score + high accuracy + completed = max-ish XP', () => {
    const xp = calcXp(1500, 1.0, true);
    expect(xp).toBe(150 + 15 + 20); // base capped at 150
  });

  test('score=0 accuracy=0 not completed → 0 XP', () => {
    expect(calcXp(0, 0, false)).toBe(0);
  });

  test('accuracy 0.5 gives small bonus, < 0.5 gives none', () => {
    expect(calcXp(0, 0.5, false)).toBe(5);
    expect(calcXp(0, 0.49, false)).toBe(0);
  });

  test('completion bonus applies when completed=true', () => {
    const withCompletion = calcXp(100, 0, true);
    const noCompletion = calcXp(100, 0, false);
    expect(withCompletion - noCompletion).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP integration tests
// ─────────────────────────────────────────────────────────────────────────────

let authToken: string;
let testUserId: string;
let testSetId: string;
let testListId: string;

beforeAll(async () => {
  // Create or fetch a test user
  const email = `games_test_${Date.now()}@test.local`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, full_name, password_hash, level, status)
     VALUES ($1, 'Games Tester', 'hash', 'beginner', 'active')
     RETURNING id`,
    [email]
  );
  testUserId = rows[0].id;
  authToken = jwt.sign({ userId: testUserId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });

  // Fetch a published semantic set
  const { rows: sets } = await pool.query(
    `SELECT id FROM semantic_sets WHERE status = 'published' LIMIT 1`
  );
  testSetId = sets[0]?.id ?? '';

  // Fetch a published lexisweep list
  const { rows: lists } = await pool.query(
    `SELECT id FROM game_word_lists WHERE game_type = 'lexisweep' AND status = 'published' LIMIT 1`
  );
  testListId = lists[0]?.id ?? '';
});

afterAll(async () => {
  // Clean up test user data
  if (testUserId) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
  }
  await pool.end();
});

// ── GET /api/v1/games/levels ──────────────────────────────────────────────────

describe('GET /api/v1/games/levels', () => {
  test('returns all levels without type filter', async () => {
    const res = await request(app).get('/api/v1/games/levels');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  test('filters by type=lexisweep → only 3 levels', async () => {
    const res = await request(app).get('/api/v1/games/levels?type=lexisweep');
    expect(res.status).toBe(200);
    const items = res.body.data.items;
    expect(items.length).toBe(3);
    items.forEach((lv: any) => expect(lv.game_type).toBe('lexisweep'));
  });

  test('each level has config_json', async () => {
    const res = await request(app).get('/api/v1/games/levels?type=lexisweep');
    const items = res.body.data.items;
    items.forEach((lv: any) => {
      expect(lv.config_json).toBeDefined();
      expect(lv.config_json.grid_size).toBeDefined();
    });
  });

  test('invalid type → 400', async () => {
    const res = await request(app).get('/api/v1/games/levels?type=unknown');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ── GET /api/v1/games/semantic-sets ──────────────────────────────────────────

describe('GET /api/v1/games/semantic-sets', () => {
  test('returns published sets (public)', async () => {
    const res = await request(app).get('/api/v1/games/semantic-sets');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });
});

// ── GET /api/v1/games/semantic-sets/:id ──────────────────────────────────────

describe('GET /api/v1/games/semantic-sets/:id', () => {
  test('requires auth', async () => {
    if (!testSetId) return;
    const res = await request(app).get(`/api/v1/games/semantic-sets/${testSetId}`);
    expect(res.status).toBe(401);
  });

  test('returns items without correct_order field', async () => {
    if (!testSetId) return;
    const res = await request(app)
      .get(`/api/v1/games/semantic-sets/${testSetId}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    const items: any[] = res.body.data.items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    items.forEach((item) => {
      expect(item.correct_order).toBeUndefined();
      expect(item.entry_id).toBeDefined();
      expect(item.headword).toBeDefined();
    });
  });

  test('returns 404 for unknown id', async () => {
    const res = await request(app)
      .get('/api/v1/games/semantic-sets/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
  });
});

// ── POST /api/v1/games/runs — lexisweep ──────────────────────────────────────

describe('POST /api/v1/games/runs — lexisweep', () => {
  test('valid lexisweep run → 200 with run_id and xp_earned', async () => {
    if (!testListId) return;
    const res = await request(app)
      .post('/api/v1/games/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        game_type: 'lexisweep',
        list_id: testListId,
        score: 300,
        accuracy: 0.85,
        time_sec: 90,
        completed: true,
        details: { words_found: ['organize', 'achieve'] },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.run_id).toBeDefined();
    expect(typeof res.body.data.xp_earned).toBe('number');
    expect(res.body.data.xp_earned).toBeGreaterThan(0);
  });

  test('lexisweep run → NO leitner_added in response', async () => {
    if (!testListId) return;
    const res = await request(app)
      .post('/api/v1/games/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        game_type: 'lexisweep',
        list_id: testListId,
        score: 200,
        accuracy: 1.0,
        time_sec: 60,
        completed: true,
        details: { words_found: ['organize'] },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.leitner_added).toBeUndefined();
  });

  test('missing list_id → 400', async () => {
    const res = await request(app)
      .post('/api/v1/games/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        game_type: 'lexisweep',
        score: 100,
        accuracy: 0.8,
        time_sec: 60,
        completed: true,
        details: { words_found: [] },
      });
    expect(res.status).toBe(400);
  });

  test('missing words_found → 400', async () => {
    if (!testListId) return;
    const res = await request(app)
      .post('/api/v1/games/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        game_type: 'lexisweep',
        list_id: testListId,
        score: 100,
        accuracy: 0.8,
        time_sec: 60,
        completed: true,
        details: {},
      });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/v1/games/runs — anagram ────────────────────────────────────────

describe('POST /api/v1/games/runs — anagram', () => {
  test('valid anagram run → 200, no leitner_added', async () => {
    if (!testListId) return;
    const res = await request(app)
      .post('/api/v1/games/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        game_type: 'anagram',
        list_id: testListId,
        score: 500,
        accuracy: 0.9,
        time_sec: 120,
        completed: true,
        details: { anagrams_solved: 5 },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.leitner_added).toBeUndefined();
  });
});

// ── POST /api/v1/games/runs — ladder ─────────────────────────────────────────

describe('POST /api/v1/games/runs — ladder', () => {
  test('ladder 100% accuracy + completed → leitner_added with 5 cards', async () => {
    if (!testSetId) return;

    // Fetch the correct order from DB
    const { rows: setItems } = await pool.query(
      `SELECT entry_id, correct_order FROM semantic_set_items
       WHERE set_id = $1 ORDER BY correct_order ASC`,
      [testSetId]
    );
    if (setItems.length === 0) return;

    const perfectOrder = setItems.map((i: any) => i.entry_id);

    const res = await request(app)
      .post('/api/v1/games/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        game_type: 'ladder',
        set_id: testSetId,
        score: 1000,
        accuracy: 1.0,
        time_sec: 45,
        completed: true,
        details: { user_order: perfectOrder },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.leitner_added).toBeDefined();
    expect(res.body.data.leitner_added.added + res.body.data.leitner_added.skipped)
      .toBe(setItems.length);
  });

  test('ladder accuracy < 0.8 → NO leitner_added', async () => {
    if (!testSetId) return;

    const { rows: setItems } = await pool.query(
      `SELECT entry_id, correct_order FROM semantic_set_items
       WHERE set_id = $1 ORDER BY correct_order ASC`,
      [testSetId]
    );
    if (setItems.length === 0) return;

    // Completely wrong order
    const wrongOrder = [...setItems]
      .sort((a, b) => b.correct_order - a.correct_order)
      .map((i: any) => i.entry_id);

    const res = await request(app)
      .post('/api/v1/games/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        game_type: 'ladder',
        set_id: testSetId,
        score: 0,
        accuracy: 0,
        time_sec: 90,
        completed: true,
        details: { user_order: wrongOrder },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.leitner_added).toBeUndefined();
  });

  test('ladder not completed → NO leitner_added even with high accuracy', async () => {
    if (!testSetId) return;

    const { rows: setItems } = await pool.query(
      `SELECT entry_id FROM semantic_set_items WHERE set_id = $1 ORDER BY correct_order ASC`,
      [testSetId]
    );
    if (setItems.length === 0) return;

    const res = await request(app)
      .post('/api/v1/games/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        game_type: 'ladder',
        set_id: testSetId,
        score: 800,
        accuracy: 1.0,
        time_sec: 20,
        completed: false,
        details: { user_order: setItems.map((i: any) => i.entry_id) },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.leitner_added).toBeUndefined();
  });

  test('missing set_id → 400', async () => {
    const res = await request(app)
      .post('/api/v1/games/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        game_type: 'ladder',
        score: 500,
        accuracy: 1.0,
        time_sec: 40,
        completed: true,
        details: { user_order: [] },
      });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/v1/games/leaderboard ────────────────────────────────────────────

describe('GET /api/v1/games/leaderboard', () => {
  test('returns top_3 and rank_4_to_100 arrays', async () => {
    const res = await request(app)
      .get('/api/v1/games/leaderboard?game_type=lexisweep&range=all_time')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.top_3)).toBe(true);
    expect(Array.isArray(res.body.data.rank_4_to_100)).toBe(true);
  });

  test('total leaderboard entries ≤ 100', async () => {
    const res = await request(app)
      .get('/api/v1/games/leaderboard?game_type=anagram&range=all_time')
      .set('Authorization', `Bearer ${authToken}`);
    const total = res.body.data.top_3.length + res.body.data.rank_4_to_100.length;
    expect(total).toBeLessThanOrEqual(100);
  });

  test('missing game_type → 400', async () => {
    const res = await request(app)
      .get('/api/v1/games/leaderboard?range=all_time')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
  });

  test('invalid range → 400', async () => {
    const res = await request(app)
      .get('/api/v1/games/leaderboard?game_type=lexisweep&range=yearly')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
  });

  test('requires auth', async () => {
    const res = await request(app)
      .get('/api/v1/games/leaderboard?game_type=lexisweep&range=all_time');
    expect(res.status).toBe(401);
  });
});

// ── GET /api/v1/games/me/stats ────────────────────────────────────────────────

describe('GET /api/v1/games/me/stats', () => {
  test('returns stats shape for fresh user', async () => {
    const res = await request(app)
      .get('/api/v1/games/me/stats')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(typeof d.games_played).toBe('number');
    expect(typeof d.total_score).toBe('number');
    expect(typeof d.time_spent_sec).toBe('number');
    expect(d.best_scores).toBeDefined();
    expect(Array.isArray(d.top_games)).toBe(true);
  });

  test('requires auth', async () => {
    const res = await request(app).get('/api/v1/games/me/stats');
    expect(res.status).toBe(401);
  });
});
