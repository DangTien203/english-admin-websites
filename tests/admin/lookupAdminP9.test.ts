/**
 * P9 on the lookup / enrichment admin: (1) the bulk publish takes entries whose notes of Haiku are all LIGHT, (2) the Vietnamese of
 * a single sense can be edited, with its trace in entry_edit_history, (3) the pages carry the confirmation box and the edit forms.
 * Real Express app and real PostgreSQL (the dev database); nothing touches the network or the queue.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../app';
import pool from '../../config/db';
import { getLookupAdminService } from '../../services/lookup/adminService';
import { NOTE_CLEAN, RUN, cleanup, createAdmins, createEntry, fixtureWord, type AdminFixture, type Role } from '../helpers/lookupAdminFixtures';

const API = '/lookup/api';
const HOST = 'admin.test';
let admins: Record<Role, AdminFixture>;

const withNotes = (notes: string[]) => `${NOTE_CLEAN} · ghi chú của Haiku: ${notes.join(' | ')}`;
const LIGHT = ['Mức CEFR C1 ước tính từ tần suất thấp (zipf 3.56); cần xem lại.', "Nghĩa 'đất sét bùn' rất hiếm và chuyên ngành nên không đưa vào."];
const BLOCKING = "Nghĩa 'phố' và 'dãy nhà' có thể gộp, cần kiểm tra lại.";

// every admin_action line of the test is collected; the rest of the logging is kept off the output
let lines: any[] = [];
let spies: jest.SpyInstance[] = [];

beforeAll(async () => {
  admins = await createAdmins(app);
});
beforeEach(() => {
  lines = [];
  spies = (['info', 'warn', 'error', 'log'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation((line: unknown) => {
      try {
        const parsed = JSON.parse(String(line));
        if (parsed.evt === 'admin_action') lines.push(parsed);
      } catch {
        /* not a JSON line */
      }
    })
  );
});
afterEach(() => spies.forEach((s) => s.mockRestore()));
afterAll(async () => {
  await cleanup();
  await pool.end();
});

/** i → letters only (headwords of the fixtures are letters: the word cleaner rejects digits) */
const letters = (i: number): string => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

const entryRow = async (id: string) => (await pool.query(`SELECT published, updated_at FROM dictionary_entries WHERE id = $1`, [id])).rows[0];
const senseOf = async (entryId: string, index = 0) => (await pool.query(`SELECT id, definition_vi FROM entry_senses WHERE entry_id = $1 ORDER BY sense_order OFFSET $2 LIMIT 1`, [entryId, index])).rows[0];
const examplesOf = async (senseId: string) => (await pool.query(`SELECT id, example_en, example_vi FROM sense_examples WHERE sense_id = $1 ORDER BY sort_order, id`, [senseId])).rows;
const historyOf = async (entryId: string) =>
  (await pool.query(`SELECT field_name, old_value, new_value, admin_id FROM entry_edit_history WHERE entry_id = $1 ORDER BY created_at, id`, [entryId])).rows;

// ═════════════════════════════════════════════════════════════════════════════
describe('which notes of Haiku hold an entry back from the bulk publish', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ids.none = await createEntry({ tag: 'p9none' });
    ids.light = await createEntry({ tag: 'p9light', adminNote: withNotes(LIGHT) });
    ids.blocking = await createEntry({ tag: 'p9block', adminNote: withNotes([BLOCKING]) });
    ids.mixed = await createEntry({ tag: 'p9mixed', adminNote: withNotes([...LIGHT, BLOCKING]) });
    ids.unknown = await createEntry({ tag: 'p9unknown', adminNote: withNotes(['Một ghi chú chưa ai từng thấy.']) });
  });

  const list = async () => {
    const res = await admins.moderator.agent.get(`${API}/auto-entries?status=all&q=qzq${RUN}p9`);
    expect(res.status).toBe(200);
    return Object.fromEntries((res.body.data.items as any[]).map((i) => [i.headword, i]));
  };

  it('the list counts all the notes and the blocking ones, and marks what a bulk publish would take', async () => {
    const items = await list();
    const of = (tag: string) => items[fixtureWord(tag)];
    expect(of('p9none')).toMatchObject({ review_note_count: 0, blocking_note_count: 0, eligible_for_bulk_publish: true });
    expect(of('p9light')).toMatchObject({ review_note_count: 2, blocking_note_count: 0, eligible_for_bulk_publish: true });
    expect(of('p9block')).toMatchObject({ review_note_count: 1, blocking_note_count: 1, eligible_for_bulk_publish: false });
    expect(of('p9mixed')).toMatchObject({ review_note_count: 3, blocking_note_count: 1, eligible_for_bulk_publish: false });
    expect(of('p9unknown')).toMatchObject({ review_note_count: 1, blocking_note_count: 1, eligible_for_bulk_publish: false });
  });

  it('the detail gives each note with its category and whether it blocks, and the same verdict on the entry', async () => {
    const res = await admins.moderator.agent.get(`${API}/auto-entries/${ids.mixed}`);
    const d = res.body.data;
    expect(d.eligible_for_bulk_publish).toBe(false);
    expect(d.blocking_note_count).toBe(1);
    expect(d.note.review_notes).toHaveLength(3); // the plain list is still there
    expect(d.note.review_notes_classified.map((n: any) => [n.category, n.blocks])).toEqual([
      ['cefr_estimate', false],
      ['omitted_sense', false],
      ['meaning_doubt', true],
    ]);
    expect(d.note.review_notes_classified[2]).toMatchObject({ text: BLOCKING, label: 'Nghi ngờ nghĩa' });

    const light = (await admins.moderator.agent.get(`${API}/auto-entries/${ids.light}`)).body.data;
    expect(light).toMatchObject({ eligible_for_bulk_publish: true, blocking_note_count: 0 });
    expect(light.note.review_notes_classified.every((n: any) => !n.blocks)).toBe(true);
  });

  it('publishes the entries with no notes or only light notes, and skips the others with the blocking note named', async () => {
    const res = await admins.content_editor.agent.post(`${API}/auto-entries/bulk-publish`).send({ entry_ids: [ids.none, ids.light, ids.blocking, ids.mixed, ids.unknown] });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.published.map((p: any) => p.id).sort()).toEqual([ids.none, ids.light].sort());
    const skipped = Object.fromEntries(d.skipped.map((s: any) => [s.id, s]));
    expect(skipped[ids.blocking]).toMatchObject({ reason: 'has_review_notes', blocking_notes: [{ category: 'meaning_doubt', text: BLOCKING, label: 'Nghi ngờ nghĩa' }] });
    expect(skipped[ids.mixed].blocking_notes).toHaveLength(1); // the light ones are not listed as the reason
    expect(skipped[ids.unknown]).toMatchObject({ reason: 'has_review_notes' });

    for (const id of [ids.none, ids.light]) {
      expect((await entryRow(id)).published).toBe(true);
      expect(await historyOf(id)).toEqual([{ field_name: 'published', old_value: 'false', new_value: 'true', admin_id: admins.content_editor.id }]);
    }
    for (const id of [ids.blocking, ids.mixed, ids.unknown]) {
      expect((await entryRow(id)).published).toBe(false);
      expect(await historyOf(id)).toHaveLength(0);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /lookup/api/auto-entries/:id/senses/:senseId', () => {
  /** A fresh entry with one sense (definition_vi "cái; vật") and one example with a translation. */
  async function fresh(tag: string, over: Partial<Parameters<typeof createEntry>[0]> = {}) {
    const entryId = await createEntry({
      tag,
      senses: [{ pos: 'noun', definition_en: 'a thing', definition_vi: 'cái; vật', examples: [['This is a test thing.', 'Đây là một vật thử.']] }],
      ...over,
    });
    const sense = await senseOf(entryId);
    const examples = await examplesOf(sense.id);
    return { entryId, senseId: sense.id as string, exampleId: examples[0]?.id as string, before: await entryRow(entryId) };
  }
  const patch = (role: Role, entryId: string, senseId: string, body: unknown) => admins[role].agent.patch(`${API}/auto-entries/${entryId}/senses/${senseId}`).send(body as object);

  it('edits the meanings: stored cleaned, answered with the flagged meanings, the entry marked as touched', async () => {
    const e = await fresh('p9edit');
    await new Promise((r) => setTimeout(r, 20));
    const res = await patch('super_admin', e.entryId, e.senseId, { definition_vi: '  nốt ruồi ;; chắt   rượu ; Nốt ruồi ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ entry_id: e.entryId, sense_id: e.senseId, changed: true, changes: [{ field: 'definition_vi' }], definition_vi: 'nốt ruồi; chắt rượu' });
    expect(res.body.data.meanings_vi.map((m: any) => m.text)).toEqual(['nốt ruồi', 'chắt rượu']);
    expect(res.body.data.examples).toEqual([expect.objectContaining({ id: e.exampleId, example_vi: 'Đây là một vật thử.' })]);

    expect((await senseOf(e.entryId)).definition_vi).toBe('nốt ruồi; chắt rượu');
    expect(new Date((await entryRow(e.entryId)).updated_at).getTime()).toBeGreaterThan(new Date(e.before.updated_at).getTime());
  });

  it('writes entry_edit_history: the field names the sense, the old and the new text, and the admin who saved it', async () => {
    const e = await fresh('p9hist');
    await patch('content_editor', e.entryId, e.senseId, { definition_vi: 'bản sửa' });
    expect(await historyOf(e.entryId)).toEqual([{ field_name: `sense:${e.senseId}:definition_vi`, old_value: 'cái; vật', new_value: 'bản sửa', admin_id: admins.content_editor.id }]);
    // and the next edit is another line: the history keeps every step
    await patch('super_admin', e.entryId, e.senseId, { definition_vi: 'bản sửa lần hai' });
    expect((await historyOf(e.entryId)).map((h) => [h.old_value, h.new_value, h.admin_id])).toEqual([
      ['cái; vật', 'bản sửa', admins.content_editor.id],
      ['bản sửa', 'bản sửa lần hai', admins.super_admin.id],
    ]);
  });

  it('edits the translation of an example too, with its own history line, in one request with the meanings', async () => {
    const e = await fresh('p9ex');
    const res = await patch('content_editor', e.entryId, e.senseId, { definition_vi: 'nghĩa mới', examples: [{ id: e.exampleId, example_vi: '  Đây là   một vật thử nghiệm. ' }] });
    expect(res.status).toBe(200);
    expect(res.body.data.changes).toEqual([{ field: 'definition_vi' }, { field: 'example_vi', example_id: e.exampleId }]);
    expect((await examplesOf(e.senseId))[0].example_vi).toBe('Đây là một vật thử nghiệm.');
    const history = await historyOf(e.entryId);
    expect(history.map((h) => h.field_name).sort()).toEqual([`sense:${e.senseId}:definition_vi`, `sense:${e.senseId}:example_vi:${e.exampleId}`].sort());
    expect(history.find((h) => h.field_name.includes('example_vi'))).toMatchObject({ old_value: 'Đây là một vật thử.', new_value: 'Đây là một vật thử nghiệm.', admin_id: admins.content_editor.id });
    // the English sentence is never touched
    expect((await examplesOf(e.senseId))[0].example_en).toBe('This is a test thing.');
  });

  it('may edit the example alone', async () => {
    const e = await fresh('p9exonly');
    const res = await patch('super_admin', e.entryId, e.senseId, { examples: [{ id: e.exampleId, example_vi: 'Chỉ sửa ví dụ.' }] });
    expect(res.body.data.changes).toEqual([{ field: 'example_vi', example_id: e.exampleId }]);
    expect((await senseOf(e.entryId)).definition_vi).toBe('cái; vật');
  });

  it('sending what is stored already changes nothing and writes no history', async () => {
    const e = await fresh('p9noop');
    const res = await patch('content_editor', e.entryId, e.senseId, { definition_vi: ' cái ;  vật ', examples: [{ id: e.exampleId, example_vi: 'Đây là một vật thử.' }] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ changed: false, changes: [] });
    expect(await historyOf(e.entryId)).toHaveLength(0);
    expect(new Date((await entryRow(e.entryId)).updated_at).getTime()).toBe(new Date(e.before.updated_at).getTime());
  });

  it('works on a published entry too, and leaves it published', async () => {
    const e = await fresh('p9pub', { published: true });
    const res = await patch('content_editor', e.entryId, e.senseId, { definition_vi: 'đã xuất bản, đã sửa' });
    expect(res.status).toBe(200);
    expect((await entryRow(e.entryId)).published).toBe(true);
    expect((await historyOf(e.entryId)).map((h) => h.field_name)).toEqual([`sense:${e.senseId}:definition_vi`]); // no 'published' line
  });

  it('a moderator gets 403 FORBIDDEN, nothing changes, and the attempt is logged', async () => {
    const e = await fresh('p9mod');
    const res = await patch('moderator', e.entryId, e.senseId, { definition_vi: 'không được' });
    expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN']);
    expect((await senseOf(e.entryId)).definition_vi).toBe('cái; vật');
    expect(await historyOf(e.entryId)).toHaveLength(0);
    expect(lines).toEqual([expect.objectContaining({ admin_id: admins.moderator.id, result: 'forbidden', action: expect.stringContaining('/senses/:senseId') })]);
  });

  it('without a session it is 401 in JSON', async () => {
    const e = await fresh('p9anon');
    const res = await request(app).patch(`${API}/auto-entries/${e.entryId}/senses/${e.senseId}`).send({ definition_vi: 'x' });
    expect([res.status, res.body.error.code]).toEqual([401, 'UNAUTHORIZED']);
    expect((await senseOf(e.entryId)).definition_vi).toBe('cái; vật');
  });

  describe('checks the input and changes nothing when it is wrong', () => {
    const long = (n: number) => 'a'.repeat(n);
    const tooMany = Array.from({ length: 9 }, (_, i) => `nghĩa ${i}`).join('; ');
    let counter = 0;
    const tooLongInAll = Array.from({ length: 4 }, (_, i) => String.fromCharCode(97 + i).repeat(90)).join('; ');

    it.each<[string, (ids: { exampleId: string }) => unknown]>([
      ['an empty body', () => ({})],
      ['a body that is not an object', () => [1, 2]],
      ['an unknown field', () => ({ definition_vi: 'x', definition_en: 'no' })],
      ['an empty meaning', () => ({ definition_vi: '' })],
      ['only separators', () => ({ definition_vi: ' ; ; ' })],
      ['a number', () => ({ definition_vi: 5 })],
      ['markup', () => ({ definition_vi: 'chạy <b>nhanh</b>' })],
      ['a meaning over 100 characters', () => ({ definition_vi: `ngắn; ${long(101)}` })],
      ['more than 8 meanings', () => ({ definition_vi: tooMany })],
      ['more than 300 characters in all', () => ({ definition_vi: tooLongInAll })],
      ['an empty examples list', () => ({ examples: [] })],
      ['examples that are not a list', () => ({ examples: 'x' })],
      ['an example without an id', () => ({ examples: [{ example_vi: 'x' }] })],
      ['an example id that is not a uuid', () => ({ examples: [{ id: 'abc', example_vi: 'x' }] })],
      ['an empty example translation', ({ exampleId }) => ({ examples: [{ id: exampleId, example_vi: '   ' }] })],
      ['an example translation with markup', ({ exampleId }) => ({ examples: [{ id: exampleId, example_vi: '<img src=x>' }] })],
      ['an example translation over 500 characters', ({ exampleId }) => ({ examples: [{ id: exampleId, example_vi: long(501) }] })],
      ['the same example twice', ({ exampleId }) => ({ examples: [{ id: exampleId, example_vi: 'a' }, { id: exampleId.toUpperCase(), example_vi: 'b' }] })],
    ])('refuses %s with 400 VALIDATION_ERROR', async (_name, body) => {
      const e = await fresh(`p9val${letters(counter++)}`);
      const res = await patch('content_editor', e.entryId, e.senseId, body({ exampleId: e.exampleId }));
      expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
      expect((await senseOf(e.entryId)).definition_vi).toBe('cái; vật');
      expect((await examplesOf(e.senseId))[0].example_vi).toBe('Đây là một vật thử.');
      expect(await historyOf(e.entryId)).toHaveLength(0);
    });

    it('a good meaning is not saved when the example next to it is wrong (all or nothing)', async () => {
      const e = await fresh('p9allnone');
      const res = await patch('content_editor', e.entryId, e.senseId, { definition_vi: 'đúng', examples: [{ id: e.exampleId, example_vi: '' }] });
      expect(res.status).toBe(400);
      expect((await senseOf(e.entryId)).definition_vi).toBe('cái; vật');
    });
  });

  describe('404 when the target is not what the URL says', () => {
    it('an unknown entry, an unknown sense, and ids that are not ids', async () => {
      const e = await fresh('p9nf');
      const body = { definition_vi: 'x' };
      for (const [entry, sense] of [[randomUUID(), e.senseId], [e.entryId, randomUUID()], ['abc', e.senseId], [e.entryId, 'abc']]) {
        const res = await patch('content_editor', entry, sense, body);
        expect([entry === e.entryId ? 'sense' : 'entry', res.status, res.body.error.code]).toEqual([entry === e.entryId ? 'sense' : 'entry', 404, 'NOT_FOUND']);
      }
    });

    it('an entry that was not made by the job: this is not a general editor', async () => {
      const e = await fresh('p9manual', { adminNote: 'nhập tay' });
      const res = await patch('content_editor', e.entryId, e.senseId, { definition_vi: 'x' });
      expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
      expect((await senseOf(e.entryId)).definition_vi).toBe('cái; vật');
    });

    it('a sense of ANOTHER entry (the ids do not match)', async () => {
      const a = await fresh('p9other1');
      const b = await fresh('p9other2');
      const res = await patch('content_editor', a.entryId, b.senseId, { definition_vi: 'lén sửa' });
      expect(res.status).toBe(404);
      expect((await senseOf(b.entryId)).definition_vi).toBe('cái; vật');
    });

    it('an example of another sense, and nothing of the request is saved', async () => {
      const a = await fresh('p9exa');
      const b = await fresh('p9exb');
      const res = await patch('content_editor', a.entryId, a.senseId, { definition_vi: 'không được lưu', examples: [{ id: b.exampleId, example_vi: 'lén sửa' }] });
      expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
      expect(res.body.error.details).toEqual({ example_ids: [b.exampleId] });
      expect((await senseOf(a.entryId)).definition_vi).toBe('cái; vật');
      expect((await examplesOf(b.senseId))[0].example_vi).toBe('Đây là một vật thử.');
    });
  });

  it('the text and its history line are ONE transaction: if the history cannot be written, the text is not changed', async () => {
    const e = await fresh('p9atomic');
    await expect(getLookupAdminService().editSense(e.entryId, e.senseId, { definition_vi: 'không được lưu' }, randomUUID())).rejects.toMatchObject({ code: '23503' });
    expect((await senseOf(e.entryId)).definition_vi).toBe('cái; vật');
  });

  it('logs who did what to which entry, with counts, and never the text', async () => {
    const e = await fresh('p9log');
    await patch('content_editor', e.entryId, e.senseId, { definition_vi: 'bí mật riêng tư' });
    await patch('content_editor', e.entryId, e.senseId, { definition_vi: '' });
    expect(lines).toEqual([
      expect.objectContaining({ admin_id: admins.content_editor.id, action: 'entry.edit_sense', target_type: 'entry', target_id: e.entryId, result: 'ok', changed: true, fields: 1 }),
      expect.objectContaining({ action: 'entry.edit_sense', result: 'rejected:VALIDATION_ERROR' }),
    ]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('bí mật');
    expect(text).not.toContain('@example.com');
  });

  describe('behind the Origin / Referer check (middlewares/sameOrigin.ts)', () => {
    const send = (e: { entryId: string; senseId: string }, headers: Record<string, string>) =>
      admins.content_editor.agent.patch(`${API}/auto-entries/${e.entryId}/senses/${e.senseId}`).set('Host', HOST).set(headers).send({ definition_vi: 'từ trang khác' });

    it('refuses a request that names another site, in JSON, and changes nothing', async () => {
      const e = await fresh('p9csrf');
      for (const headers of [{ Origin: 'http://evil.example' }, { Referer: 'http://evil.example/page' }, { Origin: 'null' }]) {
        const res = await send(e, headers);
        expect([JSON.stringify(headers), res.status, res.body.error?.code]).toEqual([JSON.stringify(headers), 403, 'FORBIDDEN']);
      }
      expect((await senseOf(e.entryId)).definition_vi).toBe('cái; vật');
      expect(await historyOf(e.entryId)).toHaveLength(0);
    });

    it('lets through this site\'s own Origin, and a request that names no origin', async () => {
      const e = await fresh('p9own');
      expect((await send(e, { Origin: `http://${HOST}` })).status).toBe(200);
      expect((await send(e, {})).status).toBe(200);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the pages', () => {
  let eligibleId: string;
  let blockedId: string;
  let senseId: string;
  let exampleId: string;

  beforeAll(async () => {
    eligibleId = await createEntry({ tag: 'p9pageok', adminNote: withNotes(LIGHT) });
    blockedId = await createEntry({ tag: 'p9pageblock', adminNote: withNotes([BLOCKING]) });
    senseId = (await senseOf(eligibleId)).id;
    exampleId = (await examplesOf(senseId))[0].id;
  });

  const review = (role: Role) => admins[role].agent.get(`/lookup/review?status=all&q=qzq${RUN}p9page`);
  const detail = (role: Role, id: string) => admins[role].agent.get(`/lookup/review/${id}/detail`);

  it('shows a writer the confirmation box (a <dialog> with a Hủy and a Xuất bản button) and loads the helper before the page script', async () => {
    const res = await review('content_editor');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<dialog id="lk-bulk-dialog"');
    expect(res.text).toMatch(/<form method="dialog">/);
    expect(res.text).toMatch(/value="cancel"[^>]*>Hủy</);
    expect(res.text).toMatch(/value="confirm"[^>]*>Xuất bản</);
    expect(res.text).toMatch(/id="lk-bulk-sample"/);
    expect(res.text.indexOf('/js/lookup-bulk-confirm.js')).toBeGreaterThan(-1);
    expect(res.text.indexOf('/js/lookup-bulk-confirm.js')).toBeLessThan(res.text.indexOf('/js/lookup-admin.js'));
  });

  it('gives the box what it needs to name the entries: the headword on every checkbox, only on the entries a bulk publish takes', async () => {
    const res = await review('super_admin');
    expect(res.text).toContain(`value="${eligibleId}" data-headword="${fixtureWord('p9pageok')}"`);
    expect(res.text).not.toContain(`value="${blockedId}"`);
    expect(res.text).toContain('1 cần xem'); // the blocking note of the other entry
    expect(res.text).toContain('2 lưu ý nhẹ'); // the two light notes of the eligible one
  });

  it('a moderator gets neither the box nor any checkbox', async () => {
    const res = await review('moderator');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('lk-bulk-dialog');
    expect(res.text).not.toContain('lookup-bulk-confirm.js');
    expect(res.text).not.toContain('class="lk-select"');
  });

  it('serves the helper script', async () => {
    const res = await request(app).get('/js/lookup-bulk-confirm.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('describeSelection');
  });

  it('the detail splits the notes: the ones to read first, and the light ones apart', async () => {
    const mixed = await createEntry({ tag: 'p9pagemixed', adminNote: withNotes([...LIGHT, BLOCKING]) });
    const res = await detail('content_editor', mixed);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Cần xem trước khi xuất bản (1)');
    expect(res.text).toContain('Nghi ngờ nghĩa');
    expect(res.text).toContain('Lưu ý nhẹ của Haiku (2)');
    expect(res.text).toContain('CEFR ước tính');
    expect(res.text).toContain('Chưa đủ điều kiện xuất bản hàng loạt');

    const light = await detail('content_editor', eligibleId);
    expect(light.text).not.toContain('Cần xem trước khi xuất bản');
    expect(light.text).toContain('Đủ điều kiện xuất bản hàng loạt');
    expect(light.text).toContain(LIGHT[0]); // light notes are still shown
  });

  it('shows a writer the edit form of each sense: the meanings, and the translation of each example with its id', async () => {
    const res = await detail('content_editor', eligibleId);
    expect(res.text).toContain(`data-lk-edit-sense="${senseId}"`);
    expect(res.text).toContain(`data-lk-sense-form="${senseId}"`);
    expect(res.text).toMatch(/<textarea[^>]*name="definition_vi"[^>]*maxlength="300"/);
    expect(res.text).toContain(`data-example-id="${exampleId}"`);
    expect(res.text).toContain('value="Đây là một vật thử."');
    expect(res.text).toContain(`data-entry-id="${eligibleId}"`);
  });

  it('shows a moderator the sense and the notes but no edit control', async () => {
    const res = await detail('moderator', eligibleId);
    expect(res.status).toBe(200);
    expect(res.text).toContain('cái dùng để thử');
    expect(res.text).toContain('Lưu ý nhẹ của Haiku (2)');
    expect(res.text).not.toContain('data-lk-edit-sense');
    expect(res.text).not.toContain('lk-sense-form');
  });

  it('draws the edit in the history in words', async () => {
    const id = await createEntry({ tag: 'p9pagehist' });
    const sense = await senseOf(id);
    await admins.content_editor.agent.patch(`${API}/auto-entries/${id}/senses/${sense.id}`).send({ definition_vi: 'đã sửa' });
    const res = await detail('content_editor', id);
    expect(res.text).toContain(`nghĩa tiếng Việt của sense …${sense.id.slice(0, 8)}`);
    expect(res.text).toContain('P8 content_editor'); // the name of the admin who saved it
  });
});
