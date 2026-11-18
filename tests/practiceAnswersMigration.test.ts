/**
 * Migration 35 (practice_answer_idempotency): practice_answers gets a UNIQUE (session_id, card_id).
 * It first removes the duplicate answers that were stored before (the EARLIEST row of each session + card stays) and recomputes the
 * counters of the sessions that lost rows from the rows that remain; sessions without duplicates are left alone.
 *
 * Real PostgreSQL. The index is dropped, the duplicates inserted and the migration run INSIDE a transaction that is rolled back, so
 * the database keeps its schema and data whatever happens. Fixtures: a user "test-pracmig-…@example.com", a deck, 3 entries; removed
 * in afterAll.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser } from './helpers/auth';
import { cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '..');
const migration35 = require('../database/migrations/35_practice_answer_idempotency') as (client: any) => Promise<void>;

let userId = '';
let deckId = '';
const cardIds: string[] = [];

beforeAll(async () => {
  const u = await registerUser('pracmig');
  userId = u.userId;
  const deck = await request(app).post('/api/v1/decks').set('Authorization', `Bearer ${u.accessToken}`).send({ title: 'Migration Deck', level: 'beginner' });
  if (deck.status !== 201) throw new Error(`deck: ${JSON.stringify(deck.body)}`);
  deckId = deck.body.data.id;
  for (let i = 0; i < 3; i++) {
    const entryId = await createEntry({ tag: `pm${String.fromCharCode(97 + i)}` });
    const card = await request(app).post(`/api/v1/decks/${deckId}/cards`).set('Authorization', `Bearer ${u.accessToken}`).send({ entry_id: entryId });
    if (card.status !== 201) throw new Error(`card: ${JSON.stringify(card.body)}`);
    cardIds.push(card.body.data.id);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-pracmig-%'`);
  await cleanup();
  await pool.end();
});

describe('migration 35: registration', () => {
  it('is registered after 34, with a key that never changes, and the file exists', () => {
    const source = fs.readFileSync(path.join(ROOT, 'database', 'migrate.ts'), 'utf8');
    expect(source).toMatch(/key: '35_practice_answer_idempotency'.*file: '\.\/migrations\/35_practice_answer_idempotency'/);
    expect(source.indexOf("key: '35_practice_answer_idempotency'")).toBeGreaterThan(source.indexOf("key: '34_performance_indexes'"));
    expect(fs.existsSync(path.join(ROOT, 'database', 'migrations', '35_practice_answer_idempotency.ts'))).toBe(true);
  });

  it('is applied to this database: the unique index exists and a second answer for the same session + card is refused', async () => {
    const { rows } = await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_practice_answers_session_card'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE INDEX .* ON public\.practice_answers .*\(session_id, card_id\)/);
    expect((await pool.query(`SELECT 1 FROM schema_migrations WHERE key = '35_practice_answer_idempotency'`)).rowCount).toBe(1);
  });
});

describe('migration 35: dedupe and counters', () => {
  it('keeps the earliest answer of each session + card, recomputes the counters of the sessions that lost rows, leaves the others', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX idx_practice_answers_session_card'); // the state before the migration

      const session = async (total: number, answered: number, correct: number, wrong: number): Promise<string> =>
        (
          await client.query(
            `INSERT INTO practice_sessions (user_id, deck_id, mode, total_count, answered_count, correct_count, wrong_count) VALUES ($1, $2, 'flashcard', $3, $4, $5, $6) RETURNING id`,
            [userId, deckId, total, answered, correct, wrong]
          )
        ).rows[0].id;
      const answer = async (sessionId: string, card: string, correct: boolean, minutesAgo: number): Promise<string> =>
        (
          await client.query(
            `INSERT INTO practice_answers (session_id, card_id, correct, created_at) VALUES ($1, $2, $3, now() - make_interval(mins => $4)) RETURNING id`,
            [sessionId, card, correct, minutesAgo]
          )
        ).rows[0].id;

      // S1: card A answered 3 times, card B once, card C twice; the counters counted all 6 rows (4 right, 2 wrong).
      const s1 = await session(5, 6, 4, 2);
      const a2 = await answer(s1, cardIds[0], true, 5); //  later than a1, inserted FIRST: insertion order must not matter
      const a3 = await answer(s1, cardIds[0], true, 4);
      const a1 = await answer(s1, cardIds[0], false, 10); // the earliest of card A → kept (wrong)
      const b1 = await answer(s1, cardIds[1], true, 9);
      const c1 = await answer(s1, cardIds[2], true, 8); //   the earliest of card C → kept (right)
      const c2 = await answer(s1, cardIds[2], false, 3);
      // S2: no duplicates; its counters do not match its single row on purpose: a session that lost nothing is not recomputed.
      const s2 = await session(3, 2, 2, 0);
      const s2a = await answer(s2, cardIds[0], true, 7);
      // S3: two rows with the very same time: one stays, whichever it is
      const s3 = await session(2, 2, 2, 0);
      await answer(s3, cardIds[1], true, 6);
      await answer(s3, cardIds[1], true, 6);
      // the same card in another session is a different answer
      const s4 = await session(1, 1, 1, 0);
      const s4a = await answer(s4, cardIds[0], true, 2);

      const rowsOf = async (sessionId: string) => (await client.query('SELECT id, card_id, correct FROM practice_answers WHERE session_id = $1 ORDER BY card_id', [sessionId])).rows;
      const countersOf = async (sessionId: string) =>
        (await client.query('SELECT answered_count, correct_count, wrong_count FROM practice_sessions WHERE id = $1', [sessionId])).rows[0];

      expect(await rowsOf(s1)).toHaveLength(6);

      await migration35(client);

      expect((await rowsOf(s1)).map((r) => r.id).sort()).toEqual([a1, b1, c1].sort());
      expect(await countersOf(s1)).toEqual({ answered_count: 3, correct_count: 2, wrong_count: 1 });
      expect(await rowsOf(s2)).toEqual([{ id: s2a, card_id: cardIds[0], correct: true }]);
      expect(await countersOf(s2)).toEqual({ answered_count: 2, correct_count: 2, wrong_count: 0 }); // untouched
      expect(await rowsOf(s3)).toHaveLength(1);
      expect(await countersOf(s3)).toEqual({ answered_count: 1, correct_count: 1, wrong_count: 0 });
      expect((await rowsOf(s4)).map((r) => r.id)).toEqual([s4a]);
      expect(await countersOf(s4)).toEqual({ answered_count: 1, correct_count: 1, wrong_count: 0 });
      for (const gone of [a2, a3, c2]) {
        expect((await client.query('SELECT 1 FROM practice_answers WHERE id = $1', [gone])).rowCount).toBe(0);
      }

      // the index is back and enforces what the route relies on
      const index = await client.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_practice_answers_session_card'`);
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0].indexdef).toMatch(/UNIQUE/);
      await client.query('SAVEPOINT dup');
      await expect(answer(s1, cardIds[1], true, 1)).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK TO SAVEPOINT dup');

      // a second run finds nothing to do
      const snapshot = async () => JSON.stringify([await rowsOf(s1), await rowsOf(s3), await countersOf(s1), await countersOf(s2), await countersOf(s3)]);
      const before = await snapshot();
      await migration35(client);
      expect(await snapshot()).toBe(before);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      log.mockRestore();
    }

    // the rollback put everything back
    const { rowCount } = await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_practice_answers_session_card'`);
    expect(rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM practice_sessions WHERE user_id = $1', [userId])).rowCount).toBe(0);
  });

  it('on a database without duplicates it removes nothing (as the real run did)', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const count = async () => (await client.query('SELECT COUNT(*)::int AS n FROM practice_answers')).rows[0].n;
      const before = await count();
      await migration35(client);
      expect(await count()).toBe(before);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('0 duplicate row(s) removed'));
    } finally {
      await client.query('ROLLBACK');
      client.release();
      log.mockRestore();
    }
  });
});
