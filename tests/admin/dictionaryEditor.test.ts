/**
 * The existing entry editor (/dictionary/:id/edit) is where the "Sửa" button of the review page (/lookup/review) leads. Two
 * things in it would have undone the review: an unticked "Published" box used to PUBLISH the entry (the field is absent, and
 * absent counted as true), and a part of speech outside its fixed list was dropped on save. Real app, real PostgreSQL.
 */
import app from '../../app';
import pool from '../../config/db';
import { cleanup, createAdmins, createEntry, fixtureWord, type AdminFixture, type Role } from '../helpers/lookupAdminFixtures';

let admins: Record<Role, AdminFixture>;
const spies: jest.SpyInstance[] = [];

beforeAll(async () => {
  admins = await createAdmins(app);
});
beforeEach(() => {
  for (const level of ['info', 'warn', 'error', 'log'] as const) spies.push(jest.spyOn(console, level).mockImplementation(() => undefined));
});
afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const entryRow = async (id: string) => (await pool.query(`SELECT published, pos, headword, source, admin_note FROM dictionary_entries WHERE id = $1`, [id])).rows[0];
const history = async (id: string) =>
  (await pool.query(`SELECT old_value, new_value, admin_id FROM entry_edit_history WHERE entry_id = $1 AND field_name = 'published' ORDER BY created_at, id`, [id])).rows;

/** What the form posts: every field of the page; `published` only when the box is ticked. */
function form(id: string, tag: string, extra: Record<string, unknown> = {}) {
  return { headword: fixtureWord(tag), lemma: fixtureWord(tag), meaning_vi: 'nghĩa đã sửa', source: 'wiktionary', admin_note: '[auto] ghi chú', pos: ['noun'], ...extra };
}

describe('saving the editor', () => {
  it('a pending entry saved with the box unticked STAYS pending, and no history line is written', async () => {
    const id = await createEntry({ tag: 'edpend' });
    const res = await admins.content_editor.agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, 'edpend'));
    expect([res.status, res.headers.location]).toEqual([302, `/dictionary/${id}`]);
    expect((await entryRow(id)).published).toBe(false);
    expect(await history(id)).toHaveLength(0);
  });

  it('ticking the box publishes, and the history says who', async () => {
    const id = await createEntry({ tag: 'edtick' });
    await admins.content_editor.agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, 'edtick', { published: 'true' }));
    expect((await entryRow(id)).published).toBe(true);
    expect(await history(id)).toEqual([{ old_value: 'false', new_value: 'true', admin_id: admins.content_editor.id }]);
  });

  it('unticking the box on a published entry hides it, and the history says who', async () => {
    const id = await createEntry({ tag: 'eduntick', published: true });
    await admins.super_admin.agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, 'eduntick'));
    expect((await entryRow(id)).published).toBe(false);
    expect(await history(id)).toEqual([{ old_value: 'true', new_value: 'false', admin_id: admins.super_admin.id }]);
  });

  it('keeps a published entry published when the box stays ticked, without a new history line', async () => {
    const id = await createEntry({ tag: 'edkeep', published: true });
    await admins.content_editor.agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, 'edkeep', { published: 'true' }));
    expect((await entryRow(id)).published).toBe(true);
    expect(await history(id)).toHaveLength(0);
  });

  it('saves the other fields as before', async () => {
    const id = await createEntry({ tag: 'edfields' });
    await admins.content_editor.agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, 'edfields', { meaning_vi: 'thử nghiệm', cefr_level: 'C1' }));
    const row = (await pool.query(`SELECT meaning_vi, cefr_level, admin_note FROM dictionary_entries WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ meaning_vi: 'thử nghiệm', cefr_level: 'C1', admin_note: '[auto] ghi chú' });
  });
});

// ── P9: who may change `published` in the editor ─────────────────────────────────────────────────────────────────────
describe('a moderator saving the editor (the old route to the "Published" box)', () => {
  let lines: any[] = [];
  beforeEach(() => {
    lines = [];
    spies.splice(0).forEach((s) => s.mockRestore());
    for (const level of ['info', 'warn', 'error', 'log'] as const) {
      spies.push(
        jest.spyOn(console, level).mockImplementation((line: unknown) => {
          try {
            const parsed = JSON.parse(String(line));
            if (parsed.evt === 'admin_action') lines.push(parsed);
          } catch {
            /* not a JSON line */
          }
        })
      );
    }
  });

  it('cannot publish a pending entry by ticking the box: the entry stays pending, nothing is written to the history, the try is logged', async () => {
    const id = await createEntry({ tag: 'modtick' });
    const res = await admins.moderator.agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, 'modtick', { published: 'true' }));
    expect([res.status, res.headers.location]).toEqual([302, `/dictionary/${id}`]);
    expect((await entryRow(id)).published).toBe(false);
    expect(await history(id)).toHaveLength(0);
    expect(lines).toEqual([
      expect.objectContaining({ evt: 'admin_action', admin_id: admins.moderator.id, action: 'dictionary.edit.published', target_id: id, result: 'forbidden', requested: true, kept: false }),
    ]);
  });

  it('cannot hide a published entry either, by sending published=false', async () => {
    const id = await createEntry({ tag: 'modhide', published: true });
    await admins.moderator.agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, 'modhide', { published: 'false' }));
    expect((await entryRow(id)).published).toBe(true);
    expect(await history(id)).toHaveLength(0);
    expect(lines).toEqual([expect.objectContaining({ action: 'dictionary.edit.published', result: 'forbidden', requested: false, kept: true })]);
  });

  it('saving the page as it was drawn (the box disabled, so no field) keeps a published entry published and logs nothing', async () => {
    const id = await createEntry({ tag: 'modkeep', published: true });
    await admins.moderator.agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, 'modkeep'));
    expect((await entryRow(id)).published).toBe(true);
    expect(lines).toEqual([]);
  });

  it('still saves everything else', async () => {
    const id = await createEntry({ tag: 'modfields' });
    await admins.moderator.agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, 'modfields', { meaning_vi: 'moderator sửa', cefr_level: 'B2', published: 'true' }));
    const row = (await pool.query(`SELECT meaning_vi, cefr_level, published FROM dictionary_entries WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ meaning_vi: 'moderator sửa', cefr_level: 'B2', published: false });
  });

  it('is shown the box disabled, with the reason; the two roles that may publish get it enabled', async () => {
    const id = await createEntry({ tag: 'modview' });
    const mod = await admins.moderator.agent.get(`/dictionary/${id}/edit`);
    expect(mod.status).toBe(200);
    expect(mod.text).toMatch(/name="published" value="true"[^>]*disabled/);
    expect(mod.text).toContain('Chỉ super_admin và content_editor đổi được trạng thái xuất bản');
    for (const role of ['super_admin', 'content_editor'] as Role[]) {
      const page = await admins[role].agent.get(`/dictionary/${id}/edit`);
      expect(page.text).toMatch(/name="published" value="true"/);
      expect(page.text).not.toMatch(/name="published" value="true"[^>]*disabled/);
      expect(page.text).not.toContain('Chỉ super_admin và content_editor đổi được');
    }
  });

  it('super_admin and content_editor still change it (and are not logged as refused)', async () => {
    for (const role of ['super_admin', 'content_editor'] as Role[]) {
      const id = await createEntry({ tag: `pub${role.replace('_', '')}` });
      await admins[role].agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, `pub${role.replace('_', '')}`, { published: 'true' }));
      expect((await entryRow(id)).published).toBe(true);
      expect(await history(id)).toEqual([{ old_value: 'false', new_value: 'true', admin_id: admins[role].id }]);
    }
    expect(lines).toEqual([]);
  });
});

// ── P9: the "Published" box of the form that CREATES an entry ────────────────────────────────────────────────────────────────
describe('creating an entry', () => {
  const create = (role: Role, tag: string, extra: Record<string, unknown> = {}) =>
    admins[role].agent.post('/dictionary/create').type('form').send({ headword: fixtureWord(tag), lemma: fixtureWord(tag), meaning_vi: 'nghĩa thử', source: 'manual', pos: ['noun'], ...extra });
  const created = async (tag: string) => (await pool.query(`SELECT id, published FROM dictionary_entries WHERE headword = $1`, [fixtureWord(tag)])).rows[0];

  it('with the box ticked the entry is public', async () => {
    const res = await create('super_admin', 'crtick', { published: 'true' });
    expect(res.status).toBe(302);
    const row = await created('crtick');
    expect(res.headers.location).toBe(`/dictionary/${row.id}`);
    expect(row.published).toBe(true);
  });

  it('with the box NOT ticked the entry is hidden (an unticked box sends no field; absent used to count as public)', async () => {
    const res = await create('super_admin', 'crnone');
    expect(res.status).toBe(302);
    expect((await created('crnone')).published).toBe(false);
  });

  it('"false" and "on" mean what they say', async () => {
    await create('super_admin', 'crfalse', { published: 'false' });
    await create('super_admin', 'cron', { published: 'on' });
    expect((await created('crfalse')).published).toBe(false);
    expect((await created('cron')).published).toBe(true);
  });

  it('the page offers the box ticked, so the usual way of creating an entry still publishes it', async () => {
    const page = await admins.super_admin.agent.get('/dictionary/create');
    expect(page.text).toMatch(/name="published" value="true" checked/);
  });
});

// ── P8c: the same rule for the form that CREATES an entry ────────────────────────────────────────────────────────────────
describe('a moderator creating an entry (POST /dictionary/create follows the same rule as the editor)', () => {
  let lines: any[] = [];
  beforeEach(() => {
    lines = [];
    spies.splice(0).forEach((s) => s.mockRestore());
    for (const level of ['info', 'warn', 'error', 'log'] as const) {
      spies.push(
        jest.spyOn(console, level).mockImplementation((line: unknown) => {
          try {
            const parsed = JSON.parse(String(line));
            if (parsed.evt === 'admin_action') lines.push(parsed);
          } catch {
            /* not a JSON line */
          }
        })
      );
    }
  });

  const create = (role: Role, tag: string, extra: Record<string, unknown> = {}) =>
    admins[role].agent.post('/dictionary/create').type('form').send({ headword: fixtureWord(tag), lemma: fixtureWord(tag), meaning_vi: 'nghĩa thử', source: 'manual', pos: ['noun'], ...extra });
  const created = async (tag: string) => (await pool.query(`SELECT id, published, created_by, meaning_vi FROM dictionary_entries WHERE headword = $1`, [fixtureWord(tag)])).rows[0];

  it.each([
    ['published=true (the box ticked)', { published: 'true' }],
    ['published=on', { published: 'on' }],
  ])('creates it HIDDEN whatever the box says (%s), and logs the try as forbidden', async (_name, extra) => {
    const tag = `modcr${_name.replace(/[^a-z]/g, '')}`;
    const res = await create('moderator', tag, extra);
    expect(res.status).toBe(302);
    const row = await created(tag);
    expect(res.headers.location).toBe(`/dictionary/${row.id}`);
    expect(row.published).toBe(false);
    expect(lines).toEqual([
      expect.objectContaining({ evt: 'admin_action', admin_id: admins.moderator.id, action: 'dictionary.create.published', target_type: 'entry', target_id: row.id, result: 'forbidden', requested: true, kept: false }),
    ]);
  });

  it('with the box unticked (no field) or published=false the entry is hidden and nothing is logged: there was nothing to refuse', async () => {
    await create('moderator', 'modcrnone');
    await create('moderator', 'modcrfalse', { published: 'false' });
    expect((await created('modcrnone')).published).toBe(false);
    expect((await created('modcrfalse')).published).toBe(false);
    expect(lines).toEqual([]);
  });

  it('still saves everything else, and the entry is the moderator\'s', async () => {
    await create('moderator', 'modcrfields', { published: 'true', meaning_vi: 'moderator tạo', cefr_level: 'B1', admin_note: 'ghi chú' });
    const row = (await pool.query(`SELECT meaning_vi, cefr_level, admin_note, created_by FROM dictionary_entries WHERE headword = $1`, [fixtureWord('modcrfields')])).rows[0];
    expect(row).toEqual({ meaning_vi: 'moderator tạo', cefr_level: 'B1', admin_note: 'ghi chú', created_by: admins.moderator.id });
  });

  it('is told so after saving (the entry is hidden until super_admin or content_editor publishes it)', async () => {
    const res = await create('moderator', 'modcrflash', { published: 'true' });
    const next = await admins.moderator.agent.get(res.headers.location);
    expect(next.text).toContain('hidden: only super_admin and content_editor can publish it');
  });

  it('is shown the box disabled and unticked, with the reason; super_admin still gets it ticked and enabled', async () => {
    const mod = await admins.moderator.agent.get('/dictionary/create');
    expect(mod.status).toBe(200);
    expect(mod.text).toMatch(/name="published" value="true"[^>]*disabled/);
    expect(mod.text).not.toMatch(/name="published" value="true"[^>]*checked/);
    expect(mod.text).toContain('Chỉ super_admin và content_editor xuất bản được');
    const sa = await admins.super_admin.agent.get('/dictionary/create');
    expect(sa.text).toMatch(/name="published" value="true" checked/);
    expect(sa.text).not.toMatch(/name="published" value="true"[^>]*disabled/);
  });

  it('super_admin is not affected: ticked → public, nothing logged', async () => {
    await create('super_admin', 'sacrpub', { published: 'true' });
    await create('super_admin', 'sacrhid');
    expect((await created('sacrpub')).published).toBe(true);
    expect((await created('sacrhid')).published).toBe(false);
    expect(lines).toEqual([]);
  });

  it('content_editor cannot create at all (the route is for super_admin and moderator), so there is no way around the rule through it', async () => {
    const res = await create('content_editor', 'cecr', { published: 'true' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    expect(await created('cecr')).toBeUndefined();
  });
});

describe('parts of speech', () => {
  it('draws a box for a part of speech the entry has but the fixed list does not, ticked', async () => {
    const id = await createEntry({ tag: 'edpos', pos: ['noun', 'exclamation', 'modal verb'] });
    const res = await admins.content_editor.agent.get(`/dictionary/${id}/edit`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/name="pos" value="exclamation" checked/);
    expect(res.text).toMatch(/name="pos" value="modal verb" checked/);
    expect(res.text).toMatch(/name="pos" value="noun" checked/);
    expect(res.text).not.toMatch(/name="pos" value="adverb" checked/);
  });

  it('keeps them when the form is saved as the page drew it', async () => {
    const id = await createEntry({ tag: 'edposkeep', pos: ['noun', 'exclamation'] });
    await admins.content_editor.agent.post(`/dictionary/${id}/edit`).type('form').send(form(id, 'edposkeep', { pos: ['noun', 'exclamation'] }));
    expect((await entryRow(id)).pos).toEqual(['noun', 'exclamation']);
  });
});
