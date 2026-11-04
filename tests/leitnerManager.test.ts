/**
 * utils/leitnerManager.ts — moveCard, applyPracticeCorrectAnswers and addToBox1IfNotExists each do their work in ONE SQL statement
 * (they were a lock-read, an update and an insert, one round trip each). The box rules did not change; these tests pin them down on
 * the real database, together with the error codes (404 / 409) and the "inside the caller's transaction" behaviour the review
 * sessions rely on.
 */
import pool from '../config/db';
import { addToBox1IfNotExists, applyPracticeCorrectAnswers, getIntervals, moveCard } from '../utils/leitnerManager';
import { RUN, cleanup, createEntry } from './helpers/lookupAdminFixtures';

jest.setTimeout(120_000);

const DAY_MS = 24 * 60 * 60 * 1000;
let counter = 0;
const userIds: string[] = [];
const entries: string[] = [];
let intervals: number[];

async function newUser(): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, level) VALUES ($1, 'x', 'LM Test', 'beginner') RETURNING id`,
    [`test-lmgr-${RUN}-${counter++}@example.com`]
  );
  userIds.push(rows[0].id);
  return rows[0].id;
}

async function newCard(userId: string, entryIndex: number, box: number, totalReviews = 0): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO leitner_cards (user_id, entry_id, box_number, due_at, source, added_from_mode, total_reviews, correct_streak)
     VALUES ($1, $2, $3, NOW() - INTERVAL '1 day', 'practice', 'test', $4, 2) RETURNING id`,
    [userId, entries[entryIndex], box, totalReviews]
  );
  return rows[0].id;
}

const card = async (id: string) =>
  (await pool.query('SELECT box_number, total_reviews, correct_streak, due_at, last_reviewed_at FROM leitner_cards WHERE id = $1', [id])).rows[0];
const reviews = async (cardId: string) =>
  (await pool.query('SELECT correct, old_box, new_box, time_ms FROM leitner_reviews WHERE leitner_card_id = $1 ORDER BY created_at', [cardId])).rows;

beforeAll(async () => {
  intervals = await getIntervals();
  for (const tag of ['a', 'b', 'c', 'd', 'e', 'f']) entries.push(await createEntry({ tag: `lm${tag}` }));
});

afterAll(async () => {
  if (userIds.length > 0) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]); // cards and reviews cascade
  await cleanup();
  await pool.end();
});

describe('moveCard', () => {
  it('a right answer moves the card up one box, schedules it by that box\'s interval and logs the review', async () => {
    const userId = await newUser();
    const id = await newCard(userId, 0, 1, 4);
    const before = Date.now();

    const r = await moveCard(id, userId, true, 1500);
    expect(r).toMatchObject({ newBoxNumber: 2, masteredNow: false });
    expect(Math.abs(r.nextDueAt.getTime() - (before + intervals[1] * DAY_MS))).toBeLessThan(10_000);

    expect(await card(id)).toMatchObject({ box_number: 2, total_reviews: 5, correct_streak: 3 });
    expect((await card(id)).last_reviewed_at).not.toBeNull();
    expect(await reviews(id)).toEqual([{ correct: true, old_box: 1, new_box: 2, time_ms: 1500 }]);
  });

  it('a wrong answer sends the card to box 1 and resets the streak', async () => {
    const userId = await newUser();
    const id = await newCard(userId, 0, 3);
    const r = await moveCard(id, userId, false);
    expect(r).toMatchObject({ newBoxNumber: 1, masteredNow: false });
    expect(await card(id)).toMatchObject({ box_number: 1, correct_streak: 0, total_reviews: 1 });
    expect(await reviews(id)).toEqual([{ correct: false, old_box: 3, new_box: 1, time_ms: null }]);
  });

  it('reaching box 5 says mastered_now once; a card already in box 5 stays there', async () => {
    const userId = await newUser();
    const id = await newCard(userId, 0, 4);
    expect(await moveCard(id, userId, true)).toMatchObject({ newBoxNumber: 5, masteredNow: true });
    expect(await moveCard(id, userId, true)).toMatchObject({ newBoxNumber: 5, masteredNow: false });
  });

  it('hold keeps the box, leaves the streak alone and brings a box 4 card back after 1 day', async () => {
    const userId = await newUser();
    const id = await newCard(userId, 0, 4);
    const r = await moveCard(id, userId, true, undefined, { hold: true });
    expect(r).toMatchObject({ newBoxNumber: 4, masteredNow: false });
    expect(Math.abs(r.nextDueAt.getTime() - (Date.now() + DAY_MS))).toBeLessThan(10_000);
    const row = await card(id);
    expect(row).toMatchObject({ box_number: 4, correct_streak: 2, total_reviews: 1 });
    expect(row.due_at.getTime() - row.last_reviewed_at.getTime()).toBe(DAY_MS); // exactly 24 h after the answer was recorded
    expect(await reviews(id)).toEqual([{ correct: true, old_box: 4, new_box: 4, time_ms: null }]);
  });

  it('hold brings a box 5 card back after 2 days (48 h from the answer), and it stays in box 5', async () => {
    const userId = await newUser();
    const id = await newCard(userId, 0, 5);
    const r = await moveCard(id, userId, true, undefined, { hold: true });
    expect(r).toMatchObject({ newBoxNumber: 5, masteredNow: false });
    expect(Math.abs(r.nextDueAt.getTime() - (Date.now() + 2 * DAY_MS))).toBeLessThan(10_000);
    const row = await card(id);
    expect(row).toMatchObject({ box_number: 5, correct_streak: 2, total_reviews: 1 });
    expect(row.due_at.getTime() - row.last_reviewed_at.getTime()).toBe(2 * DAY_MS);
    expect(await reviews(id)).toEqual([{ correct: true, old_box: 5, new_box: 5, time_ms: null }]);
  });

  it('only a hold is shortened: a full pass in box 4 or 5 keeps the box\'s own interval, and a box without a hold interval keeps it too', async () => {
    const userId = await newUser();
    const box4 = await newCard(userId, 0, 4);
    const box5 = await newCard(userId, 1, 5);
    const box2 = await newCard(userId, 2, 2);
    const near = (due: Date, days: number) => Math.abs(due.getTime() - (Date.now() + days * DAY_MS)) < 10_000;

    expect(near((await moveCard(box4, userId, true)).nextDueAt, intervals[4])).toBe(true); // 4 → 5: the interval of box 5
    expect(near((await moveCard(box5, userId, true)).nextDueAt, intervals[4])).toBe(true); // 5 → 5: the same
    expect(near((await moveCard(box2, userId, true, undefined, { hold: true })).nextDueAt, intervals[1])).toBe(true); // no hold interval for box 2
  });

  it('404 for a card that does not exist and for somebody else\'s card; nothing is written', async () => {
    const owner = await newUser();
    const other = await newUser();
    const id = await newCard(owner, 0, 2);

    await expect(moveCard('00000000-0000-4000-8000-000000000000', owner, true)).rejects.toMatchObject({ statusCode: 404 });
    await expect(moveCard(id, other, true)).rejects.toMatchObject({ statusCode: 404 });
    expect(await card(id)).toMatchObject({ box_number: 2, total_reviews: 0 });
    expect(await reviews(id)).toEqual([]);
  });

  it('409 when the card was reviewed since the caller looked (expectedTotalReviews); nothing is written, and a matching value goes through', async () => {
    const userId = await newUser();
    const id = await newCard(userId, 0, 2, 7);

    await expect(moveCard(id, userId, true, undefined, { expectedTotalReviews: 6 })).rejects.toMatchObject({ statusCode: 409 });
    expect(await card(id)).toMatchObject({ box_number: 2, total_reviews: 7 });
    expect(await reviews(id)).toEqual([]);

    await expect(moveCard(id, userId, true, undefined, { expectedTotalReviews: 7 })).resolves.toMatchObject({ newBoxNumber: 3 });
    expect(await card(id)).toMatchObject({ box_number: 3, total_reviews: 8 });
  });

  it('inside the caller\'s transaction it is part of it: a rollback undoes the move AND the review line', async () => {
    const userId = await newUser();
    const id = await newCard(userId, 0, 2);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await moveCard(id, userId, true, 900, { db: client });
      expect((await client.query('SELECT box_number FROM leitner_cards WHERE id = $1', [id])).rows[0].box_number).toBe(3);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await card(id)).toMatchObject({ box_number: 2, total_reviews: 0 });
    expect(await reviews(id)).toEqual([]);
  });
});

describe('applyPracticeCorrectAnswers', () => {
  it('moves the cards that exist up a box, adds the new words to box 1 and reports the counts', async () => {
    const userId = await newUser();
    const inBox2 = await newCard(userId, 0, 2);
    const inBox4 = await newCard(userId, 1, 4);
    const inBox5 = await newCard(userId, 2, 5);

    const r = await applyPracticeCorrectAnswers(userId, [entries[0], entries[1], entries[2], entries[3]], 'flashcard');
    expect(r).toEqual({ added: 1, advanced: 3, mastered_now: 1, skipped: 3 });

    expect((await card(inBox2)).box_number).toBe(3);
    expect((await card(inBox4)).box_number).toBe(5); // mastered now
    expect((await card(inBox5)).box_number).toBe(5); // stays
    expect(await reviews(inBox2)).toEqual([{ correct: true, old_box: 2, new_box: 3, time_ms: null }]);
    expect(await reviews(inBox5)).toEqual([{ correct: true, old_box: 5, new_box: 5, time_ms: null }]);

    const added = (await pool.query('SELECT box_number, source, added_from_mode, due_at FROM leitner_cards WHERE user_id = $1 AND entry_id = $2', [userId, entries[3]])).rows;
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ box_number: 1, source: 'practice', added_from_mode: 'flashcard' });
    expect(Math.abs(added[0].due_at.getTime() - (Date.now() + intervals[0] * DAY_MS))).toBeLessThan(10_000);
  });

  it('does nothing for an empty list, and counts a repeated entry once', async () => {
    const userId = await newUser();
    expect(await applyPracticeCorrectAnswers(userId, [], 'flashcard')).toEqual({ added: 0, advanced: 0, mastered_now: 0, skipped: 0 });

    const r = await applyPracticeCorrectAnswers(userId, [entries[4], entries[4]], 'swift_choice');
    expect(r).toMatchObject({ added: 1, advanced: 0 });
    expect(r.skipped).toBe(1);
    expect((await pool.query('SELECT 1 FROM leitner_cards WHERE user_id = $1 AND entry_id = $2', [userId, entries[4]])).rows).toHaveLength(1);
  });

  it('only touches the cards of the user it is called for', async () => {
    const mine = await newUser();
    const theirs = await newUser();
    const theirCard = await newCard(theirs, 0, 2);
    await applyPracticeCorrectAnswers(mine, [entries[0]], 'flashcard');
    expect((await card(theirCard)).box_number).toBe(2);
    expect(await reviews(theirCard)).toEqual([]);
  });
});

describe('addToBox1IfNotExists', () => {
  it('adds a new word to box 1, and says which box a known word is in', async () => {
    const userId = await newUser();
    expect(await addToBox1IfNotExists(userId, entries[5], 'retrieval_practice')).toEqual({ added: true });
    expect(await addToBox1IfNotExists(userId, entries[5], 'retrieval_practice')).toEqual({ added: false, existingBoxNumber: 1 });

    await newCard(userId, 0, 3);
    expect(await addToBox1IfNotExists(userId, entries[0], 'retrieval_practice')).toEqual({ added: false, existingBoxNumber: 3 });
  });
});
