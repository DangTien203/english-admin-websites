/**
 * JSON endpoints of the lookup / enrichment admin (P8): roles, jobs, retry, entries made by the job, publish / hide, bulk
 * publish, health, most looked-up missing words. Real Express app and real PostgreSQL (the dev database); the queue is a fake
 * enqueuer, nothing touches the network.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../app';
import pool from '../../config/db';
import { topMissingWords } from '../../models/EnrichmentJobAdmin';
import type { EnqueueInput, EnrichmentEnqueuer } from '../../services/lookup/enqueuer';
import { setEnrichmentEnqueuer } from '../../services/lookup/index';
import { getLookupAdminService } from '../../services/lookup/adminService';
import type { EnrichmentInfo } from '../../services/lookup/types';
import {
  NOTE_CLEAN,
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

class FakeEnqueuer implements EnrichmentEnqueuer {
  calls: EnqueueInput[] = [];
  respond: (input: EnqueueInput) => EnrichmentInfo | Promise<EnrichmentInfo> = () => ({ status: 'queued' });
  async enqueue(input: EnqueueInput): Promise<EnrichmentInfo> {
    this.calls.push(input);
    return this.respond(input);
  }
}

const API = '/lookup/api';
let admins: Record<Role, AdminFixture>;
const fake = new FakeEnqueuer();

beforeAll(async () => {
  admins = await createAdmins(app);
});

// The app logs a JSON line per event; they are collected here (and kept off the test output). Only admin_action lines are kept.
let lines: any[] = [];
const spies: jest.SpyInstance[] = [];

beforeEach(() => {
  fake.calls = [];
  fake.respond = () => ({ status: 'queued' });
  setEnrichmentEnqueuer(fake);

  lines = [];
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

afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

afterAll(async () => {
  await cleanup();
  await pool.end();
});

const entryRow = async (id: string) => (await pool.query(`SELECT published FROM dictionary_entries WHERE id = $1`, [id])).rows[0];
const history = async (id: string) =>
  (await pool.query(`SELECT field_name, old_value, new_value, admin_id FROM entry_edit_history WHERE entry_id = $1 AND field_name = 'published' ORDER BY created_at, id`, [id])).rows;

// ── roles ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('roles', () => {
  let entryId: string;
  let failedJobId: string;

  beforeAll(async () => {
    entryId = await createEntry({ tag: 'rolea' });
    failedJobId = await createJob({ tag: 'rolejob', status: 'failed', reason: 'upstream_error' });
  });

  const reads = (): Array<[string, () => string]> => [
    ['GET jobs', () => `${API}/jobs?q=qzq${RUN}`],
    ['GET auto-entries', () => `${API}/auto-entries?status=all&q=qzq${RUN}`],
    ['GET auto-entries/:id', () => `${API}/auto-entries/${entryId}`],
    ['GET health', () => `${API}/health`],
    ['GET missing-words', () => `${API}/missing-words`],
  ];

  it.each(['super_admin', 'content_editor', 'moderator'] as Role[])('%s may read every endpoint', async (role) => {
    for (const [name, url] of reads()) {
      const res = await admins[role].agent.get(url());
      expect([name, res.status]).toEqual([name, 200]);
      expect(res.body.success).toBe(true);
    }
  });

  it('without a session every endpoint answers 401 in JSON (not a redirect)', async () => {
    for (const [name, url] of reads()) {
      const res = await request(app).get(url());
      expect([name, res.status, res.body.error?.code]).toEqual([name, 401, 'UNAUTHORIZED']);
    }
    const post = await request(app).post(`${API}/jobs`).send({ words: ['x'] });
    expect([post.status, post.body.error.code]).toEqual([401, 'UNAUTHORIZED']);
  });

  it('a moderator gets 403 FORBIDDEN on every write, and nothing happens', async () => {
    const writes: Array<[string, string, object]> = [
      ['POST', `${API}/jobs`, { words: [fixtureWord('modword')] }],
      ['POST', `${API}/jobs/${failedJobId}/retry`, {}],
      ['POST', `${API}/auto-entries/${entryId}/publish`, {}],
      ['POST', `${API}/auto-entries/${entryId}/hide`, {}],
      ['POST', `${API}/auto-entries/bulk-publish`, { entry_ids: [entryId] }],
    ];
    for (const [method, url, body] of writes) {
      const res = await admins.moderator.agent.post(url).send(body);
      expect([method, url, res.status, res.body.error?.code]).toEqual([method, url, 403, 'FORBIDDEN']);
    }
    expect(fake.calls).toHaveLength(0);
    expect((await entryRow(entryId)).published).toBe(false);
    expect(await history(entryId)).toHaveLength(0);
  });

  it.each(['super_admin', 'content_editor'] as Role[])('%s may write', async (role) => {
    const add = await admins[role].agent.post(`${API}/jobs`).send({ words: [fixtureWord(`w${role}`)] });
    expect(add.status).toBe(200);
    const id = await createEntry({ tag: `w${role}e` });
    const pub = await admins[role].agent.post(`${API}/auto-entries/${id}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ id, published: true, changed: true });
  });

  it('an unknown path under /lookup/api is a JSON 404', async () => {
    const res = await admins.super_admin.agent.get(`${API}/nothing-here`);
    expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('the editor of the dictionary is open to content_editor (the review screen links to it), the rest of it is not', async () => {
    const id = entryId;
    expect((await admins.content_editor.agent.get(`/dictionary/${id}/edit`)).status).toBe(200);
    expect((await admins.content_editor.agent.get(`/dictionary/${id}`)).status).toBe(200);
    expect((await admins.moderator.agent.get(`/dictionary/${id}/edit`)).status).toBe(200);
    // create / list / import stay with super_admin and moderator
    const create = await admins.content_editor.agent.get('/dictionary/create');
    expect([create.status, create.headers.location]).toEqual([302, '/dashboard']);
    expect((await admins.content_editor.agent.get('/dictionary')).status).toBe(302);
    expect((await admins.moderator.agent.get('/dictionary/create')).status).toBe(200);
    const anonymous = await request(app).get(`/dictionary/${id}/edit`);
    expect([anonymous.status, anonymous.headers.location]).toEqual([302, '/auth/login']);
  });
});

// ── jobs ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('GET /lookup/api/jobs', () => {
  const ids: Record<string, string> = {};
  let entryId: string;

  beforeAll(async () => {
    entryId = await createEntry({ tag: 'jent' });
    ids.upstream = await createJob({ tag: 'jup', status: 'failed', reason: 'upstream_error', attempts: 4 });
    ids.budget = await createJob({ tag: 'jbud', status: 'skipped', reason: 'budget' });
    ids.done = await createJob({ tag: 'jdone', status: 'succeeded', entryId });
    ids.invalid = await createJob({ tag: 'jinv', status: 'failed', reason: 'invalid_output' });
    ids.exists = await createJob({ tag: 'jex', status: 'skipped', reason: 'exists' });
    ids.old = await createJob({ tag: 'jold', status: 'failed', reason: 'dead_letter', createdAt: new Date(Date.now() - 10 * 86400_000) });
    // same word: an old failure and a job that is queued now → the old one cannot be retried
    ids.deadOld = await createJob({ tag: 'jact', status: 'failed', reason: 'dead_letter', createdAt: new Date(Date.now() - 3600_000) });
    ids.active = await createJob({ tag: 'jact', status: 'queued' });
  });

  // every job of this block has a tag that starts with "j": the fixtures of the other blocks stay out of the way
  const list = async (query: string, q = `qzq${RUN}j`) => {
    const res = await admins.moderator.agent.get(`${API}/jobs?q=${q}&${query}`);
    expect(res.status).toBe(200);
    return res.body.data as { items: any[]; pagination: any };
  };
  const words = (items: any[]) => items.map((i) => i.word).sort();

  it('lists the jobs newest first with the pagination block', async () => {
    const { items, pagination } = await list('limit=100');
    expect(items).toHaveLength(8);
    expect(pagination).toEqual({ page: 1, limit: 100, total: 8, total_pages: 1 });
    const times = items.map((i) => new Date(i.created_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(items[0]).toEqual(expect.objectContaining({ id: expect.any(String), word: expect.any(String), status: expect.any(String), attempts: expect.any(Number) }));
  });

  it('paginates', async () => {
    const first = await list('limit=3&page=1');
    const third = await list('limit=3&page=3');
    expect(first.items).toHaveLength(3);
    expect(first.pagination).toEqual({ page: 1, limit: 3, total: 8, total_pages: 3 });
    expect(third.items).toHaveLength(2);
    const seen = new Set([...first.items, ...(await list('limit=3&page=2')).items, ...third.items].map((i) => i.id));
    expect(seen.size).toBe(8);
  });

  it('filters by status', async () => {
    expect(words((await list('status=failed')).items)).toEqual([fixtureWord('jact'), fixtureWord('jinv'), fixtureWord('jold'), fixtureWord('jup')].sort());
    expect(words((await list('status=queued')).items)).toEqual([fixtureWord('jact')]);
    expect((await list('status=succeeded')).items.map((i) => i.id)).toEqual([ids.done]);
  });

  it('filters by reason, and by "none"', async () => {
    expect(words((await list('reason=budget')).items)).toEqual([fixtureWord('jbud')]);
    expect(words((await list('reason=dead_letter')).items)).toEqual([fixtureWord('jact'), fixtureWord('jold')].sort());
    expect(words((await list('reason=none')).items)).toEqual([fixtureWord('jact'), fixtureWord('jdone')].sort());
    expect((await list('status=failed&reason=upstream_error')).items.map((i) => i.id)).toEqual([ids.upstream]);
  });

  it('searches the word', async () => {
    expect(words((await list('', `qzq${RUN}jbud`)).items)).toEqual([fixtureWord('jbud')]);
    const res = await admins.moderator.agent.get(`${API}/jobs?q=${encodeURIComponent('%')}`);
    expect(res.body.data.items).toEqual([]); // a % is matched literally, not as a wildcard
  });

  it('filters by date (UTC, inclusive)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
    expect(words((await list(`from=${today}`)).items)).not.toContain(fixtureWord('jold'));
    expect(words((await list(`to=${old}`)).items)).toEqual([fixtureWord('jold')]);
    expect(words((await list(`from=${old}&to=${old}`)).items)).toEqual([fixtureWord('jold')]);
    expect((await list(`from=${today}&to=${today}`)).items.length).toBeGreaterThanOrEqual(7);
  });

  it('refuses a bad filter with 400 VALIDATION_ERROR', async () => {
    for (const query of ['status=nope', 'from=15-10-2026', 'to=2026-13-45', 'from=2026-10-10&to=2026-10-01', 'reason=Bad%20Reason']) {
      const res = await admins.moderator.agent.get(`${API}/jobs?${query}`);
      expect([query, res.status, res.body.error.code]).toEqual([query, 400, 'VALIDATION_ERROR']);
    }
  });

  it('links to the entry when there is one', async () => {
    const { items } = await list('status=succeeded');
    expect(items[0].entry).toEqual({ id: entryId, headword: fixtureWord('jent'), published: false, is_auto: true, url: `/lookup/review?status=all&entry=${entryId}` });
    const without = (await list('status=failed')).items[0];
    expect(without.entry).toBeNull();
  });

  it('links to the dictionary page when the entry was not made by the job', async () => {
    const other = await createEntry({ tag: 'jmanual', adminNote: 'tạo tay', published: true });
    await createJob({ tag: 'jmanual', status: 'skipped', reason: 'exists', entryId: other });
    const { items } = await list('', `qzq${RUN}jmanual`);
    expect(items[0].entry).toMatchObject({ id: other, is_auto: false, url: `/dictionary/${other}` });
  });

  it('says which jobs can be retried and why not', async () => {
    const { items } = await list('limit=100');
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by[ids.upstream]).toMatchObject({ retryable: true, retry_blocked: null });
    expect(by[ids.budget]).toMatchObject({ retryable: true, retry_blocked: null });
    expect(by[ids.old]).toMatchObject({ retryable: true });
    expect(by[ids.done]).toMatchObject({ retryable: false, retry_blocked: 'status_not_retryable' });
    expect(by[ids.invalid]).toMatchObject({ retryable: false, retry_blocked: 'status_not_retryable' });
    expect(by[ids.exists]).toMatchObject({ retryable: false, retry_blocked: 'status_not_retryable' });
    expect(by[ids.deadOld]).toMatchObject({ retryable: false, retry_blocked: 'word_active' });
    expect(by[ids.active]).toMatchObject({ retryable: false, retry_blocked: 'status_not_retryable' });
  });
});

// ── add words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /lookup/api/jobs', () => {
  const post = (body: unknown, role: Role = 'content_editor') => admins[role].agent.post(`${API}/jobs`).send(body as object);

  it('sends each word through the enqueuer and returns one result per word', async () => {
    fake.respond = (input) => {
      if (input.word === 'beta') return { status: 'already_queued' };
      if (input.word === 'gamma') return { status: 'skipped', reason: 'exists' };
      if (input.word === 'delta') return { status: 'skipped', reason: 'daily_cap' };
      return { status: 'queued' };
    };
    const res = await post({ words: ['alpha', 'beta', 'gamma', 'delta'] });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { word: 'alpha', status: 'queued' },
      { word: 'beta', status: 'already_queued' },
      { word: 'gamma', status: 'skipped', reason: 'exists' },
      { word: 'delta', status: 'skipped', reason: 'daily_cap' },
    ]);
    expect(res.body.data.summary).toMatchObject({ requested: 4, processed: 4, queued: 1, already_queued: 1, skipped: 2, error: 0 });
    // an admin has no row in users: the job is not "requested by" anybody, and no ebook is involved
    expect(fake.calls).toEqual(['alpha', 'beta', 'gamma', 'delta'].map((word) => ({ word, requestedBy: null, ebookId: null })));
  });

  it('accepts one word per line in a single string, ignores blank lines and sends a repeated word once', async () => {
    const res = await post({ words: ' alpha \r\n\r\nBeta\nalpha\n  \nALPHA' });
    expect(res.status).toBe(200);
    expect(fake.calls.map((c) => c.word)).toEqual(['alpha', 'Beta']);
    expect(res.body.data.summary).toMatchObject({ requested: 4, processed: 2 });
  });

  it('accepts 50 words and refuses 51 with 400, sending nothing', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    expect((await post({ words: fifty })).status).toBe(200);
    expect(fake.calls).toHaveLength(50);

    fake.calls = [];
    const res = await post({ words: [...fifty, 'onetoomany'] });
    expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(res.body.error.details).toEqual({ max: 50, received: 51 });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([[{}], [{ words: [] }], [{ words: '  \n ' }], [{ words: 7 }]])('refuses %j with 400', async (body) => {
    const res = await post(body);
    expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(fake.calls).toHaveLength(0);
  });

  it('reports a disabled queue per word instead of failing', async () => {
    fake.respond = () => ({ status: 'disabled' });
    const res = await post({ words: ['alpha'] });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([{ word: 'alpha', status: 'disabled' }]);
    expect(res.body.data.summary.disabled).toBe(1);
  });

  it('stops at the first queue failure, so a broken queue does not get one audit row per word', async () => {
    fake.respond = (input) => {
      if (input.word === 'bad') throw new Error('pg-boss is down');
      return { status: 'queued' };
    };
    const res = await post({ words: ['ok', 'bad', 'later1', 'later2'] });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { word: 'ok', status: 'queued' },
      { word: 'bad', status: 'error', reason: 'queue_error' },
      { word: 'later1', status: 'error', reason: 'not_attempted' },
      { word: 'later2', status: 'error', reason: 'not_attempted' },
    ]);
    expect(fake.calls.map((c) => c.word)).toEqual(['ok', 'bad']);
    expect(JSON.stringify(res.body)).not.toContain('pg-boss is down');
  });
});

// ── retry ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /lookup/api/jobs/:id/retry', () => {
  const retry = (id: string, role: Role = 'content_editor') => admins[role].agent.post(`${API}/jobs/${id}/retry`).send({});

  it.each([
    ['failed', 'upstream_error'],
    ['failed', 'dead_letter'],
    ['failed', 'stale'],
    ['failed', 'queue_error'],
    ['skipped', 'budget'],
    ['skipped', 'daily_cap'],
  ])('sends a new job for a %s / %s one', async (status, reason) => {
    const tag = `r${status}${reason}`.replace(/_/g, '').slice(0, 22);
    const id = await createJob({ tag, status, reason });
    const res = await retry(id);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ previous_job_id: id, word: fixtureWord(tag), result: { status: 'queued' } });
    expect(fake.calls).toEqual([{ word: fixtureWord(tag), requestedBy: null, ebookId: null }]);
  });

  it.each([
    ['succeeded', null],
    ['rejected', 'proper_noun'],
    ['failed', 'invalid_output'],
    ['failed', 'config_error'],
    ['skipped', 'exists'],
    ['skipped', 'variant_form'],
    ['queued', null],
    ['running', null],
  ])('refuses a %s / %s one with 409 JOB_NOT_RETRYABLE', async (status, reason) => {
    const id = await createJob({ tag: `n${status}${reason ?? ''}`.replace(/_/g, '').slice(0, 22), status, reason });
    const res = await retry(id);
    expect([res.status, res.body.error.code]).toEqual([409, 'JOB_NOT_RETRYABLE']);
    expect(res.body.error.details).toMatchObject({ status, reason });
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses with 409 WORD_ALREADY_ACTIVE when the word is queued or running', async () => {
    for (const active of ['queued', 'running']) {
      const old = await createJob({ tag: `act${active}`, status: 'failed', reason: 'upstream_error' });
      await createJob({ tag: `act${active}`, status: active });
      const res = await retry(old);
      expect([res.status, res.body.error.code]).toEqual([409, 'WORD_ALREADY_ACTIVE']);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses with 409 when the enqueuer finds the word active after all (a race), and when the queue is switched off', async () => {
    const id = await createJob({ tag: 'rrace', status: 'failed', reason: 'upstream_error' });
    fake.respond = () => ({ status: 'already_queued' });
    const race = await retry(id);
    expect([race.status, race.body.error.code]).toEqual([409, 'WORD_ALREADY_ACTIVE']);

    fake.respond = () => ({ status: 'disabled' });
    const off = await retry(id);
    expect([off.status, off.body.error.code]).toEqual([409, 'ENRICHMENT_DISABLED']);
  });

  it('passes on what the enqueuer decided when it does not queue (the word has an entry by now, or the daily cap)', async () => {
    const id = await createJob({ tag: 'rskip', status: 'failed', reason: 'upstream_error' });
    fake.respond = () => ({ status: 'skipped', reason: 'exists' });
    const res = await retry(id);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toEqual({ status: 'skipped', reason: 'exists' });
  });

  it('503 when the queue itself fails, without leaking the error', async () => {
    const id = await createJob({ tag: 'rdown', status: 'failed', reason: 'upstream_error' });
    fake.respond = () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
    };
    const res = await retry(id);
    expect([res.status, res.body.error.code]).toEqual([503, 'QUEUE_UNAVAILABLE']);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|hunter2/);
  });

  it('404 for an unknown job and for something that is not an id', async () => {
    expect((await retry(randomUUID())).status).toBe(404);
    expect((await retry('not-a-uuid')).status).toBe(404);
  });
});

// ── entries made by the job ───────────────────────────────────────────────────────────────────────────────────────────

describe('GET /lookup/api/auto-entries', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ids.pending = await createEntry({ tag: 'epend' });
    ids.published = await createEntry({ tag: 'epub', published: true });
    ids.notes = await createEntry({ tag: 'enotes', adminNote: NOTE_WITH_REVIEW });
    ids.noExample = await createEntry({ tag: 'enoex', senses: [{ examples: [['An example without a translation.', null]] }] });
    ids.manual = await createEntry({ tag: 'emanual', adminNote: 'nhập tay' });
    ids.nullNote = await createEntry({ tag: 'enull', adminNote: null });
  });

  // every entry of this block has a tag that starts with "e"
  const list = async (query: string, q = `qzq${RUN}e`) => {
    const res = await admins.moderator.agent.get(`${API}/auto-entries?q=${q}&${query}`);
    expect(res.status).toBe(200);
    return res.body.data as { items: any[]; pagination: any };
  };
  const heads = (items: any[]) => items.map((i) => i.headword).sort();

  it('lists only the entries whose admin_note starts with [auto]', async () => {
    const { items } = await list('status=all&limit=100');
    expect(heads(items)).toEqual([fixtureWord('enotes'), fixtureWord('enoex'), fixtureWord('epend'), fixtureWord('epub')].sort());
  });

  it('filters pending (published = false), published and all; pending is the default', async () => {
    expect(heads((await list('status=pending')).items)).toEqual([fixtureWord('enotes'), fixtureWord('enoex'), fixtureWord('epend')].sort());
    expect(heads((await list('')).items)).toEqual([fixtureWord('enotes'), fixtureWord('enoex'), fixtureWord('epend')].sort());
    expect(heads((await list('status=published')).items)).toEqual([fixtureWord('epub')]);
    expect((await list('status=all')).pagination.total).toBe(4);
  });

  it('searches by headword or lemma and paginates', async () => {
    expect(heads((await list('status=all', `qzq${RUN}epend`)).items)).toEqual([fixtureWord('epend')]);
    const page = await admins.moderator.agent.get(`${API}/auto-entries?status=all&q=qzq${RUN}e&limit=3&page=2`);
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.pagination).toEqual({ page: 2, limit: 3, total: 4, total_pages: 2 });
  });

  it('marks tier A, notes for review and what a bulk publish would take', async () => {
    const by = Object.fromEntries((await list('status=all&limit=100')).items.map((i) => [i.headword, i]));
    expect(by[fixtureWord('epend')]).toMatchObject({ tier_a_complete: true, tier_a_missing: [], review_note_count: 0, eligible_for_bulk_publish: true, sense_count: 1, published: false });
    expect(by[fixtureWord('enotes')]).toMatchObject({ tier_a_complete: true, review_note_count: 2, eligible_for_bulk_publish: false });
    expect(by[fixtureWord('enoex')]).toMatchObject({ tier_a_complete: false, tier_a_missing: ['ví dụ (example_en và example_vi)'], eligible_for_bulk_publish: false });
    expect(by[fixtureWord('epub')]).toMatchObject({ eligible_for_bulk_publish: false, published: true });
  });

  it('refuses an unknown status with 400', async () => {
    const res = await admins.moderator.agent.get(`${API}/auto-entries?status=draft`);
    expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('a % in the search is matched literally', async () => {
    const res = await admins.moderator.agent.get(`${API}/auto-entries?status=all&q=${encodeURIComponent('%')}`);
    expect(res.body.data.items).toEqual([]);
  });
});

describe('GET /lookup/api/auto-entries/:id', () => {
  let id: string;
  const long = 'một nghĩa dài dòng bất thường vượt giới hạn cho phép của người viết';

  beforeAll(async () => {
    id = await createEntry({
      tag: 'detail',
      adminNote: `${NOTE_WITH_REVIEW} · ước tính: cefr_level=B1`,
      meaningVi: 'nốt ruồi; chuột chũi',
      senses: [
        { pos: 'noun', definition_en: 'a small dark spot', definition_vi: `nốt ruồi; chắt rượu; ${long}`, examples: [['She has a mole.', 'Cô ấy có một nốt ruồi.']] },
        { pos: 'verb', definition_en: 'to dig', definition_vi: 'đào', examples: [] },
      ],
    });
    const sense = (await pool.query(`SELECT id FROM entry_senses WHERE entry_id = $1 AND sense_order = 0`, [id])).rows[0].id;
    await pool.query(`INSERT INTO sense_synonyms (sense_id, synonym_text) VALUES ($1, 'freckle')`, [sense]);
    await pool.query(`INSERT INTO sense_antonyms (sense_id, antonym_text) VALUES ($1, 'blank')`, [sense]);
    await pool.query(`INSERT INTO word_forms (entry_id, form_type, form_value) VALUES ($1, 'plural', 'moles')`, [id]);
    await pool.query(`INSERT INTO entry_idioms (entry_id, idiom_text, definition_en) VALUES ($1, 'a mole in the organisation', 'a spy')`, [id]);
    await pool.query(`INSERT INTO collocations (entry_id, collocation, pattern) VALUES ($1, 'dark mole', 'adj + noun')`, [id]);
    await pool.query(`INSERT INTO phrasal_verbs (entry_id, phrasal_verb, particle, is_separable) VALUES ($1, 'mole away', 'away', false)`, [id]);
    await pool.query(`INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value) VALUES ($1, NULL, 'auto_created', NULL, '{"job":"x"}')`, [id]);
    await createJob({ tag: 'detail', status: 'succeeded', entryId: id });
  });

  it('returns the fields, the senses with their meanings split, the examples and the related rows', async () => {
    const res = await admins.moderator.agent.get(`${API}/auto-entries/${id}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ id, headword: fixtureWord('detail'), published: false, cefr_level: 'B1', source: 'wiktionary', pos: ['noun'] });
    expect(d.meanings_vi.map((m: any) => m.text)).toEqual(['nốt ruồi', 'chuột chũi']);
    expect(d.senses).toHaveLength(2);
    expect(d.senses[0]).toMatchObject({ order: 0, pos: 'noun', definition_en: 'a small dark spot', synonyms: ['freckle'], antonyms: ['blank'] });
    expect(d.senses[0].meanings_vi.map((m: any) => m.text)).toEqual(['nốt ruồi', 'chắt rượu', long]);
    expect(d.senses[0].examples).toEqual([{ id: expect.any(String), example_en: 'She has a mole.', example_vi: 'Cô ấy có một nốt ruồi.' }]); // the id is what the sense editor sends back
    expect(d.senses[1].meanings_vi.map((m: any) => m.text)).toEqual(['đào']);
    expect(d.word_forms).toEqual([expect.objectContaining({ form_type: 'plural', form_value: 'moles' })]);
    expect(d.idioms).toEqual([expect.objectContaining({ idiom_text: 'a mole in the organisation' })]);
    expect(d.collocations).toEqual([expect.objectContaining({ collocation: 'dark mole' })]);
    expect(d.phrasal_verbs).toEqual([expect.objectContaining({ phrasal_verb: 'mole away', particle: 'away' })]);
    expect(d.history).toEqual([expect.objectContaining({ field_name: 'auto_created', admin_name: null })]);
    expect(d.job).toMatchObject({ status: 'succeeded' });
  });

  it('flags the meanings that are too long or that a note for review mentions', async () => {
    const d = (await admins.moderator.agent.get(`${API}/auto-entries/${id}`)).body.data;
    const flags = Object.fromEntries(d.senses[0].meanings_vi.map((m: any) => [m.text, [m.too_long, m.in_review_notes]]));
    expect(flags['nốt ruồi']).toEqual([false, false]);
    expect(flags['chắt rượu']).toEqual([false, true]); // "Nghĩa 'chắt rượu' thuộc chuyên ngành" is in notes_for_review
    expect(flags[long]).toEqual([true, false]);
    expect(d.has_flagged_meanings).toBe(true);
  });

  it('breaks admin_note into source, model, job, tier B and notes for review, and keeps the text', async () => {
    const d = (await admins.moderator.agent.get(`${API}/auto-entries/${id}`)).body.data;
    expect(d.note).toMatchObject({
      sources: ['wiktionary', 'haiku'],
      model: 'claude-haiku-5-5',
      job_id: 'seed-test',
      tier_b_missing: ['etymology'],
      estimated: ['cefr_level=B1'], // written after the notes, still recognised
      review_notes: ["Nghĩa 'chắt rượu' thuộc chuyên ngành.", 'cần kiểm tra lại cefr_level'],
    });
    expect(d.admin_note).toContain('[auto]');
    expect(d.tier_a_complete).toBe(true);
    expect(d.eligible_for_bulk_publish).toBe(false); // it has notes for review
  });

  it('shows what is missing when tier A is incomplete', async () => {
    const bare = await createEntry({ tag: 'bare', senses: [], meaningVi: '', pos: [] });
    const d = (await admins.moderator.agent.get(`${API}/auto-entries/${bare}`)).body.data;
    expect(d.tier_a_complete).toBe(false);
    expect(d.tier_a_missing).toEqual(['pos', 'meaning_vi', 'sense (definition_en và definition_vi)', 'ví dụ (example_en và example_vi)']);
    expect(d.senses).toEqual([]);
  });

  it('404 for an entry that was not made by the job, an unknown id and a bad id', async () => {
    const manual = await createEntry({ tag: 'dmanual', adminNote: 'tay' });
    for (const bad of [manual, randomUUID(), 'nope']) {
      const res = await admins.moderator.agent.get(`${API}/auto-entries/${bad}`);
      expect([bad, res.status, res.body.error.code]).toEqual([bad, 404, 'NOT_FOUND']);
    }
  });
});

// ── publish / hide ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('publish and hide one entry', () => {
  const act = (id: string, what: 'publish' | 'hide', role: Role = 'content_editor') => admins[role].agent.post(`${API}/auto-entries/${id}/${what}`).send({});

  it('publishes, writes entry_edit_history with the admin who did it, and is idempotent', async () => {
    const id = await createEntry({ tag: 'pub1' });
    const res = await act(id, 'publish');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id, headword: fixtureWord('pub1'), published: true, changed: true, tier_a_missing: [] });
    expect((await entryRow(id)).published).toBe(true);
    expect(await history(id)).toEqual([{ field_name: 'published', old_value: 'false', new_value: 'true', admin_id: admins.content_editor.id }]);

    const again = await act(id, 'publish', 'super_admin');
    expect(again.body.data).toMatchObject({ published: true, changed: false });
    expect(await history(id)).toHaveLength(1); // nothing changed, nothing written
  });

  it('hides, and the history shows both steps and who took them', async () => {
    const id = await createEntry({ tag: 'hide1', published: true });
    const res = await act(id, 'hide', 'super_admin');
    expect(res.body.data).toMatchObject({ id, published: false, changed: true });
    expect((await entryRow(id)).published).toBe(false);
    expect(await history(id)).toEqual([{ field_name: 'published', old_value: 'true', new_value: 'false', admin_id: admins.super_admin.id }]);

    await act(id, 'publish', 'content_editor');
    const rows = await history(id);
    expect(rows.map((r) => `${r.old_value}>${r.new_value}`)).toEqual(['true>false', 'false>true']);
    expect(rows.map((r) => r.admin_id)).toEqual([admins.super_admin.id, admins.content_editor.id]);
  });

  it('may publish an entry with tier A missing (the admin decides) and says what is missing', async () => {
    const id = await createEntry({ tag: 'pubtierA', senses: [] });
    const res = await act(id, 'publish');
    expect(res.status).toBe(200);
    expect(res.body.data.tier_a_missing).toEqual(['sense (definition_en và definition_vi)', 'ví dụ (example_en và example_vi)']);
  });

  it('404 for an entry that was not made by the job: this is not a general publish switch', async () => {
    const manual = await createEntry({ tag: 'pubmanual', adminNote: 'tạo tay' });
    for (const what of ['publish', 'hide'] as const) {
      const res = await act(manual, what);
      expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
    }
    expect((await entryRow(manual)).published).toBe(false);
    expect(await history(manual)).toHaveLength(0);
    expect((await act(randomUUID(), 'publish')).status).toBe(404);
    expect((await act('nope', 'hide')).status).toBe(404);
  });

  it('the change and its history line are ONE transaction: if the history cannot be written, nothing changes', async () => {
    const id = await createEntry({ tag: 'atomic' });
    const stranger = randomUUID(); // not in admin_accounts → the foreign key of entry_edit_history refuses the line
    await expect(getLookupAdminService().setPublished(id, true, stranger)).rejects.toMatchObject({ code: '23503' });
    expect((await entryRow(id)).published).toBe(false);
    expect(await history(id)).toHaveLength(0);
  });
});

// ── bulk publish ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /lookup/api/auto-entries/bulk-publish', () => {
  const bulk = (entryIds: unknown, role: Role = 'content_editor') => admins[role].agent.post(`${API}/auto-entries/bulk-publish`).send({ entry_ids: entryIds });

  it('publishes only what is [auto], tier A complete and without notes for review, and says why it skipped the rest', async () => {
    const ok1 = await createEntry({ tag: 'bulkok1' });
    const ok2 = await createEntry({ tag: 'bulkok2' });
    const notes = await createEntry({ tag: 'bulknotes', adminNote: NOTE_WITH_REVIEW });
    const noExample = await createEntry({ tag: 'bulknoex', senses: [{ examples: [['No translation here.', '  ']] }] });
    const noSense = await createEntry({ tag: 'bulknosense', senses: [] });
    const already = await createEntry({ tag: 'bulkpub', published: true });
    const manual = await createEntry({ tag: 'bulkmanual', adminNote: 'tạo tay' });
    const missing = randomUUID();

    const res = await bulk([ok1, ok2, notes, noExample, noSense, already, manual, missing, ok1]); // ok1 twice
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.requested).toBe(8);
    expect(d.published).toEqual(expect.arrayContaining([{ id: ok1, headword: fixtureWord('bulkok1') }, { id: ok2, headword: fixtureWord('bulkok2') }]));
    expect(d.published).toHaveLength(2);
    const skipped = Object.fromEntries(d.skipped.map((s: any) => [s.id, s]));
    expect(d.skipped).toHaveLength(6);
    expect(skipped[notes]).toMatchObject({ reason: 'has_review_notes', headword: fixtureWord('bulknotes') });
    expect(skipped[noExample]).toMatchObject({ reason: 'tier_a_incomplete', tier_a_missing: ['ví dụ (example_en và example_vi)'] });
    expect(skipped[noSense]).toMatchObject({ reason: 'tier_a_incomplete' });
    expect(skipped[noSense].tier_a_missing).toEqual(['sense (definition_en và definition_vi)', 'ví dụ (example_en và example_vi)']);
    expect(skipped[already]).toMatchObject({ reason: 'already_published' });
    expect(skipped[manual]).toMatchObject({ reason: 'not_auto' });
    expect(skipped[missing]).toEqual({ id: missing, headword: null, reason: 'not_found' });

    for (const id of [ok1, ok2]) {
      expect((await entryRow(id)).published).toBe(true);
      expect(await history(id)).toEqual([{ field_name: 'published', old_value: 'false', new_value: 'true', admin_id: admins.content_editor.id }]);
    }
    for (const id of [notes, noExample, noSense, manual]) {
      expect((await entryRow(id)).published).toBe(false);
      expect(await history(id)).toHaveLength(0);
    }
    expect(await history(already)).toHaveLength(0);
  });

  it('accepts 100 ids and refuses 101 with 400, changing nothing', async () => {
    const ok = await createEntry({ tag: 'bulk100' });
    const filler = Array.from({ length: 99 }, () => randomUUID());
    const hundred = await bulk([ok, ...filler]);
    expect(hundred.status).toBe(200);
    expect(hundred.body.data.published).toHaveLength(1);
    expect(hundred.body.data.skipped).toHaveLength(99);

    const another = await createEntry({ tag: 'bulk101' });
    const res = await bulk([another, ...filler, randomUUID()]);
    expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(res.body.error.details).toEqual({ max: 100, received: 101 });
    expect((await entryRow(another)).published).toBe(false);
  });

  it.each([[undefined], [[]], ['abc'], [['not-a-uuid']], [[randomUUID(), 5]]])('refuses entry_ids = %j with 400', async (ids) => {
    const res = await bulk(ids);
    expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('is all or nothing: if a history line cannot be written, no entry is published', async () => {
    const a = await createEntry({ tag: 'bulkatomic1' });
    const b = await createEntry({ tag: 'bulkatomic2' });
    await expect(getLookupAdminService().bulkPublish([a, b], randomUUID())).rejects.toMatchObject({ code: '23503' });
    expect((await entryRow(a)).published).toBe(false);
    expect((await entryRow(b)).published).toBe(false);
  });
});

// ── health and demand ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('GET /lookup/api/health', () => {
  it('returns the snapshot of LookupHealthService as it is (the keys of `npm run health:snapshot`)', async () => {
    const res = await admins.moderator.agent.get(`${API}/health`);
    expect(res.status).toBe(200);
    const s = res.body.data;
    expect(Object.keys(s)).toEqual(expect.arrayContaining(['generatedAt', 'breakers', 'google', 'anthropic', 'jobs', 'queue', 'recentFailures', 'lookups', 'counters']));
    expect(Object.keys(s.breakers).sort()).toEqual(['anthropic', 'anthropic_fast', 'datamuse', 'free_dictionary', 'google_translate']);
    expect(s.jobs.today).toMatchObject({ limit: expect.any(Number), used: expect.any(Number), remaining: expect.any(Number) });
    expect(s.google).toMatchObject({ charsUsed: expect.any(Number), monthlyCharLimit: expect.any(Number) });
    expect(Array.isArray(s.recentFailures)).toBe(true);
    expect(s.recentFailures.length).toBeLessThanOrEqual(20);
  });
});

describe('GET /lookup/api/missing-words', () => {
  beforeAll(async () => {
    await createLookups({ wordText: fixtureWord('mtrans'), result: 'translation', count: 3 });
    await createLookups({ wordText: fixtureWord('mnf').toUpperCase(), result: 'not_found', count: 2 }); // upper case is the same word
    await createLookups({ wordText: fixtureWord('mnf'), result: 'not_found', count: 3 });
    await createLookups({ wordText: fixtureWord('mdict'), result: 'dictionary', count: 4 }); // served by the dictionary: not missing
    await createLookups({ wordText: null, result: 'not_found', count: 2 }); // old rows without word_text
    await createLookups({ wordText: '   ', result: 'translation', count: 2 });
    await createLookups({ wordText: fixtureWord('mold'), result: 'translation', count: 4, daysAgo: 10 });
    await createLookups({ wordText: fixtureWord('mpub'), result: 'translation', count: 2 });
    await createEntry({ tag: 'mpub', published: true }); // has a published entry now
    await createLookups({ wordText: fixtureWord('munpub'), result: 'translation', count: 2 });
    const entry = await createEntry({ tag: 'munpub' }); // waiting for review
    await createJob({ tag: 'munpub', status: 'succeeded', entryId: entry });
    await createLookups({ wordText: fixtureWord('mjob'), result: 'translation', count: 2 });
    await createJob({ tag: 'mjob', status: 'queued' });
    await createLookups({ wordText: fixtureWord('mfail'), result: 'not_found', count: 2 });
    await createJob({ tag: 'mfail', status: 'failed', reason: 'upstream_error' });
  });

  const mine = async (days: number) => {
    // the endpoint keeps the top 50 of the whole database; the model takes a limit, so the fixtures cannot be crowded out
    const rows = await topMissingWords(days, 5000);
    return Object.fromEntries(rows.filter((r) => r.word.startsWith(`qzq${RUN}`)).map((r) => [r.word, r]));
  };

  it('counts the lookups that got a temporary answer or "not found", per word, ignoring case', async () => {
    const m = await mine(7);
    expect(m[fixtureWord('mtrans')].lookups).toBe(3);
    expect(m[fixtureWord('mnf')].lookups).toBe(5);
  });

  it('leaves out dictionary hits, rows without word_text and words that have a published entry', async () => {
    const m = await mine(30);
    expect(m[fixtureWord('mdict')]).toBeUndefined();
    expect(m[fixtureWord('mpub')]).toBeUndefined();
    expect(Object.keys(m).some((w) => w.trim() === '')).toBe(false);
  });

  it('looks back 7 or 30 days', async () => {
    expect((await mine(7))[fixtureWord('mold')]).toBeUndefined();
    expect((await mine(30))[fixtureWord('mold')].lookups).toBe(4);
  });

  it('keeps a word whose entry is still unpublished, with the entry; shows the latest job', async () => {
    const m = await mine(7);
    expect(m[fixtureWord('munpub')]).toMatchObject({ entry_published: false, entry_is_auto: true, job_status: 'succeeded' });
    expect(m[fixtureWord('mjob')]).toMatchObject({ job_status: 'queued', entry_id: null });
    expect(m[fixtureWord('mfail')]).toMatchObject({ job_status: 'failed', job_reason: 'upstream_error' });
  });

  it('answers with at most 50 words, the most looked-up first, and says whether the word can be queued', async () => {
    const res = await admins.moderator.agent.get(`${API}/missing-words?days=30`);
    expect(res.status).toBe(200);
    const { days, items } = res.body.data;
    expect(days).toBe(30);
    expect(items.length).toBeLessThanOrEqual(50);
    const counts = items.map((i: any) => i.lookups);
    expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
    for (const i of items) {
      expect(i).toEqual(expect.objectContaining({ word: expect.any(String), lookups: expect.any(Number), can_enqueue: expect.any(Boolean) }));
      expect(i.can_enqueue).toBe(!i.entry && !(i.job && ['queued', 'running'].includes(i.job.status)));
    }
  });

  it('days is 7 (default) or 30; anything else is a 400', async () => {
    expect((await admins.moderator.agent.get(`${API}/missing-words`)).body.data.days).toBe(7);
    for (const days of ['1', '14', 'x', '7.5']) {
      const res = await admins.moderator.agent.get(`${API}/missing-words?days=${days}`);
      expect([days, res.status, res.body.error.code]).toEqual([days, 400, 'VALIDATION_ERROR']);
    }
  });
});

// ── the log ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('evt=admin_action log', () => {
  it('records a publish: who, what, on which entry, how it ended', async () => {
    const id = await createEntry({ tag: 'logpub' });
    await admins.content_editor.agent.post(`${API}/auto-entries/${id}/publish`).send({});
    expect(lines).toEqual([
      expect.objectContaining({ evt: 'admin_action', admin_id: admins.content_editor.id, action: 'entry.publish', target_type: 'entry', target_id: id, result: 'ok', changed: true }),
    ]);
  });

  it('records a word list with counters only, never the words', async () => {
    fake.respond = (input) => (input.word === 'beta' ? { status: 'already_queued' } : { status: 'queued' });
    await admins.super_admin.agent.post(`${API}/jobs`).send({ words: ['alpha', 'beta', 'gamma'] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: 'jobs.add_words', admin_id: admins.super_admin.id, result: 'ok', requested: 3, queued: 2, already_queued: 1 });
    expect(JSON.stringify(lines[0])).not.toMatch(/alpha|gamma/);
  });

  it('records a refusal with its error code, and a forbidden attempt of a moderator', async () => {
    const job = await createJob({ tag: 'logret', status: 'succeeded' });
    await admins.content_editor.agent.post(`${API}/jobs/${job}/retry`).send({});
    await admins.moderator.agent.post(`${API}/jobs/${job}/retry`).send({});
    expect(lines).toEqual([
      expect.objectContaining({ action: 'jobs.retry', target_id: job, result: 'rejected:JOB_NOT_RETRYABLE', admin_id: admins.content_editor.id }),
      expect.objectContaining({ admin_id: admins.moderator.id, result: 'forbidden', action: expect.stringContaining('/jobs/:id/retry') }),
    ]);
  });

  it('records a bulk publish with counts', async () => {
    const ok = await createEntry({ tag: 'logbulk' });
    await admins.content_editor.agent.post(`${API}/auto-entries/bulk-publish`).send({ entry_ids: [ok, randomUUID()] });
    expect(lines[0]).toMatchObject({ action: 'entry.bulk_publish', result: 'ok', requested: 2, published: 1, skipped: 1 });
  });

  it('holds no personal or sensitive data: no e-mail, no admin_note, no body', async () => {
    const id = await createEntry({ tag: 'logpriv', adminNote: NOTE_WITH_REVIEW });
    await admins.content_editor.agent.post(`${API}/auto-entries/${id}/publish`).send({ secret: 'hunter2' });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('@example.com');
    expect(text).not.toContain('chắt rượu');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('P8 content_editor');
  });

  it('reads are not logged', async () => {
    await admins.moderator.agent.get(`${API}/jobs?q=qzq${RUN}`);
    expect(lines).toEqual([]);
  });
});
