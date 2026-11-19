/**
 * Migration 36 (practice_session_resume): practice_sessions gets options / last_activity_at / status / abandoned_at, practice_session_cards
 * stores the ordered queue of a session, plus indexes. The backfill (only on the run that adds the columns):
 *   status 'completed' where completed_at is set; last_activity_at = completed_at, else the latest answer, else started_at;
 *   open sessions untouched for more than 7 days become 'abandoned' WITHOUT touching Leitner.
 *
 * Real PostgreSQL. The new columns and the table are dropped, legacy rows inserted and the migration run INSIDE a transaction that is
 * rolled back, so the database keeps its schema and data whatever happens. Fixtures: a user "test-pracmig36-…@example.com", a deck,
 * 2 entries; removed in afterAll.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser } from './helpers/auth';
import { cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(240_000);

const ROOT = path.resolve(__dirname, '..');
const migration36 = require('../database/migrations/36_practice_session_resume') as (client: any) => Promise<void>;

let userId = '';
let deckId = '';
const cardIds: string[] = [];

beforeAll(async () => {
  const u = await registerUser('pracmig36');
  userId = u.userId;
  const deck = await request(app).post('/api/v1/decks').set('Authorization', `Bearer ${u.accessToken}`).send({ title: 'Migration 36 Deck', level: 'beginner' });
  if (deck.status !== 201) throw new Error(`deck: ${JSON.stringify(deck.body)}`);
  deckId = deck.body.data.id;
  for (let i = 0; i < 2; i++) {
    const entryId = await createEntry({ tag: `pn${String.fromCharCode(97 + i)}` });
    const card = await request(app).post(`/api/v1/decks/${deckId}/cards`).set('Authorization', `Bearer ${u.accessToken}`).send({ entry_id: entryId });
    if (card.status !== 201) throw new Error(`card: ${JSON.stringify(card.body)}`);
    cardIds.push(card.body.data.id);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'test-pracmig36-%'`);
  await cleanup();
  await pool.end();
});

describe('migration 36: registration and the applied schema', () => {
  it('is registered after 35, with a key that never changes, and the file exists', () => {
    const source = fs.readFileSync(path.join(ROOT, 'database', 'migrate.ts'), 'utf8');
    expect(source).toMatch(/key: '36_practice_session_resume'.*file: '\.\/migrations\/36_practice_session_resume'/);
    expect(source.indexOf("key: '36_practice_session_resume'")).toBeGreaterThan(source.indexOf("key: '35_practice_answer_idempotency'"));
    expect(fs.existsSync(path.join(ROOT, 'database', 'migrations', '36_practice_session_resume.ts'))).toBe(true);
  });

  it('is applied to this database: columns, defaults, queue table and indexes', async () => {
    expect((await pool.query(`SELECT 1 FROM schema_migrations WHERE key = '36_practice_session_resume'`)).rowCount).toBe(1);

    const cols = (
      await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'practice_sessions' AND column_name IN ('options','last_activity_at','status','abandoned_at')`
      )
    ).rows;
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(byName.options).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
    expect(byName.options.column_default).toContain("'{}'");
    expect(byName.last_activity_at).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'NO' });
    expect(byName.status).toMatchObject({ data_type: 'character varying', is_nullable: 'NO' });
    expect(byName.status.column_default).toContain("'open'");
    expect(byName.abandoned_at).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'YES' });

    const queue = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'practice_session_cards' ORDER BY ordinal_position`)).rows;
    expect(queue.map((c) => c.column_name)).toEqual(['session_id', 'position', 'card_id']);
    const pk = (await pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'practice_session_cards'::regclass AND contype = 'p'`)).rows[0];
    expect(pk.def).toMatch(/PRIMARY KEY \(session_id, "?position"?\)/);

    const indexes = (await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('practice_sessions','practice_session_cards')`)).rows;
    const def = (name: string) => indexes.find((i) => i.indexname === name)?.indexdef ?? '';
    expect(def('idx_practice_sessions_user_status_activity')).toMatch(/\(user_id, status, last_activity_at DESC\)/);
    expect(def('idx_practice_sessions_open_activity')).toMatch(/\(last_activity_at\).*WHERE.*status.*open/);
    expect(def('idx_practice_session_cards_card')).toMatch(/\(card_id\)/);
  });

  it('refuses a status that is not open / completed / abandoned, and a card queue entry of a card that does not exist', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO practice_sessions (user_id, deck_id, mode, total_count) VALUES ($1, $2, 'flashcard', 1) RETURNING id, status, options, last_activity_at`,
        [userId, deckId]
      );
      expect(rows[0]).toMatchObject({ status: 'open', options: {} });
      expect(Date.now() - rows[0].last_activity_at.getTime()).toBeLessThan(120_000);

      await client.query('SAVEPOINT bad_status');
      await expect(client.query(`UPDATE practice_sessions SET status = 'paused' WHERE id = $1`, [rows[0].id])).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT bad_status');

      await client.query('SAVEPOINT bad_card');
      await expect(
        client.query(`INSERT INTO practice_session_cards (session_id, position, card_id) VALUES ($1, 0, '00000000-0000-4000-8000-000000000000')`, [rows[0].id])
      ).rejects.toMatchObject({ code: '23503' });
      await client.query('ROLLBACK TO SAVEPOINT bad_card');

      // deleting the session takes its queue with it
      await client.query(`INSERT INTO practice_session_cards (session_id, position, card_id) VALUES ($1, 0, $2)`, [rows[0].id, cardIds[0]]);
      await client.query('DELETE FROM practice_sessions WHERE id = $1', [rows[0].id]);
      expect((await client.query('SELECT 1 FROM practice_session_cards WHERE session_id = $1', [rows[0].id])).rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('migration 36: the backfill of sessions that existed before', () => {
  it('completes, dates and (for stale open ones) abandons legacy sessions without touching Leitner; a second run changes nothing', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // the state before the migration
      await client.query(`ALTER TABLE practice_sessions DROP COLUMN options, DROP COLUMN last_activity_at, DROP COLUMN status, DROP COLUMN abandoned_at`);
      await client.query('DROP TABLE practice_session_cards');

      const legacy = async (o: { answered: number; startedAgo: string; completedAgo?: string }): Promise<string> =>
        (
          await client.query(
            `INSERT INTO practice_sessions (user_id, deck_id, mode, total_count, answered_count, correct_count, wrong_count, started_at, completed_at)
             VALUES ($1, $2, 'flashcard', 3, $3, $3, 0, now() - $4::interval, CASE WHEN $5::text IS NULL THEN NULL ELSE now() - $5::interval END)
             RETURNING id`,
            [userId, deckId, o.answered, o.startedAgo, o.completedAgo ?? null]
          )
        ).rows[0].id;
      const answered = (sessionId: string, ago: string) =>
        client.query(`INSERT INTO practice_answers (session_id, card_id, correct, created_at) VALUES ($1, $2, true, now() - $3::interval)`, [sessionId, cardIds[0], ago]);

      const completed = await legacy({ answered: 2, startedAgo: '40 days', completedAgo: '39 days' });
      await answered(completed, '39 days 1 hour');
      const staleWithAnswers = await legacy({ answered: 1, startedAgo: '20 days' });
      await answered(staleWithAnswers, '10 days'); //   last activity 10 days ago → expired
      const staleEmpty = await legacy({ answered: 0, startedAgo: '15 days' }); //  never answered, started 15 days ago → expired
      const freshWithAnswers = await legacy({ answered: 1, startedAgo: '5 days' });
      await answered(freshWithAnswers, '2 days'); //    still within 7 days → stays open
      const freshEmpty = await legacy({ answered: 0, startedAgo: '1 hour' });

      const leitnerBefore = (await client.query('SELECT COUNT(*)::int AS n FROM leitner_cards WHERE user_id = $1', [userId])).rows[0].n;
      await migration36(client);

      const state = async (id: string) =>
        (
          await client.query(
            `SELECT status, abandoned_at IS NOT NULL AS has_abandoned_at, completed_at, options,
                    EXTRACT(EPOCH FROM (now() - last_activity_at)) / 86400 AS idle_days
               FROM practice_sessions WHERE id = $1`,
            [id]
          )
        ).rows[0];
      const close = (value: number, expected: number) => expect(Math.abs(Number(value) - expected)).toBeLessThan(0.01);

      const c = await state(completed);
      expect(c).toMatchObject({ status: 'completed', has_abandoned_at: false, options: {} });
      close(c.idle_days, 39); // completed_at

      const sa = await state(staleWithAnswers);
      expect(sa).toMatchObject({ status: 'abandoned', has_abandoned_at: true, completed_at: null });
      close(sa.idle_days, 10); // the latest answer, not the migration time

      const se = await state(staleEmpty);
      expect(se).toMatchObject({ status: 'abandoned', has_abandoned_at: true });
      close(se.idle_days, 15); // started_at

      const fa = await state(freshWithAnswers);
      expect(fa).toMatchObject({ status: 'open', has_abandoned_at: false });
      close(fa.idle_days, 2);

      const fe = await state(freshEmpty);
      expect(fe).toMatchObject({ status: 'open', has_abandoned_at: false });
      close(fe.idle_days, 1 / 24); // started_at (1 hour ago)

      // Leitner was not touched by any of it, and the legacy sessions have no stored queue
      expect((await client.query('SELECT COUNT(*)::int AS n FROM leitner_cards WHERE user_id = $1', [userId])).rows[0].n).toBe(leitnerBefore);
      expect((await client.query('SELECT COUNT(*)::int AS n FROM practice_session_cards')).rows[0].n).toBe(0);

      // the migration reported what it did
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/backfilled.*marked abandoned/));

      // a second run: the columns exist, so nothing is backfilled again (the values below must survive)
      await client.query(`UPDATE practice_sessions SET status = 'open', abandoned_at = NULL, last_activity_at = now() - interval '30 days' WHERE id = $1`, [staleWithAnswers]);
      await migration36(client);
      expect(await state(staleWithAnswers)).toMatchObject({ status: 'open', has_abandoned_at: false });
      close((await state(staleWithAnswers)).idle_days, 30);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      log.mockRestore();
    }

    // the rollback put the schema back
    const { rowCount } = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'practice_sessions' AND column_name = 'status'`);
    expect(rowCount).toBe(1);
    expect((await pool.query(`SELECT to_regclass('practice_session_cards') AS t`)).rows[0].t).not.toBeNull();
  });
});
