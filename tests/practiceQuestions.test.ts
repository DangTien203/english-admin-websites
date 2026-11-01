import { randomBytes } from 'crypto';
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser } from './helpers/auth';

jest.setTimeout(180_000);

const prefix = 'qzqbatch' + [...randomBytes(8)].map((n) => String.fromCharCode(97 + n % 26)).join('');
const words = Array.from({ length: 23 }, (_, i) => prefix + String.fromCharCode(97 + i));
const missing = '00000000-0000-4000-8000-000000000000';
const users: string[] = [];
const decks: string[] = [];
const entries: string[] = [];
let token = '';
let cards: string[] = [];
let foreign: string;
let publicCards: string[];
let hidden: string;

const batch = (body: object) => request(app).post('/api/v1/practice/questions')
  .set('Authorization', `Bearer ${token}`).send(body);

beforeAll(async () => {
  const owner = await registerUser(`batch-${prefix}`);
  users.push(owner.userId);
  token = owner.accessToken;
  const other = await registerUser(`batch-other-${prefix}`);
  users.push(other.userId);
  const result = await pool.query(`
    INSERT INTO dictionary_entries (headword, lemma, pos, cefr_level, meaning_vi, example_en, published, source)
    SELECT word, word,
      CASE WHEN ord = 21 THEN ARRAY[$2::varchar] WHEN ord = 2 THEN NULL
           WHEN ord = 3 THEN ARRAY[]::varchar[] ELSE ARRAY[$3::varchar] END,
      'B1', 'meaning ' || ord,
      CASE WHEN ord = 22 THEN NULL WHEN ord = 23 THEN 'Nothing matches here.'
           ELSE 'We use ' || word || ' every day.' END, TRUE, 'manual'
    FROM unnest($1::text[]) WITH ORDINALITY AS input(word, ord)
    RETURNING id, headword`, [words, `sparse${prefix}`, `pos${prefix}`]);
  entries.push(...result.rows.map((r) => r.id));
  const entryByWord = new Map(result.rows.map((r) => [r.headword, r.id]));
  const orderedEntries = words.map((word) => entryByWord.get(word));
  const sense = await pool.query(`
    INSERT INTO entry_senses (entry_id, pos, sense_order, definition_vi)
    VALUES ($1, 'noun', 0, 'sense meaning') RETURNING id`, [orderedEntries[0]]);
  await pool.query('INSERT INTO sense_examples (sense_id, example_en) VALUES ($1, $2)',
    [sense.rows[0].id, `We see ${words[0]}s.`]);
  await pool.query(`INSERT INTO word_forms (entry_id, form_type, form_value)
    VALUES ($1, 'plural', $2)`, [orderedEntries[0], `${words[0]}s`]);
  // Remove the legacy example so this card can only be solved via its plural form.
  await pool.query('UPDATE dictionary_entries SET example_en = NULL WHERE id = $1', [orderedEntries[0]]);
  const deckRows = await pool.query(`
    INSERT INTO decks (title, user_id, deck_type, status)
    SELECT $3 || ord, owner_id, kind, state FROM unnest(
      $1::uuid[], $2::text[], ARRAY['draft','draft','published','published','draft']::text[]
    ) WITH ORDINALITY AS input(owner_id, kind, state, ord)
    RETURNING id, title`, [[owner.userId, other.userId, other.userId, other.userId, other.userId],
      ['user_created', 'user_created', 'premade', 'system_generated', 'premade'], prefix]);
  decks.push(...deckRows.rows.map((r) => r.id));
  const deckByNumber = new Map(deckRows.rows.map((r) => [r.title, r.id]));
  const own = deckByNumber.get(`${prefix}1`);
  const inserted = await pool.query(`INSERT INTO cards (deck_id, entry_id)
    SELECT $1, unnest($2::uuid[]) RETURNING id, entry_id`, [own, orderedEntries]);
  const cardByEntry = new Map(inserted.rows.map((r) => [r.entry_id, r.id]));
  cards = orderedEntries.map((id) => cardByEntry.get(id));
  const extra = await pool.query(`INSERT INTO cards (deck_id, entry_id)
    SELECT unnest($1::uuid[]), $2 RETURNING id, deck_id`,
    [[2, 3, 4, 5].map((n) => deckByNumber.get(`${prefix}${n}`)), orderedEntries[0]]);
  const extraByDeck = new Map(extra.rows.map((r) => [r.deck_id, r.id]));
  foreign = extraByDeck.get(deckByNumber.get(`${prefix}2`));
  publicCards = [3, 4].map((n) => extraByDeck.get(deckByNumber.get(`${prefix}${n}`)));
  hidden = extraByDeck.get(deckByNumber.get(`${prefix}5`));
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await pool.query('DELETE FROM decks WHERE id = ANY($1::uuid[])', [decks]);
  await pool.query('DELETE FROM dictionary_entries WHERE id = ANY($1::uuid[])', [entries]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
  await pool.end();
});

it('requires auth before loading any question data', async () => {
  const query = jest.spyOn(pool, 'query');
  const res = await request(app).post('/api/v1/practice/questions')
    .send({ card_ids: [cards[0]], type: 'swift_choice' });
  expect(res.status).toBe(401);
  expect(res.body.error.code).toBe('NO_TOKEN');
  expect(query).not.toHaveBeenCalled();
});

it.each([
  {}, { card_ids: [], type: 'swift_choice' },
  { card_ids: Array(21).fill(missing), type: 'cloze' },
  { card_ids: ['not-a-uuid'], type: 'cloze' },
  { card_ids: [missing], type: 'other' },
  { card_ids: [missing], type: 'cloze', level: 0 },
  { card_ids: [missing], type: 'cloze', level: 4 },
  { card_ids: [missing], type: 'cloze', level: '1' },
])('validates the whole batch before loading it: %j', async (body) => {
  const query = jest.spyOn(pool, 'query');
  const res = await batch(body);
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('VALIDATION_ERROR');
  expect(query).toHaveBeenCalledTimes(1); // Authentication only.
});

it.each([1, 10, 20])('loads %i SwiftChoice questions with 1 data query plus auth', async (size) => {
  const query = jest.spyOn(pool, 'query');
  const ids = cards.slice(0, size).reverse();
  const res = await batch({ card_ids: ids, type: 'swift_choice' });
  expect(res.status).toBe(200);
  expect(res.body.data.map((q: any) => q.card_id)).toEqual(ids);
  for (const q of res.body.data) {
    expect(q.question_type).toBe('meaning_from_word');
    expect(q.options).toHaveLength(4);
    expect(q.options[q.correct_index].text).toBe(cards.indexOf(q.card_id) === 0 ? 'sense meaning' : `meaning ${cards.indexOf(q.card_id) + 1}`);
  }
  expect(query).toHaveBeenCalledTimes(2);
});

it('10 individual SwiftChoice calls use 40 statements; one batch uses 2 including auth', async () => {
  const query = jest.spyOn(pool, 'query');
  for (const cardId of cards.slice(0, 10)) {
    const res = await request(app).post('/api/v1/practice/swift-choice/question')
      .set('Authorization', `Bearer ${token}`).send({ card_id: cardId });
    expect(res.status).toBe(200);
  }
  expect(query).toHaveBeenCalledTimes(40);
  query.mockClear();
  expect((await batch({ card_ids: cards.slice(0, 10), type: 'swift_choice' })).status).toBe(200);
  expect(query).toHaveBeenCalledTimes(2);
});

it('keeps successes alongside sparse, missing, foreign and unpublished-card errors', async () => {
  const ids = [cards[0], cards[20], missing, foreign, hidden, ...publicCards, cards[0].toUpperCase()];
  const query = jest.spyOn(pool, 'query');
  const res = await batch({ card_ids: ids, type: 'swift_choice' });
  expect(res.status).toBe(200);
  expect(res.body.data.map((q: any) => q.card_id)).toEqual(ids);
  expect(res.body.data[0].prompt.word).toBe(words[0]);
  expect(res.body.data[1].error.code).toBe('INSUFFICIENT_DISTRACTORS');
  for (const i of [2, 3, 4]) {
    expect(res.body.data[i]).toEqual({ card_id: ids[i], error: { code: 'CARD_NOT_FOUND', message: 'Card not found.' } });
  }
  for (const i of [5, 6, 7]) expect(res.body.data[i].prompt.word).toBe(words[0]);
  expect(query).toHaveBeenCalledTimes(2);
});

it.each([1, 2, 3])('Cloze level %i uses 1 data query and the existing forms/example logic', async (level) => {
  const query = jest.spyOn(pool, 'query');
  const res = await batch({ card_ids: cards.slice(0, 20), type: 'cloze', level });
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(20);
  expect(query).toHaveBeenCalledTimes(2);
  expect(res.body.data[0]).toMatchObject({ target_word: `${words[0]}s`, hint_tense: 'plural', sentence_masked: 'We see ___.', level });
  for (const q of res.body.data) {
    expect(q.error).toBeUndefined();
    expect(q.level).toBe(level);
    if (level === 1) expect(q.word_choices).toHaveLength(4);
    else expect(q.word_choices).toBeNull();
    if (level === 2) expect(q.scrambled_letters.length).toBeGreaterThan(q.target_word.length);
    else expect(q.scrambled_letters).toBeNull();
  }
});

it('defaults Cloze to level 1 and reports both kinds of unusable example per item', async () => {
  const res = await batch({ card_ids: [cards[0], cards[21], cards[22]], type: 'cloze' });
  expect(res.status).toBe(200);
  expect(res.body.data[0].level).toBe(1);
  expect(res.body.data[1].error.code).toBe('NO_EXAMPLES');
  expect(res.body.data[2].error.code).toBe('NO_EXAMPLES');
});
