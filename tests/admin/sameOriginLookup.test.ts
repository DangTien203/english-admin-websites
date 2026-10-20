/**
 * The write endpoints of the lookup / enrichment admin (P8) behind the Origin / Referer check (middlewares/sameOrigin.ts).
 * They authenticate with the same session cookie as the admin pages (requireAdminJson reads req.session.admin), so a cross-site
 * page could post to them with the admin's cookie; the guard is what stops that. Real Express app, real PostgreSQL (the dev
 * database), real logins through POST /auth/login (tests/helpers/lookupAdminFixtures.ts); the queue is a recording fake.
 *
 * P8 write routes (routes/lookup.ts, all under /lookup/api):
 *   POST /jobs                       add words
 *   POST /jobs/:id/retry             re-send a failed job
 *   POST /auto-entries/:id/publish   publish one entry made by the job
 *   POST /auto-entries/:id/hide      take it back
 *   POST /auto-entries/bulk-publish  publish many
 * The /lookup pages (/lookup, /jobs, /review, /health) have GET routes only.
 *
 * "Changes nothing" is checked in the database (published flag, entry_edit_history) and in the queue fake.
 * Every request carries Host: admin.test so that "same origin" is a fixed value instead of the ephemeral 127.0.0.1:<port>.
 */
import request from 'supertest';
import app from '../../app';
import pool from '../../config/db';
import type { EnqueueInput, EnrichmentEnqueuer } from '../../services/lookup/enqueuer';
import { setEnrichmentEnqueuer } from '../../services/lookup/index';
import type { EnrichmentInfo } from '../../services/lookup/types';
import { cleanup, createAdmins, createEntry, createJob, fixtureWord, type AdminFixture, type Role } from '../helpers/lookupAdminFixtures';

const HOST = 'admin.test';
const OWN_ORIGIN = `http://${HOST}`;
const EVIL = 'http://evil.example';
const API = '/lookup/api';

class FakeEnqueuer implements EnrichmentEnqueuer {
  calls: EnqueueInput[] = [];
  async enqueue(input: EnqueueInput): Promise<EnrichmentInfo> {
    this.calls.push(input);
    return { status: 'queued' };
  }
}

const fake = new FakeEnqueuer();
let admins: Record<Role, AdminFixture>;
let spies: jest.SpyInstance[] = [];

const published = async (id: string): Promise<boolean> =>
  (await pool.query('SELECT published FROM dictionary_entries WHERE id = $1', [id])).rows[0].published;
const historyRows = async (id: string): Promise<number> =>
  (await pool.query(`SELECT 1 FROM entry_edit_history WHERE entry_id = $1 AND field_name = 'published'`, [id])).rowCount ?? 0;
const jobStatus = async (id: string): Promise<string> =>
  (await pool.query('SELECT status FROM word_enrichment_jobs WHERE id = $1', [id])).rows[0].status;

/** A POST as the given admin (a real session cookie), with the extra headers. */
const post = (role: Role, url: string, body: object, headers: Record<string, string> = {}) =>
  admins[role].agent.post(url).set('Host', HOST).set(headers).send(body);

beforeAll(async () => {
  admins = await createAdmins(app);
});

beforeEach(() => {
  fake.calls = [];
  setEnrichmentEnqueuer(fake);
  // the admin audit and the lookup service log one JSON line per event; they are not under test
  spies = (['log', 'info', 'warn', 'error'] as const).map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => spies.forEach((s) => s.mockRestore()));

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('publish one entry (POST /lookup/api/auto-entries/:id/publish)', () => {
  it.each([
    ['same-site Origin', { Origin: OWN_ORIGIN }, 'pubo'],
    ['same-site Referer and no Origin', { Referer: `${OWN_ORIGIN}/lookup/review` }, 'pubr'],
    ['neither Origin nor Referer (curl, supertest)', {}, 'pubn'],
  ])('publishes with %s, and records who did it', async (_name, headers, tag) => {
    const id = await createEntry({ tag });
    const res = await post('content_editor', `${API}/auto-entries/${id}/publish`, {}, headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, published: true, changed: true });
    expect(await published(id)).toBe(true);
    expect(await historyRows(id)).toBe(1);
  });

  it.each([
    ['another site in Origin', { Origin: EVIL }, 'pubxo'],
    ['another site in Referer when there is no Origin', { Referer: `${EVIL}/page` }, 'pubxr'],
    ['Origin: null (sandboxed frame)', { Origin: 'null' }, 'pubxn'],
    ['the same host on another port', { Origin: `${OWN_ORIGIN}:8080` }, 'pubxp'],
  ])('refuses %s with 403 FORBIDDEN, and the entry stays unpublished', async (_name, headers, tag) => {
    const id = await createEntry({ tag });
    const res = await post('content_editor', `${API}/auto-entries/${id}/publish`, {}, headers);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: { code: 'FORBIDDEN', message: expect.stringContaining('Request refused') } });
    expect(await published(id)).toBe(false);
    expect(await historyRows(id)).toBe(0);
  });
});

describe('bulk publish (POST /lookup/api/auto-entries/bulk-publish)', () => {
  it.each([
    ['same-site Origin', { Origin: OWN_ORIGIN }, 'bulko'],
    ['neither Origin nor Referer (curl, supertest)', {}, 'bulkn'],
  ])('publishes the eligible entries with %s', async (_name, headers, tag) => {
    const a = await createEntry({ tag: `${tag}a` });
    const b = await createEntry({ tag: `${tag}b` });
    const res = await post('content_editor', `${API}/auto-entries/bulk-publish`, { entry_ids: [a, b] }, headers);
    expect(res.status).toBe(200);
    expect(res.body.data.published.map((e: { id: string }) => e.id).sort()).toEqual([a, b].sort());
    expect(await published(a)).toBe(true);
    expect(await published(b)).toBe(true);
  });

  it('refuses another site with 403 FORBIDDEN, and nothing is published', async () => {
    const a = await createEntry({ tag: 'bulkxa' });
    const b = await createEntry({ tag: 'bulkxb' });
    const res = await post('content_editor', `${API}/auto-entries/bulk-publish`, { entry_ids: [a, b] }, { Origin: EVIL });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await published(a)).toBe(false);
    expect(await published(b)).toBe(false);
    expect(await historyRows(a)).toBe(0);
    expect(await historyRows(b)).toBe(0);
  });
});

describe('every P8 write route refuses another site (and changes nothing)', () => {
  it('POST /jobs, /jobs/:id/retry, /auto-entries/:id/publish, /hide, /bulk-publish', async () => {
    const toPublish = await createEntry({ tag: 'allpub' });
    const toHide = await createEntry({ tag: 'allhide', published: true });
    const bulk = await createEntry({ tag: 'allbulk' });
    const failedJob = await createJob({ tag: 'allretry', status: 'failed', reason: 'upstream_error' });

    const writes: Array<[string, object]> = [
      [`${API}/jobs`, { words: [fixtureWord('alljob')] }],
      [`${API}/jobs/${failedJob}/retry`, {}],
      [`${API}/auto-entries/${toPublish}/publish`, {}],
      [`${API}/auto-entries/${toHide}/hide`, {}],
      [`${API}/auto-entries/bulk-publish`, { entry_ids: [bulk] }],
    ];
    // as super_admin, so the role check could not be what refuses them
    for (const [url, body] of writes) {
      const res = await post('super_admin', url, body, { Origin: EVIL });
      expect([url, res.status, res.body.error?.code]).toEqual([url, 403, 'FORBIDDEN']);
    }

    expect(fake.calls).toHaveLength(0);
    expect(await jobStatus(failedJob)).toBe('failed');
    expect(await published(toPublish)).toBe(false);
    expect(await published(toHide)).toBe(true);
    expect(await published(bulk)).toBe(false);
  });

  it('refuses before the login and role checks: no session and a moderator both get the guard 403, not 401', async () => {
    const anonymous = await request(app).post(`${API}/jobs`).set('Host', HOST).set('Origin', EVIL).send({ words: [fixtureWord('anon')] });
    expect([anonymous.status, anonymous.body.error.code]).toEqual([403, 'FORBIDDEN']);
    expect(anonymous.body.error.message).toContain('Request refused');
    const moderator = await post('moderator', `${API}/jobs`, { words: [fixtureWord('modx')] }, { Origin: EVIL });
    expect([moderator.status, moderator.body.error.code]).toEqual([403, 'FORBIDDEN']);
    expect(moderator.body.error.message).toContain('Request refused'); // the guard's message, not the role check's
    expect(fake.calls).toHaveLength(0);
  });

  it('P9: the sense editor (PATCH /auto-entries/:id/senses/:senseId) refuses another site too, before the login and role checks', async () => {
    const id = await createEntry({ tag: 'allsense' });
    const sense = (await pool.query('SELECT id, definition_vi FROM entry_senses WHERE entry_id = $1', [id])).rows[0];
    const url = `${API}/auto-entries/${id}/senses/${sense.id}`;
    const edit = { definition_vi: 'từ trang khác' };

    const asEditor = await admins.super_admin.agent.patch(url).set('Host', HOST).set('Origin', EVIL).send(edit);
    expect([asEditor.status, asEditor.body.error.code]).toEqual([403, 'FORBIDDEN']);
    expect(asEditor.body.error.message).toContain('Request refused');
    const anonymous = await request(app).patch(url).set('Host', HOST).set('Origin', EVIL).send(edit);
    expect([anonymous.status, anonymous.body.error.message]).toEqual([403, expect.stringContaining('Request refused')]);

    expect((await pool.query('SELECT definition_vi FROM entry_senses WHERE id = $1', [sense.id])).rows[0].definition_vi).toBe(sense.definition_vi);
    expect((await pool.query('SELECT 1 FROM entry_edit_history WHERE entry_id = $1', [id])).rowCount).toBe(0);

    const own = await admins.super_admin.agent.patch(url).set('Host', HOST).set('Origin', OWN_ORIGIN).send(edit);
    expect(own.status).toBe(200);
  });

  it('does not look at reads: a cross-site GET of every read endpoint still answers 200', async () => {
    for (const url of [`${API}/jobs`, `${API}/auto-entries`, `${API}/health`, `${API}/missing-words`]) {
      const res = await admins.super_admin.agent.get(url).set('Host', HOST).set('Origin', EVIL);
      expect([url, res.status]).toEqual([url, 200]);
    }
  });
});
