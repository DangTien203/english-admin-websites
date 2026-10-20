/**
 * `enrich:publish` (services/enrichment/oxford/publish.ts) against the real PostgreSQL with entries named "qzq<run>…". It must apply the
 * very rule of the bulk-publish button of /lookup/review; that is checked against the admin API itself. The command never publishes
 * without --confirm, and the tests only ever confirm on entries of their own: the plan query is narrowed to "qzq<run>%" (the real
 * database holds real '[auto]' entries that a confirm over the whole table would publish).
 */
import request from 'supertest';
import app from '../../app';
import pool from '../../config/db';
import { evaluate, planPublish, publishSelected, CLI_PUBLISH_VALUE, DEFAULT_PUBLISH_LIMIT } from '../../services/enrichment/oxford/publish';
import { runPublish } from '../../services/enrichment/oxford/run';
import { NOTE_CLEAN, RUN, cleanup, createAdmins, createEntry, fixtureWord, type AdminFixture, type Role } from '../helpers/lookupAdminFixtures';

jest.setTimeout(120_000);

let admins: Record<Role, AdminFixture>;

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
  admins = await createAdmins(app);
}, 60_000);

afterAll(async () => {
  await cleanup();
  await pool.end();
});

const withNotes = (notes: string[]) => `${NOTE_CLEAN} · ghi chú của Haiku: ${notes.join(' | ')}`;
const LIGHT = ['Mức CEFR C1 ước tính từ tần suất thấp (zipf 3.56); cần xem lại.', "Nghĩa 'đất sét bùn' rất hiếm và chuyên ngành nên không đưa vào."];
const BLOCKING = "Nghĩa 'phố' và 'dãy nhà' có thể gộp, cần kiểm tra lại.";

/**
 * Only the entries of ONE scenario: the plan query gets a headword filter (the SQL of the command is otherwise untouched). The real
 * database holds real '[auto]' entries that a confirm over the whole table would publish; and the entries of the other scenarios of
 * this file are still there, unpublished, until the end.
 */
const scope = (name: string) => ({
  query: (sql: string, params?: any[]) =>
    pool.query(sql.replace('WHERE admin_note LIKE $1 AND published = FALSE', `WHERE admin_note LIKE $1 AND published = FALSE AND headword LIKE 'qzq${RUN}${name}%'`), params),
});
const scopedSource = {
  connect: async () => pool.connect(),
};

const setLevel = (id: string, level: string | null) => pool.query(`UPDATE dictionary_entries SET cefr_level = $2 WHERE id = $1`, [id, level]);
const state = async (id: string) => (await pool.query(`SELECT published, admin_note FROM dictionary_entries WHERE id = $1`, [id])).rows[0];
const history = async (id: string) => (await pool.query(`SELECT admin_id, field_name, old_value, new_value FROM entry_edit_history WHERE entry_id = $1 AND field_name = 'published' ORDER BY created_at, id`, [id])).rows;

/** The fixture set; levels set so that ordering and --cefr can be checked. */
async function fixtures(name: string) {
  const L = (s: string) => `${name}${s}`;
  const ids = {
    clean1: await createEntry({ tag: L('CleanA') }),
    clean2: await createEntry({ tag: L('CleanB') }),
    clean3: await createEntry({ tag: L('CleanC') }),
    light: await createEntry({ tag: L('Light'), adminNote: withNotes(LIGHT) }),
    blocking: await createEntry({ tag: L('Blocking'), adminNote: withNotes([...LIGHT, BLOCKING]) }),
    noExample: await createEntry({ tag: L('NoExample'), senses: [{ pos: 'noun', definition_en: 'a thing', definition_vi: 'cái', examples: [] }] }),
    noMeaning: await createEntry({ tag: L('NoMeaning'), meaningVi: '' }),
    published: await createEntry({ tag: L('Published'), published: true }),
    manual: await createEntry({ tag: L('Manual'), adminNote: 'tạo tay' }),
  };
  await setLevel(ids.clean1, 'B1');
  await setLevel(ids.clean2, 'A1');
  await setLevel(ids.clean3, 'A1');
  await setLevel(ids.light, 'A2');
  return ids;
}
const letters = (s: string) => s.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);

describe('which entries are eligible', () => {
  it('[auto], not published, tier A complete, no note that needs a look — and not the others, each with its reason', async () => {
    const name = letters('elig');
    const ids = await fixtures(name);
    const plan = await planPublish(scope(name) as any);
    const eligible = new Set(plan.eligible.map((e) => e.id));
    for (const k of ['clean1', 'clean2', 'clean3', 'light'] as const) expect(eligible.has(ids[k])).toBe(true);
    for (const k of ['blocking', 'noExample', 'noMeaning', 'published', 'manual'] as const) expect(eligible.has(ids[k])).toBe(false);

    const skipped = Object.fromEntries(plan.skipped.map((s) => [s.id, s]));
    expect(skipped[ids.blocking]).toMatchObject({ reason: 'has_review_notes' });
    expect(skipped[ids.blocking].blocking!.map((b) => b.text)).toEqual([BLOCKING]);
    expect(skipped[ids.noExample]).toMatchObject({ reason: 'tier_a_incomplete' });
    expect(skipped[ids.noExample].tier_a_missing).toEqual(expect.arrayContaining([expect.stringContaining('ví dụ')]));
    expect(skipped[ids.noMeaning]).toMatchObject({ reason: 'tier_a_incomplete' });
    expect(skipped[ids.noMeaning].tier_a_missing).toContain('meaning_vi');
    expect(skipped[ids.published]).toBeUndefined(); // already published: not a candidate at all
    expect(skipped[ids.manual]).toBeUndefined(); // not [auto]
  });

  it('gives the same answer as eligible_for_bulk_publish of the admin API (the rule is not copied, and must not drift)', async () => {
    const name = letters('agree');
    const ids = await fixtures(name);
    const plan = await planPublish(scope(name) as any);
    const ours = new Set(plan.eligible.map((e) => e.id));

    const res = await admins.super_admin.agent.get(`/lookup/api/auto-entries?status=pending&q=${encodeURIComponent(fixtureWord(letters('agree')))}&limit=100`);
    expect(res.status).toBe(200);
    const rows: Array<{ id: string; eligible_for_bulk_publish: boolean }> = res.body.data.items;
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const r of rows) expect([r.id, ours.has(r.id)]).toEqual([r.id, r.eligible_for_bulk_publish]);
    expect(rows.some((r) => r.id === ids.blocking && r.eligible_for_bulk_publish === false)).toBe(true);
    expect(rows.some((r) => r.id === ids.light && r.eligible_for_bulk_publish === true)).toBe(true);
  });

  it('orders by CEFR level, then headword; --cefr narrows; --limit keeps the first N of the eligible', async () => {
    const name = letters('order');
    const ids = await fixtures(name);
    const scoped = scope(name);
    const all = await planPublish(scoped as any);
    expect(all.eligible.map((e) => e.id)).toEqual([ids.clean2, ids.clean3, ids.light, ids.clean1]); // A1 A1 (by headword), A2, B1

    const a = await planPublish(scoped as any, { cefr: ['A1'] });
    expect(a.eligible.map((e) => e.id)).toEqual([ids.clean2, ids.clean3]);
    const ab = await planPublish(scoped as any, { cefr: ['A2', 'B1'] });
    expect(ab.eligible.map((e) => e.id)).toEqual([ids.light, ids.clean1]);

    const two = await planPublish(scoped as any, { limit: 2 });
    expect(two.selected.map((e) => e.id)).toEqual([ids.clean2, ids.clean3]);
    expect(two.eligible).toHaveLength(4);
    expect(DEFAULT_PUBLISH_LIMIT).toBe(500);
    await expect(planPublish(scoped as any, { limit: 0 })).rejects.toThrow(/whole number/);
    await expect(planPublish(scoped as any, { limit: 5001 })).rejects.toThrow(/whole number/);
  });
});

describe('the command', () => {
  const io = (name: string) => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { db: scope(name) as any, source: scopedSource as any, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it('is a DRY RUN by default: says what it would do and publishes nothing', async () => {
    const name = letters('dry');
    const ids = await fixtures(name);
    const h = io(name);
    expect(await runPublish([], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('CHƯA XUẤT BẢN GÌ');
    expect(h.out.join('\n')).toMatch(/đủ điều kiện xuất bản hàng loạt: 4\b/);
    expect(h.out.join('\n')).toMatch(/giữ lại: thiếu tầng A 2 · có ghi chú cần xem 1/);
    expect(h.out.join('\n')).toContain('ghi chú');
    for (const id of Object.values(ids)) expect(await history(id)).toEqual([]);
    for (const k of ['clean1', 'clean2', 'light', 'blocking'] as const) expect((await state(ids[k])).published).toBe(false);
  });

  it('--dry-run is the same, with --cefr and --limit; --dry-run with --confirm is refused (exit 2), and so is a typo of --confirm', async () => {
    const name = letters('dryb');
    const ids = await fixtures(name);
    const h = io(name);
    expect(await runPublish(['--dry-run', '--cefr', 'A1', '--limit', '1'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('Lần này (--limit 1): 1 mục từ');
    expect((await state(ids.clean2)).published).toBe(false);
    for (const argv of [['--dry-run', '--confirm'], ['--confirmed'], ['--yes'], ['--cefr', 'Z9'], ['--limit', 'many']]) {
      const x = io(name);
      expect([argv, await runPublish(argv, x.deps)]).toEqual([argv, 2]);
      expect(x.out).toEqual([]);
    }
    expect((await state(ids.clean2)).published).toBe(false);
  });

  it('--confirm publishes the eligible ones (and only those), one history line each: admin_id NULL, old false, new "true (cli)"', async () => {
    const name = letters('conf');
    const ids = await fixtures(name);
    const h = io(name);
    expect(await runPublish(['--confirm', '--cefr', 'A1,A2'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('ĐÃ XUẤT BẢN 3 mục từ');

    for (const k of ['clean2', 'clean3', 'light'] as const) {
      expect((await state(ids[k])).published).toBe(true);
      expect(await history(ids[k])).toEqual([{ admin_id: null, field_name: 'published', old_value: 'false', new_value: CLI_PUBLISH_VALUE }]);
    }
    expect(CLI_PUBLISH_VALUE).toContain('cli');
    // the level was not in --cefr, or the rule holds it back, or it is not [auto] / already public: nothing happened
    for (const k of ['clean1', 'blocking', 'noExample', 'noMeaning', 'manual'] as const) {
      expect((await state(ids[k])).published).toBe(false);
      expect(await history(ids[k])).toEqual([]);
    }
    expect((await state(ids.published)).published).toBe(true);
    expect(await history(ids.published)).toEqual([]); // it was public before; no line added
  });

  it('--limit caps how many are published', async () => {
    const name = letters('lim');
    const ids = await fixtures(name);
    const h = io(name);
    expect(await runPublish(['--confirm', '--limit', '2'], h.deps)).toBe(0);
    const published = await Promise.all([ids.clean1, ids.clean2, ids.clean3, ids.light].map(async (id) => (await state(id)).published));
    expect(published.filter(Boolean)).toHaveLength(2);
    expect((await state(ids.clean2)).published).toBe(true); // A1 first
    expect((await state(ids.clean3)).published).toBe(true);
  });

  it('a second --confirm publishes nothing more (they are no longer candidates)', async () => {
    const name = letters('again');
    const ids = await fixtures(name);
    await runPublish(['--confirm'], io(name).deps);
    const second = io(name);
    expect(await runPublish(['--confirm'], second.deps)).toBe(0);
    expect(second.out.join('\n')).toContain('ĐÃ XUẤT BẢN 0 mục từ');
    expect(await history(ids.clean1)).toHaveLength(1);
  });
});

describe('writing', () => {
  it('re-applies the rule to the locked rows: an entry that became ineligible after the plan is dropped and reported', async () => {
    const name = letters('race');
    const ids = await fixtures(name);
    const plan = await planPublish(scope(name) as any);
    await pool.query(`UPDATE dictionary_entries SET admin_note = $2 WHERE id = $1`, [ids.clean1, withNotes([BLOCKING])]); // a blocking note appears
    await pool.query(`UPDATE dictionary_entries SET published = TRUE WHERE id = $1`, [ids.clean3]); // someone else publishes it
    const result = await publishSelected(scopedSource as any, plan.selected);
    const done = new Set(result.published.map((p) => p.id));
    expect(done.has(ids.clean1)).toBe(false);
    expect(done.has(ids.clean3)).toBe(false);
    expect(done.has(ids.clean2)).toBe(true);
    expect(result.dropped.map((d) => d.id)).toContain(ids.clean1);
    expect((await state(ids.clean1)).published).toBe(false);
    expect(await history(ids.clean3)).toEqual([]);
  });

  it('is ONE transaction: if the COMMIT fails, nothing is published and no history is written', async () => {
    const name = letters('atom');
    const ids = await fixtures(name);
    const plan = await planPublish(scope(name) as any);
    const failing = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, params?: any[]) => {
            if (/^\s*COMMIT/i.test(sql)) throw new Error('COMMIT failed (test)');
            return client.query(sql, params);
          },
          release: (e?: Error | boolean) => client.release(e),
        };
      },
    };
    await expect(publishSelected(failing as any, plan.selected)).rejects.toThrow('COMMIT failed');
    for (const id of [ids.clean1, ids.clean2, ids.clean3, ids.light]) {
      expect((await state(id)).published).toBe(false);
      expect(await history(id)).toEqual([]);
    }
  });

  it('with nothing selected it does not open a transaction', async () => {
    const connect = jest.fn();
    expect(await publishSelected({ connect } as any, [])).toEqual({ published: [], dropped: [] });
    expect(connect).not.toHaveBeenCalled();
  });

  it('evaluate reads the same facts as the admin page for an entry id it does not know: held back for the headword', async () => {
    const result = await evaluate(pool as any, [{ id: '00000000-0000-0000-0000-000000000000', headword: 'ghost', cefr_level: null, admin_note: NOTE_CLEAN }]);
    expect(result.eligible).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: 'tier_a_incomplete', tier_a_missing: ['headword'] });
  });
});
