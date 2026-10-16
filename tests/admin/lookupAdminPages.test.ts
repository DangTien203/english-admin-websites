/**
 * The three HTML pages of the lookup / enrichment admin (P8) rendered by the real app for each role: what is drawn, what is left
 * out for a moderator, that user text is escaped. Real Express app and PostgreSQL (the dev database); no network.
 */
import request from 'supertest';
import app from '../../app';
import pool from '../../config/db';
import {
  NOTE_WITH_REVIEW,
  RUN,
  cleanup,
  createAdmins,
  createEntry,
  createJob,
  createLookups,
  fixtureWord,
  type AdminFixture,
  type Role,
} from '../helpers/lookupAdminFixtures';

let admins: Record<Role, AdminFixture>;
let pending: string;
let flagged: string;
let published: string;
let failedJob: string;
const spies: jest.SpyInstance[] = [];

beforeAll(async () => {
  admins = await createAdmins(app);
  pending = await createEntry({ tag: 'pgclean' });
  flagged = await createEntry({
    tag: 'pgflag',
    adminNote: NOTE_WITH_REVIEW,
    meaningVi: 'nốt ruồi; chắt rượu',
    senses: [
      {
        pos: 'noun',
        definition_en: 'a <b>small</b> spot',
        definition_vi: 'nốt ruồi; chắt rượu; một nghĩa dài dòng bất thường vượt giới hạn cho phép của người viết; <img src=x onerror=alert(1)>',
        examples: [['She has a mole.', 'Cô ấy có một nốt ruồi.']],
      },
    ],
  });
  published = await createEntry({ tag: 'pgpub', published: true });
  failedJob = await createJob({ tag: 'pgfail', status: 'failed', reason: 'upstream_error', attempts: 4 });
  await createJob({ tag: 'pgdone', status: 'succeeded', entryId: pending });
  await createJob({ tag: 'pgbad', status: 'failed', reason: 'invalid_output' });
  await createLookups({ wordText: fixtureWord('pgmissing'), result: 'translation', count: 3 });
  await createLookups({ wordText: fixtureWord('pgqueued'), result: 'not_found', count: 2 });
  await createJob({ tag: 'pgqueued', status: 'queued' });
});

beforeEach(() => {
  for (const level of ['info', 'warn', 'error', 'log'] as const) spies.push(jest.spyOn(console, level).mockImplementation(() => undefined));
});
afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

afterAll(async () => {
  await cleanup();
  await pool.end();
});

const get = (role: Role, url: string) => admins[role].agent.get(url);
const ALL: Role[] = ['super_admin', 'content_editor', 'moderator'];
const WRITERS: Role[] = ['super_admin', 'content_editor'];

describe('access', () => {
  it('sends a visitor without a session to the login page', async () => {
    for (const url of ['/lookup', '/lookup/jobs', '/lookup/review', '/lookup/health', `/lookup/review/${pending}/detail`]) {
      const res = await request(app).get(url);
      expect([url, res.status, res.headers.location]).toEqual([url, 302, '/auth/login']);
    }
  });

  it('/lookup goes to the queue page', async () => {
    const res = await get('moderator', '/lookup');
    expect([res.status, res.headers.location]).toEqual([302, '/lookup/jobs']);
  });

  it.each(ALL)('%s opens all three pages', async (role) => {
    for (const url of ['/lookup/jobs', '/lookup/review', '/lookup/health']) {
      const res = await get(role, url);
      expect([url, res.status]).toEqual([url, 200]);
      expect(res.text).toContain('class="lk-tab');
    }
  });

  it('the sidebar has the entry, with the three sub-pages once inside', async () => {
    const res = await get('content_editor', '/lookup/jobs');
    expect(res.text).toContain('href="/lookup"');
    expect(res.text).toContain('Tra từ &amp; làm giàu');
    for (const href of ['/lookup/jobs', '/lookup/review', '/lookup/health']) expect(res.text).toContain(`href="${href}"`);
    const elsewhere = await get('content_editor', '/dashboard');
    expect(elsewhere.text).toContain('href="/lookup"');
  });

  it('serves the script of the pages', async () => {
    const res = await request(app).get('/js/lookup-admin.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/lookup/api');
  });
});

describe('queue page /lookup/jobs', () => {
  it.each(WRITERS)('%s sees the form to add words and the retry button of a retryable job', async (role) => {
    const res = await get(role, `/lookup/jobs?q=qzq${RUN}pg`);
    expect(res.text).toContain('id="lk-add-words"');
    expect(res.text).toContain('tối đa 50');
    expect(res.text).toContain(`data-lk-retry="${failedJob}"`);
    // only the job that may be retried has the button: failed / upstream_error, not failed / invalid_output
    expect((res.text.match(/data-lk-retry=/g) ?? []).length).toBe(1);
  });

  it('a moderator sees the same table and none of the write controls', async () => {
    const res = await get('moderator', `/lookup/jobs?q=qzq${RUN}pg`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(fixtureWord('pgfail'));
    expect(res.text).not.toContain('id="lk-add-words"');
    expect(res.text).not.toContain('data-lk-retry');
    expect(res.text).toContain('chỉ có quyền xem');
  });

  it('filters, links to the entry and says the state in Vietnamese', async () => {
    const res = await get('super_admin', `/lookup/jobs?q=qzq${RUN}pg&status=succeeded`);
    expect(res.text).toContain(fixtureWord('pgdone'));
    expect(res.text).not.toContain(fixtureWord('pgfail'));
    expect(res.text).toContain(`href="/lookup/review?status=all&amp;entry=${pending}"`);
    expect(res.text).toContain('Thành công');
    const failed = await get('super_admin', `/lookup/jobs?q=qzq${RUN}pg&status=failed&reason=upstream_error`);
    expect(failed.text).toContain('Dịch vụ ngoài lỗi');
  });

  it('keeps the filters in the form and the pager', async () => {
    const res = await get('super_admin', `/lookup/jobs?q=qzq${RUN}pg&status=failed&limit=1`);
    expect(res.text).toContain(`value="qzq${RUN}pg"`);
    expect(res.text).toMatch(/<option value="failed" selected>/);
    expect(res.text).toContain('page=2');
  });

  it('a bad filter goes back to the page with a message', async () => {
    const res = await get('super_admin', '/lookup/jobs?status=nope');
    expect([res.status, res.headers.location]).toEqual([302, '/lookup/jobs']);
    const page = await get('super_admin', '/lookup/jobs');
    expect(page.text).toContain('status không hợp lệ');
  });
});

describe('review page /lookup/review', () => {
  it('lists the entries made by the job waiting for review, and not the published ones', async () => {
    const res = await get('super_admin', `/lookup/review?q=qzq${RUN}pg`);
    expect(res.text).toContain(fixtureWord('pgclean'));
    expect(res.text).toContain(fixtureWord('pgflag'));
    expect(res.text).not.toContain(fixtureWord('pgpub'));
    const all = await get('super_admin', `/lookup/review?q=qzq${RUN}pg&status=all`);
    expect(all.text).toContain(fixtureWord('pgpub'));
    const done = await get('super_admin', `/lookup/review?q=qzq${RUN}pg&status=published`);
    expect(done.text).toContain(fixtureWord('pgpub'));
    expect(done.text).not.toContain(fixtureWord('pgclean'));
  });

  it.each(WRITERS)('%s can select the entries a bulk publish would take, and only those', async (role) => {
    const res = await get(role, `/lookup/review?q=qzq${RUN}pg`);
    expect(res.text).toContain('id="lk-bulk-publish"');
    expect(res.text).toContain(`class="lk-select" value="${pending}"`);
    expect(res.text).not.toContain(`value="${flagged}"`); // it has notes for review
  });

  it('a moderator gets the list and the detail, without checkboxes or buttons', async () => {
    const res = await get('moderator', `/lookup/review?q=qzq${RUN}pg&entry=${pending}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(fixtureWord('pgclean'));
    expect(res.text).not.toContain('lk-bulk-publish');
    expect(res.text).not.toContain('class="lk-select"');
    expect(res.text).not.toContain('data-lk-publish');
    expect(res.text).not.toContain('data-lk-hide');
    expect(res.text).not.toContain(`/dictionary/${pending}/edit`);
    expect(res.text).toContain(`/dictionary/${pending}`); // "Xem trong từ điển"
  });

  it.each(WRITERS)('%s sees Xuất bản and Sửa on a pending entry, Ẩn on a published one', async (role) => {
    const pend = await get(role, `/lookup/review?entry=${pending}`);
    expect(pend.text).toContain(`data-lk-publish="${pending}"`);
    expect(pend.text).not.toContain(`data-lk-hide="${pending}"`);
    expect(pend.text).toContain(`href="/dictionary/${pending}/edit"`);
    const pub = await get(role, `/lookup/review?status=all&entry=${published}`);
    expect(pub.text).toContain(`data-lk-hide="${published}"`);
    expect(pub.text).not.toContain(`data-lk-publish="${published}"`);
  });

  it('shows each Vietnamese meaning of a sense as a list item and flags the doubtful ones', async () => {
    const res = await get('moderator', `/lookup/review?entry=${flagged}`);
    const items = [...res.text.matchAll(/<li class="([^"]*)">([^<]*)/g)].map((m) => [m[1], m[2].trim()]);
    const byText = Object.fromEntries(items.map(([cls, text]) => [text, cls]));
    expect(byText['nốt ruồi']).toBe('');
    expect(byText['chắt rượu']).toBe('lk-flag'); // mentioned in notes_for_review
    expect(byText['một nghĩa dài dòng bất thường vượt giới hạn cho phép của người viết']).toBe('lk-flag'); // too long
    expect(res.text).toContain('dài bất thường');
    expect(res.text).toContain('có trong ghi chú cần xem');
  });

  it('shows the notes for review in a block of their own', async () => {
    const res = await get('moderator', `/lookup/review?entry=${flagged}`);
    expect(res.text).toContain('lk-review-notes');
    expect(res.text).toContain('cần kiểm tra lại cefr_level');
    const clean = await get('moderator', `/lookup/review?entry=${pending}`);
    expect(clean.text).not.toContain('class="lk-review-notes"');
  });

  it('escapes what comes from the data', async () => {
    const res = await get('super_admin', `/lookup/review?entry=${flagged}`);
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.text).not.toContain('a <b>small</b> spot');
    expect(res.text).toContain('a &lt;b&gt;small&lt;/b&gt; spot');
  });

  it('warns about a missing tier A in the detail', async () => {
    const bare = await createEntry({ tag: 'pgbare', senses: [] });
    const res = await get('super_admin', `/lookup/review?entry=${bare}`);
    expect(res.text).toContain('lk-tier-a-missing');
    expect(res.text).toContain('sense (definition_en và definition_vi)');
  });

  it('an entry that is not one of the job’s is not shown, with a warning', async () => {
    const manual = await createEntry({ tag: 'pgmanual', adminNote: 'tạo tay' });
    const res = await get('super_admin', `/lookup/review?entry=${manual}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Chọn một mục từ ở bên trái');
    expect(res.text).not.toContain(`data-lk-publish="${manual}"`);
  });

  it('a bad status goes back to the page with a message', async () => {
    const res = await get('super_admin', '/lookup/review?status=draft');
    expect([res.status, res.headers.location]).toEqual([302, '/lookup/review']);
  });
});

describe('detail fragment /lookup/review/:id/detail', () => {
  it('is the detail alone, without the page around it', async () => {
    const res = await get('moderator', `/lookup/review/${flagged}/detail`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<html');
    expect(res.text).not.toContain('lk-tabs');
    expect(res.text).toContain(`data-entry-id="${flagged}"`);
    expect(res.text).toContain(fixtureWord('pgflag'));
  });

  it('is 404 for something that is not an entry of the job', async () => {
    const manual = await createEntry({ tag: 'pgfragmanual', adminNote: 'tay' });
    for (const id of [manual, '00000000-0000-4000-8000-000000000000', 'nope']) {
      const res = await get('super_admin', `/lookup/review/${id}/detail`);
      expect([id, res.status]).toEqual([id, 404]);
      expect(res.text).toContain('Không tìm thấy');
    }
  });

  it('draws the buttons by role', async () => {
    expect((await get('content_editor', `/lookup/review/${pending}/detail`)).text).toContain('data-lk-publish');
    expect((await get('moderator', `/lookup/review/${pending}/detail`)).text).not.toContain('data-lk-publish');
  });
});

describe('health page /lookup/health', () => {
  it('draws a card for every provider, the jobs and the queue', async () => {
    const res = await get('moderator', '/lookup/health');
    expect(res.status).toBe(200);
    for (const provider of ['google_translate', 'free_dictionary', 'datamuse', 'anthropic', 'anthropic_fast']) {
      expect(res.text).toContain(`data-provider="${provider}"`);
    }
    expect(res.text).toContain('data-card="jobs-today"');
    expect(res.text).toContain('data-card="queue"');
    expect(res.text).toContain('20 lỗi gần nhất');
    expect(res.text).toMatch(/lk-health-card lk-(ok|warn|critical|unknown)/);
  });

  it('lists the words looked up and missing, with the add button for those who may use it', async () => {
    const res = await get('content_editor', '/lookup/health');
    expect(res.text).toContain(fixtureWord('pgmissing'));
    expect(res.text).toContain(`data-lk-add-word="${fixtureWord('pgmissing')}"`);
    // a word that is already queued has no button
    expect(res.text).toContain(fixtureWord('pgqueued'));
    expect(res.text).not.toContain(`data-lk-add-word="${fixtureWord('pgqueued')}"`);
    const moderator = await get('moderator', '/lookup/health');
    expect(moderator.text).toContain(fixtureWord('pgmissing'));
    expect(moderator.text).not.toContain('data-lk-add-word');
  });

  it('switches between 7 and 30 days', async () => {
    await createLookups({ wordText: fixtureWord('pgold'), result: 'translation', count: 2, daysAgo: 12 });
    const week = await get('moderator', '/lookup/health');
    expect(week.text).not.toContain(fixtureWord('pgold'));
    const month = await get('moderator', '/lookup/health?days=30');
    expect(month.text).toContain(fixtureWord('pgold'));
    expect(month.text).toMatch(/btn btn-sm btn-primary"[^>]*>30 ngày/);
  });
});
