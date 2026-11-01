/**
 * The admin models used to write the rows of a list one by one (one round trip each: adding 100 words to a deck, saving a lesson with 30
 * words, a plan with 12 features, importing a 1,000-word JSON file). They now send each list in ONE statement. These tests check, on the
 * real database, that the result is what the loops produced — order, duplicates, replacement, error reporting — and that the caches the
 * writers must invalidate are invalidated.
 */
import pool from '../config/db';
import Deck from '../models/Deck';
import DictionaryEntry from '../models/DictionaryEntry';
import Game from '../models/Game';
import Lesson from '../models/Lesson';
import Subscription from '../models/Subscription';
import * as gameCatalog from '../utils/gameCatalogCache';
import * as subscriptionHelper from '../utils/subscriptionHelper';
import { RUN, cleanup, createEntry, fixtureWord } from './helpers/lookupAdminFixtures';

jest.setTimeout(120_000);

const name = (tag: string) => `qzq${RUN} ${tag}`;
let adminId: string;
let e: string[] = []; // six entries
let tags: string[] = [];
const decks: string[] = [];

beforeAll(async () => {
  const admin = await pool.query(
    `INSERT INTO admin_accounts (email, password_hash, full_name, role) VALUES ($1, 'x', 'Batch Test', 'super_admin') RETURNING id`,
    [`p8-${RUN}-batch@example.com`] // removed by cleanup()
  );
  adminId = admin.rows[0].id;
  for (let i = 0; i < 6; i++) e.push(await createEntry({ tag: `bt${i}` }));
  for (const t of ['one', 'two', 'three']) {
    const r = await pool.query(`INSERT INTO tags (name) VALUES ($1) RETURNING id`, [`qzq${RUN}${t}`]);
    tags.push(r.rows[0].id);
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM decks WHERE title LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM lessons WHERE title LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM semantic_sets WHERE name LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM game_word_lists WHERE name LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM subscription_plans WHERE name LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM tags WHERE name LIKE $1`, [`qzq${RUN}%`]);
  await cleanup();
  await pool.end();
});

describe('Deck', () => {
  const tagsOf = async (deckId: string) =>
    (await pool.query('SELECT tag_id FROM deck_tags WHERE deck_id = $1 ORDER BY tag_id', [deckId])).rows.map((r) => r.tag_id).sort();
  const cardsOf = async (deckId: string) =>
    (await pool.query('SELECT entry_id, sort_order FROM cards WHERE deck_id = $1 ORDER BY sort_order', [deckId])).rows;

  it('create and update write the tags in one statement and replace them on update (a repeated tag counts once)', async () => {
    const deck = await Deck.create({ title: name('deck tags'), deck_type: 'premade', status: 'draft' }, [tags[0], tags[1], tags[0]]);
    decks.push(deck.id);
    expect(await tagsOf(deck.id)).toEqual([tags[0], tags[1]].sort());

    await Deck.update(deck.id, { title: name('deck tags'), deck_type: 'premade', status: 'draft' }, [tags[2]]);
    expect(await tagsOf(deck.id)).toEqual([tags[2]]);

    await Deck.update(deck.id, { title: name('deck tags'), deck_type: 'premade', status: 'draft' }, []);
    expect(await tagsOf(deck.id)).toEqual([]);
  });

  it('addCards numbers the new cards one after another, skips entries already there and repeats, and counts like the loop did', async () => {
    const deck = await Deck.create({ title: name('deck cards'), deck_type: 'premade', status: 'draft' });
    decks.push(deck.id);

    expect(await Deck.addCards(deck.id, [e[0], e[1], e[1], e[2]])).toEqual({ added: 3, skipped: 1 });
    expect(await cardsOf(deck.id)).toEqual([
      { entry_id: e[0], sort_order: 0 },
      { entry_id: e[1], sort_order: 1 },
      { entry_id: e[2], sort_order: 2 },
    ]);

    // e[2] is already in the deck: it uses no position, the new card follows the highest one
    expect(await Deck.addCards(deck.id, [e[2], e[3]])).toEqual({ added: 1, skipped: 1 });
    expect((await cardsOf(deck.id)).map((c) => [c.entry_id, c.sort_order])).toEqual([
      [e[0], 0], [e[1], 1], [e[2], 2], [e[3], 3],
    ]);

    expect(await Deck.addCards(deck.id, [])).toEqual({ added: 0, skipped: 0 });
    expect(await Deck.addCards(deck.id, [e[0]])).toEqual({ added: 0, skipped: 1 });
  });
});

describe('Lesson', () => {
  const entriesOf = async (id: string) => (await pool.query('SELECT entry_id, sort_order FROM lesson_entries WHERE lesson_id = $1 ORDER BY sort_order', [id])).rows;
  const tagsOf = async (id: string) => (await pool.query('SELECT tag_id FROM lesson_tags WHERE lesson_id = $1', [id])).rows.map((r) => r.tag_id).sort();

  it('create keeps the entries in the order given (position = index; a repeated entry keeps its first place) and writes the tags', async () => {
    const lesson = await Lesson.create({ title: name('lesson'), created_by: adminId }, [e[2], e[0], e[2], e[1]], [tags[0], tags[1], tags[1]]);
    expect(await entriesOf(lesson.id)).toEqual([
      { entry_id: e[2], sort_order: 0 },
      { entry_id: e[0], sort_order: 1 },
      { entry_id: e[1], sort_order: 3 }, // the repeat at index 2 was skipped and still used its position, as in the loop
    ]);
    expect(await tagsOf(lesson.id)).toEqual([tags[0], tags[1]].sort());
  });

  it('update replaces the entries and the tags', async () => {
    const lesson = await Lesson.create({ title: name('lesson update'), created_by: adminId }, [e[0], e[1]], [tags[0]]);
    await Lesson.update(lesson.id, { title: name('lesson update') }, [e[3]], [tags[2]]);
    expect(await entriesOf(lesson.id)).toEqual([{ entry_id: e[3], sort_order: 0 }]);
    expect(await tagsOf(lesson.id)).toEqual([tags[2]]);

    await Lesson.update(lesson.id, { title: name('lesson update') }, [], []);
    expect(await entriesOf(lesson.id)).toEqual([]);
    expect(await tagsOf(lesson.id)).toEqual([]);
  });
});

describe('DictionaryEntry', () => {
  const headwords = async (prefix: string) =>
    (await pool.query(`SELECT headword, pos, frequency_rank, cefr_level, created_by FROM dictionary_entries WHERE headword LIKE $1 ORDER BY headword`, [`${prefix}%`])).rows;

  it('create and update write the tags in one statement', async () => {
    const entry = await DictionaryEntry.create({ headword: fixtureWord('dtag'), lemma: fixtureWord('dtag'), meaning_vi: 'x', pos: ['noun'] }, [tags[0], tags[1], tags[0]]);
    const count = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM entry_tags WHERE entry_id = $1', [entry.id])).rows[0].n;
    expect(await count()).toBe(2);
    await DictionaryEntry.update(entry.id, { headword: fixtureWord('dtag'), lemma: fixtureWord('dtag'), meaning_vi: 'x', pos: ['noun'] }, [tags[2]]);
    expect(await count()).toBe(1);
  });

  it('imports a clean file in batches, skips rows that already exist, and reads the numbers like the old loop did', async () => {
    const rows = [
      { headword: ` ${fixtureWord('imp1').toUpperCase()} `, lemma: fixtureWord('imp1'), meaning_vi: 'một', pos: ['noun', 'verb'], frequency_rank: '120', cefr_level: 'A2' },
      { headword: fixtureWord('imp2'), lemma: fixtureWord('imp2'), meaning_vi: 'hai' },
    ];
    expect(await DictionaryEntry.importFromJson(rows, adminId)).toEqual({ inserted: 2, skipped: 0, errors: [] });
    expect(await DictionaryEntry.importFromJson(rows, adminId)).toEqual({ inserted: 0, skipped: 2, errors: [] }); // same headword + lemma

    const stored = await headwords(fixtureWord('imp'));
    expect(stored).toEqual([
      { headword: fixtureWord('imp1'), pos: ['noun', 'verb'], frequency_rank: 120, cefr_level: 'A2', created_by: adminId },
      { headword: fixtureWord('imp2'), pos: [], frequency_rank: null, cefr_level: null, created_by: adminId },
    ]);
  });

  it('a row the database refuses is reported with its own message, in file order, and the good rows around it still go in', async () => {
    const file = [
      { headword: fixtureWord('mix1'), lemma: fixtureWord('mix1'), meaning_vi: 'a' },
      { headword: fixtureWord('mixmissing'), lemma: fixtureWord('mixmissing') }, // no meaning_vi
      { headword: fixtureWord('mix1'), lemma: fixtureWord('mix1'), meaning_vi: 'a again' }, // repeats the first row
      { headword: fixtureWord('mixbad'), lemma: fixtureWord('mixbad'), meaning_vi: 'b', cefr_level: 'Z9' }, // CHECK constraint
      { headword: fixtureWord('mix2'), lemma: fixtureWord('mix2'), meaning_vi: 'c' },
    ];
    const r = await DictionaryEntry.importFromJson(file, adminId);
    expect(r.inserted).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/^Thiếu trường bắt buộc: /);
    expect(r.errors[1]).toContain(`${fixtureWord('mixbad')}/${fixtureWord('mixbad')}:`);
    expect((await headwords(fixtureWord('mix'))).map((h) => h.headword)).toEqual([fixtureWord('mix1'), fixtureWord('mix2')]);
  });

  it('stats gives both totals of the list page in one statement', async () => {
    const stats = await DictionaryEntry.stats();
    expect(stats.total).toBe(await DictionaryEntry.count());
    expect(stats.missingIpa).toBe(await DictionaryEntry.countMissingIpa());
  });
});

describe('Game', () => {
  it('writes a word list and a semantic set in one statement per kind of row, and drops the cached catalogs', async () => {
    const drop = jest.spyOn(gameCatalog, 'invalidateGameCatalog');
    try {
      const list = await Game.createWordList({ game_type: 'lexisweep', name: name('list'), level: 'beginner', status: 'draft', created_by: adminId }, [e[0], e[1], e[0]]);
      expect((await Game.getWordListById(list.id)).items.map((i: any) => i.entry_id).sort()).toEqual([e[0], e[1]].sort());
      await Game.updateWordList(list.id, { game_type: 'lexisweep', name: name('list'), level: 'beginner', status: 'draft' }, [e[2]]);
      expect((await Game.getWordListById(list.id)).items.map((i: any) => i.entry_id)).toEqual([e[2]]);

      const set = await Game.createSemanticSet(
        { name: name('set'), scale_description: 'cold → hot', level: 'beginner', status: 'draft', created_by: adminId },
        [
          { entry_id: e[0], correct_order: 1, hint_vi: 'lạnh' },
          { entry_id: e[1], correct_order: 2, hint_vi: '' },
          { entry_id: e[2], correct_order: 3 },
        ]
      );
      const items = async () =>
        (await pool.query('SELECT entry_id, correct_order, hint_vi FROM semantic_set_items WHERE set_id = $1 ORDER BY correct_order', [set.id])).rows;
      expect(await items()).toEqual([
        { entry_id: e[0], correct_order: 1, hint_vi: 'lạnh' },
        { entry_id: e[1], correct_order: 2, hint_vi: null },
        { entry_id: e[2], correct_order: 3, hint_vi: null },
      ]);
      await Game.updateSemanticSet(set.id, { name: name('set'), scale_description: 'x', level: 'beginner', status: 'draft' }, [{ entry_id: e[3], correct_order: 1 }]);
      expect(await items()).toEqual([{ entry_id: e[3], correct_order: 1, hint_vi: null }]);

      expect(drop.mock.calls.length).toBeGreaterThanOrEqual(4); // create/update of both
    } finally {
      drop.mockRestore();
    }
  });
});

describe('Subscription plans', () => {
  const featuresOf = async (planId: string) =>
    Object.fromEntries((await pool.query('SELECT feature_key, feature_value FROM plan_features WHERE plan_id = $1', [planId])).rows.map((r) => [r.feature_key, r.feature_value]));
  const methodsOf = async (planId: string) => (await pool.query('SELECT payment_method_id FROM plan_payment_methods WHERE plan_id = $1', [planId])).rows.map((r) => r.payment_method_id).sort();

  it('creates a plan with its features and payment methods (the last of two equal keys wins, blank keys are ignored) and drops the plan caches', async () => {
    const drop = jest.spyOn(subscriptionHelper, 'invalidatePlanCache');
    const methods = (await pool.query('SELECT id FROM payment_methods LIMIT 2')).rows.map((r) => r.id as string);
    try {
      const plan = await Subscription.createPlan(
        { name: name('plan'), price_monthly: 10 },
        [{ key: 'a', value: '1' }, { key: 'a', value: '2' }, { key: '  ', value: 'x' }, { key: 'b', value: '3' }],
        [...methods, ...methods, '']
      );
      expect(await featuresOf(plan.id)).toEqual({ a: '2', b: '3' });
      expect(await methodsOf(plan.id)).toEqual([...methods].sort());
      expect(drop).toHaveBeenCalled();

      drop.mockClear();
      await Subscription.updatePlan(plan.id, { name: name('plan'), price_monthly: 10 }, [{ key: 'c', value: '9' }], methods.slice(0, 1));
      expect(await featuresOf(plan.id)).toEqual({ c: '9' });
      expect(await methodsOf(plan.id)).toEqual(methods.slice(0, 1));
      expect(drop).toHaveBeenCalled();

      drop.mockClear();
      await Subscription.savePlanFeatures(plan.id, [{ key: 'd', value: '' }, { key: 'e', value: '5' }]);
      expect(await featuresOf(plan.id)).toEqual({ d: '', e: '5' });
      expect(drop).toHaveBeenCalled();
    } finally {
      drop.mockRestore();
    }
  });

  it('a repeated key on update is refused by the unique key, and nothing changes (as the loop of plain inserts did)', async () => {
    const plan = await Subscription.createPlan({ name: name('plan dup') }, [{ key: 'k', value: '1' }], []);
    await expect(
      Subscription.updatePlan(plan.id, { name: name('plan dup') }, [{ key: 'z', value: '1' }, { key: 'z', value: '2' }], [])
    ).rejects.toMatchObject({ code: '23505' });
    expect(await featuresOf(plan.id)).toEqual({ k: '1' }); // rolled back
  });
});
