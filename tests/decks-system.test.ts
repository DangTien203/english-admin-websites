import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser, RegisteredUser } from './helpers/auth';

const TS = Date.now();
const EMAIL_PREFIX = `test-decks-system-`;
const SYSTEM_DECK_TITLE = `[ds-${TS}] System Verb Pack`;

let userA: RegisteredUser;
let userB: RegisteredUser;
let systemDeckId: string;
let userADeckId: string;

beforeAll(async () => {
  userA = await registerUser('decks-system-a');
  userB = await registerUser('decks-system-b');

  // Insert a published system deck directly via DB (no admin API exists in mobile surface).
  // is_system is GENERATED — never include it in the INSERT column list.
  const { rows } = await pool.query(
    `INSERT INTO decks (title, deck_type, status, level, sort_order)
     VALUES ($1, 'premade', 'published', 'beginner', 0)
     RETURNING id`,
    [SYSTEM_DECK_TITLE]
  );
  systemDeckId = rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  await pool.query(`DELETE FROM decks WHERE id = $1`, [systemDeckId]);
  await pool.end();
});

// ════════════════════════════════════════════════════════════════
describe('POST /api/v1/decks → user deck (is_system=false, isolated per user)', () => {
  it('user A creates deck → is_system=false, deck_type=user_created', async () => {
    const res = await request(app)
      .post('/api/v1/decks')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ title: `[ds-${TS}] User A Deck` });

    expect(res.status).toBe(201);
    expect(res.body.data.is_system).toBe(false);
    expect(res.body.data.deck_type).toBe('user_created');
    expect(res.body.data.user_id).toBe(userA.userId);
    userADeckId = res.body.data.id;
  });

  it("user A's deck appears in /decks/mine for A", async () => {
    const res = await request(app)
      .get('/api/v1/decks/mine')
      .set('Authorization', `Bearer ${userA.accessToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((d: any) => d.id);
    expect(ids).toContain(userADeckId);
  });

  it("user A's deck does NOT appear in /decks/mine for B", async () => {
    const res = await request(app)
      .get('/api/v1/decks/mine')
      .set('Authorization', `Bearer ${userB.accessToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((d: any) => d.id);
    expect(ids).not.toContain(userADeckId);
  });

  it('POST with body { is_system: true } → server forces is_system=false (Zod strips unknown)', async () => {
    const res = await request(app)
      .post('/api/v1/decks')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ title: `[ds-${TS}] Spoofed Deck`, is_system: true });

    expect(res.status).toBe(201);
    expect(res.body.data.is_system).toBe(false);
    expect(res.body.data.deck_type).toBe('user_created');
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/decks/system → both users see admin-created decks', () => {
  it('user A sees the system deck', async () => {
    const res = await request(app)
      .get('/api/v1/decks/system')
      .set('Authorization', `Bearer ${userA.accessToken}`);

    expect(res.status).toBe(200);
    const deck = res.body.data.items.find((d: any) => d.id === systemDeckId);
    expect(deck).toBeDefined();
    expect(deck.is_system).toBe(true);
    expect(deck.is_favorite).toBe(false);
    expect(deck.user_progress).toEqual({
      mastered_count: 0,
      in_progress_count: 0,
      completion_percent: 0,
    });
    expect(deck).toHaveProperty('total_cards');
    expect(deck).toHaveProperty('tags');
  });

  it('user B sees the same system deck', async () => {
    const res = await request(app)
      .get('/api/v1/decks/system')
      .set('Authorization', `Bearer ${userB.accessToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((d: any) => d.id);
    expect(ids).toContain(systemDeckId);
  });
});

// ════════════════════════════════════════════════════════════════
describe('POST/DELETE /api/v1/decks/:id/favorite', () => {
  it('user A favorites system deck → 204', async () => {
    const res = await request(app)
      .post(`/api/v1/decks/${systemDeckId}/favorite`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(res.status).toBe(204);
  });

  it("/decks/system shows is_favorite=true for A", async () => {
    const res = await request(app)
      .get('/api/v1/decks/system')
      .set('Authorization', `Bearer ${userA.accessToken}`);
    const deck = res.body.data.items.find((d: any) => d.id === systemDeckId);
    expect(deck.is_favorite).toBe(true);
  });

  it("/decks/system shows is_favorite=false for B (no leak)", async () => {
    const res = await request(app)
      .get('/api/v1/decks/system')
      .set('Authorization', `Bearer ${userB.accessToken}`);
    const deck = res.body.data.items.find((d: any) => d.id === systemDeckId);
    expect(deck.is_favorite).toBe(false);
  });

  it('favorite is idempotent — second POST still 204', async () => {
    const res = await request(app)
      .post(`/api/v1/decks/${systemDeckId}/favorite`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(res.status).toBe(204);
  });

  it('favoriting own user deck → 400 INVALID_OPERATION', async () => {
    // Reuse userADeckId (created earlier) — avoids hitting free-plan deck quota
    expect(userADeckId).toBeDefined();

    const res = await request(app)
      .post(`/api/v1/decks/${userADeckId}/favorite`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OPERATION');
  });

  it('DELETE favorite → 204', async () => {
    const res = await request(app)
      .delete(`/api/v1/decks/${systemDeckId}/favorite`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(res.status).toBe(204);
  });

  it('after DELETE, /decks/system shows is_favorite=false for A', async () => {
    const res = await request(app)
      .get('/api/v1/decks/system')
      .set('Authorization', `Bearer ${userA.accessToken}`);
    const deck = res.body.data.items.find((d: any) => d.id === systemDeckId);
    expect(deck.is_favorite).toBe(false);
  });

  it('DELETE is idempotent — DELETE non-favorited deck → 204', async () => {
    const res = await request(app)
      .delete(`/api/v1/decks/${systemDeckId}/favorite`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(res.status).toBe(204);
  });
});

// ════════════════════════════════════════════════════════════════
describe('PATCH/DELETE on system deck → 403 SYSTEM_DECK_FORBIDDEN', () => {
  it('PATCH system deck as regular user → 403', async () => {
    const res = await request(app)
      .patch(`/api/v1/decks/${systemDeckId}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ title: 'Hacked Title' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SYSTEM_DECK_FORBIDDEN');
  });

  it('DELETE system deck as regular user → 403', async () => {
    const res = await request(app)
      .delete(`/api/v1/decks/${systemDeckId}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SYSTEM_DECK_FORBIDDEN');
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/decks/:id includes new fields', () => {
  it('system deck detail includes is_system, is_favorite, user_progress', async () => {
    const res = await request(app)
      .get(`/api/v1/decks/${systemDeckId}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.is_system).toBe(true);
    expect(res.body.data).toHaveProperty('is_favorite');
    expect(res.body.data.user_progress).toEqual({
      mastered_count: 0,
      in_progress_count: 0,
      completion_percent: 0,
    });
  });
});

// ════════════════════════════════════════════════════════════════
describe('GET /api/v1/decks (deprecated) → keeps old shape, mine-only', () => {
  it('returns {summary, items, meta} shape and X-Deprecated header', async () => {
    const res = await request(app)
      .get('/api/v1/decks')
      .set('Authorization', `Bearer ${userA.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('summary');
    expect(res.body.data).toHaveProperty('items');
    expect(res.body.data).toHaveProperty('meta');
    expect(res.headers['x-deprecated']).toMatch(/decks\/mine|decks\/system/);

    // Should not include the system deck (mine-only)
    const ids = res.body.data.items.map((d: any) => d.id);
    expect(ids).not.toContain(systemDeckId);
  });
});
