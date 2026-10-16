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
