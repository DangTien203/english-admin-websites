/**
 * `enrich:publish --accept-notes` (services/enrichment/oxford/publish.ts): a person has read the notes of Haiku that hold entries back
 * and accepts whole categories of them. Real PostgreSQL, entries named "qzq<run>…"; like oxfordPublish.integration.test.ts, the plan query
 * is narrowed to the entries of one scenario, because a confirm over the whole table would publish the real '[auto]' entries.
 */
import pool from '../../config/db';
import { evaluate, planPublish, publishedValue, publishSelected, CLI_PUBLISH_VALUE } from '../../services/enrichment/oxford/publish';
import { runPublish } from '../../services/enrichment/oxford/run';
import { classifyReviewNote } from '../../services/lookup/reviewNotes';
import { NOTE_CLEAN, RUN, cleanup, createEntry } from '../helpers/lookupAdminFixtures';

jest.setTimeout(120_000);

beforeAll(async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}, 60_000);

afterAll(async () => {
  await cleanup();
  await pool.end();
});

const DOUBT = "Nghĩa 'phố' và 'dãy nhà' có thể gộp, cần kiểm tra lại.";
const VALIDATOR = '[kiểm tra] senses[0].definition_en dùng lại chính từ đang định nghĩa';
const SENSITIVE = 'Nghĩa quan hệ tình dục theo euphemism trong Wiktionary đã được bỏ qua vì không phù hợp với từ điển học tập.';
const OTHER = "Dễ nhầm với 'compliment' (lời khen); nên nhấn mạnh sự khác biệt trong phần giải thích.";
const LIGHT = 'Mức CEFR C1 ước tính từ tần suất thấp (zipf 3.56); cần xem lại.';

const withNotes = (notes: string[]) => `${NOTE_CLEAN} · ghi chú của Haiku: ${notes.join(' | ')}`;
const letters = (s: string) => s.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
const scope = (name: string) => ({
  query: (sql: string, params?: any[]) =>
    pool.query(sql.replace('WHERE admin_note LIKE $1 AND published = FALSE', `WHERE admin_note LIKE $1 AND published = FALSE AND headword LIKE 'qzq${RUN}${name}%'`), params),
});
const source = { connect: async () => pool.connect() };

const state = async (id: string) => (await pool.query(`SELECT published FROM dictionary_entries WHERE id = $1`, [id])).rows[0];
const history = async (id: string) => (await pool.query(`SELECT old_value, new_value FROM entry_edit_history WHERE entry_id = $1 AND field_name = 'published' ORDER BY created_at, id`, [id])).rows;

async function fixtures(name: string) {
  const L = (s: string) => `${name}${s}`;
  return {
    clean: await createEntry({ tag: L('Clean') }),
    light: await createEntry({ tag: L('Light'), adminNote: withNotes([LIGHT]) }),
    doubt: await createEntry({ tag: L('Doubt'), adminNote: withNotes([LIGHT, DOUBT]) }),
    validator: await createEntry({ tag: L('Validator'), adminNote: withNotes([VALIDATOR]) }),
    other: await createEntry({ tag: L('Other'), adminNote: withNotes([OTHER]) }),
    sensitive: await createEntry({ tag: L('Sensitive'), adminNote: withNotes([SENSITIVE]) }),
    doubtAndSensitive: await createEntry({ tag: L('DoubtSens'), adminNote: withNotes([DOUBT, SENSITIVE]) }),
    noExample: await createEntry({ tag: L('NoExample'), adminNote: withNotes([DOUBT]), senses: [{ pos: 'noun', definition_en: 'a thing', definition_vi: 'cái', examples: [] }] }),
  };
}

it('the notes used here are in the categories the scenarios rely on', () => {
  expect(classifyReviewNote(DOUBT).category).toBe('meaning_doubt');
  expect(classifyReviewNote(VALIDATOR).category).toBe('validator_flag');
  expect(classifyReviewNote(SENSITIVE).category).toBe('sensitive');
  expect(classifyReviewNote(OTHER).category).toBe('other');
  expect(classifyReviewNote(LIGHT).blocks).toBe(false);
});

describe('the plan', () => {
  it('without --accept-notes nothing changes: every blocking note holds', async () => {
    const name = letters('plain');
    const ids = await fixtures(name);
    const plan = await planPublish(scope(name) as any);
    expect(new Set(plan.eligible.map((e) => e.id))).toEqual(new Set([ids.clean, ids.light]));
    expect(plan.eligible.every((e) => e.accepted === undefined)).toBe(true);
  });

  it('an accepted category lets the entries held back by it through; the others stay held, each with the notes that still hold it', async () => {
    const name = letters('some');
    const ids = await fixtures(name);
    const plan = await planPublish(scope(name) as any, { accept: ['meaning_doubt', 'validator_flag'] });

    const eligible = new Map(plan.eligible.map((e) => [e.id, e]));
    for (const k of ['clean', 'light', 'doubt', 'validator'] as const) expect(eligible.has(ids[k])).toBe(true);
    expect(eligible.get(ids.doubt)!.accepted).toEqual(['meaning_doubt']);
    expect(eligible.get(ids.validator)!.accepted).toEqual(['validator_flag']);
    expect(eligible.get(ids.clean)!.accepted).toBeUndefined();
    expect(eligible.get(ids.light)!.accepted).toBeUndefined();

    const skipped = new Map(plan.skipped.map((s) => [s.id, s]));
    expect(skipped.get(ids.other)).toMatchObject({ reason: 'has_review_notes' }); // 'other' was not named
    expect(skipped.get(ids.sensitive)).toMatchObject({ reason: 'has_review_notes' });
    // one of its two blocking notes was accepted, the other was not: it stays held, and says which one still holds it
    expect(skipped.get(ids.doubtAndSensitive)!.blocking!.map((b) => b.category)).toEqual(['sensitive']);
  });

  it('never waives tier A: an incomplete entry stays held whatever is accepted', async () => {
    const name = letters('tier');
    const ids = await fixtures(name);
    const plan = await planPublish(scope(name) as any, { accept: ['meaning_doubt', 'validator_flag', 'sensitive', 'proper_noun', 'other'] });
    expect(plan.skipped.find((s) => s.id === ids.noExample)).toMatchObject({ reason: 'tier_a_incomplete' });
    expect(plan.eligible.map((e) => e.id)).not.toContain(ids.noExample);
    // everything else goes through, the one with two accepted categories carrying both
    expect(plan.eligible).toHaveLength(7);
    expect(plan.eligible.find((e) => e.id === ids.doubtAndSensitive)!.accepted!.sort()).toEqual(['meaning_doubt', 'sensitive']);
  });
});

describe('the command', () => {
  const io = (name: string) => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { db: scope(name) as any, source: source as any, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it('is still a dry run by default, and says how many entries get through on the accepted notes', async () => {
    const name = letters('dry');
    const ids = await fixtures(name);
    const h = io(name);
    expect(await runPublish(['--accept-notes', 'meaning_doubt,validator_flag'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('CHƯA XUẤT BẢN GÌ');
    expect(text).toMatch(/đủ điều kiện xuất bản hàng loạt: 4\b/);
    expect(text).toMatch(/chấp nhận ghi chú nhóm meaning_doubt, validator_flag: 2 /);
    for (const id of Object.values(ids)) expect((await state(id)).published).toBe(false);
  });

  it('--confirm publishes them, and each history line says what was accepted for that entry (a clean one stays "true (cli)")', async () => {
    const name = letters('conf');
    const ids = await fixtures(name);
    const h = io(name);
    expect(await runPublish(['--confirm', '--accept-notes', 'meaning_doubt,validator_flag'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('ĐÃ XUẤT BẢN 4 mục từ');

    expect(await history(ids.clean)).toEqual([{ old_value: 'false', new_value: CLI_PUBLISH_VALUE }]);
    expect(await history(ids.light)).toEqual([{ old_value: 'false', new_value: CLI_PUBLISH_VALUE }]);
    expect(await history(ids.doubt)).toEqual([{ old_value: 'false', new_value: 'true (cli, accepted: meaning_doubt)' }]);
    expect(await history(ids.validator)).toEqual([{ old_value: 'false', new_value: 'true (cli, accepted: validator_flag)' }]);
    for (const k of ['clean', 'light', 'doubt', 'validator'] as const) expect((await state(ids[k])).published).toBe(true);
    for (const k of ['other', 'sensitive', 'doubtAndSensitive', 'noExample'] as const) {
      expect((await state(ids[k])).published).toBe(false);
      expect(await history(ids[k])).toEqual([]);
    }
  });

  it('"all" accepts every blocking category, and the history line of a rollback can be found with LIKE \'true (cli%\'', async () => {
    const name = letters('all');
    const ids = await fixtures(name);
    const h = io(name);
    expect(await runPublish(['--confirm', '--accept-notes', 'all'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('ĐÃ XUẤT BẢN 7 mục từ');
    expect((await state(ids.noExample)).published).toBe(false);

    const { rows } = await pool.query(
      `SELECT entry_id FROM entry_edit_history WHERE field_name = 'published' AND new_value LIKE 'true (cli%' AND entry_id = ANY($1::uuid[])`,
      [Object.values(ids)]
    );
    expect(rows).toHaveLength(7);
  });

  it.each([
    [['--accept-notes']],
    [['--accept-notes', '--confirm']],
    [['--accept-notes', 'cefr_estimate']], // a light category: nothing to accept
    [['--accept-notes', 'meaning_dobut']], // a typo is not "accept nothing"
    [['--accept-notes', 'all,other']],
    [['--accept-notes', ',']],
  ])('refuses %j (exit 2, says why, plans and publishes nothing)', async (argv) => {
    const h = io(letters('bad'));
    expect(await runPublish(argv, h.deps)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.err.join(' ')).toContain('usage: npm run enrich:publish');
  });
});

describe('publishSelected', () => {
  it('applies the same acceptance again on the locked rows: an entry that gained a note of another category meanwhile is dropped', async () => {
    const name = letters('race');
    const ids = await fixtures(name);
    const plan = await planPublish(scope(name) as any, { accept: ['meaning_doubt'] });
    expect(plan.selected.map((e) => e.id)).toContain(ids.doubt);

    // someone adds a sensitive note to it after the plan
    await pool.query(`UPDATE dictionary_entries SET admin_note = $2 WHERE id = $1`, [ids.doubt, withNotes([DOUBT, SENSITIVE])]);
    const result = await publishSelected(source as any, plan.selected, { accept: ['meaning_doubt'] });

    expect(result.published.map((p) => p.id)).not.toContain(ids.doubt);
    expect(result.dropped.map((d) => d.id)).toContain(ids.doubt);
    expect((await state(ids.doubt)).published).toBe(false);
    expect((await state(ids.clean)).published).toBe(true);
  });

  it('without the acceptance, the same entry is refused at the lock too (the plan said it was fine only because it asked for it)', async () => {
    const name = letters('lock');
    const ids = await fixtures(name);
    const plan = await planPublish(scope(name) as any, { accept: ['meaning_doubt'] });
    const result = await publishSelected(source as any, plan.selected); // the caller forgot to pass accept
    expect(result.published.map((p) => p.id)).not.toContain(ids.doubt);
    expect(result.dropped.map((d) => d.id)).toContain(ids.doubt);
  });
});

describe('publishedValue', () => {
  it('is the plain value for no categories and lists them sorted otherwise', () => {
    expect(publishedValue()).toBe('true (cli)');
    expect(publishedValue([])).toBe('true (cli)');
    expect(publishedValue(['validator_flag', 'meaning_doubt'])).toBe('true (cli, accepted: meaning_doubt,validator_flag)');
  });

  it('evaluate with nothing accepted is the rule as before', async () => {
    const name = letters('eval');
    const ids = await fixtures(name);
    const rows = (await pool.query(`SELECT id, headword, cefr_level, admin_note FROM dictionary_entries WHERE headword LIKE $1`, [`qzq${RUN}${name}%`])).rows;
    const { eligible } = await evaluate(pool as any, rows);
    expect(new Set(eligible.map((e) => e.id))).toEqual(new Set([ids.clean, ids.light]));
  });
});
