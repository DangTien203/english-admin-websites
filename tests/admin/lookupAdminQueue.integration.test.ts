/**
 * The admin pages with the REAL enqueuer: real PostgreSQL, real pg-boss in a schema of its own (pgboss_test_p8_<run>, dropped at
 * the end), real word_enrichment_jobs rows. Nothing runs the jobs (there is no worker), and nothing talks to an external service.
 *
 * What it proves that tests/admin/lookupAdminApi.test.ts (fake enqueuer) cannot: an admin has no row in `users`, so a job sent
 * from the pages must go through the queue with requested_by NULL and no ebook; sending the same word twice, a word that already
 * has an entry, the daily cap and "retry" all behave as the enqueuer says.
 *
 * The daily counter used here is "enrichment_test_p8_<run>", never the real `enrichment` one.
 */
import type { PgBoss } from 'pg-boss';
import request from 'supertest';
import app from '../../app';
import pool from '../../config/db';
import { createStartedBoss, type QueueSettings } from '../../services/queue/boss';
import { ENRICH_QUEUE } from '../../services/queue/constants';
import { PgBossEnrichmentEnqueuer } from '../../services/queue/pgBossEnqueuer';
import { setEnrichmentEnqueuer } from '../../services/lookup/index';
import {
  RUN,
  cleanup as cleanupFixtures,
  createAdmins,
  createEntry,
  createJob,
  fixtureWord,
  type AdminFixture,
  type Role,
} from '../helpers/lookupAdminFixtures';

jest.setTimeout(90_000);

const SETTINGS: QueueSettings = { schema: `pgboss_test_p8_${RUN}`, poolMax: 4, retryLimit: 2, retryDelaySeconds: 1, retryDelayMaxSeconds: 2, expireSeconds: 60 };
const PROVIDER = `enrichment_test_p8_${RUN}`;
const API = '/lookup/api';

let boss: PgBoss;
let admins: Record<Role, AdminFixture>;
let maxJobsPerDay = 1000;
const spies: jest.SpyInstance[] = [];

pool.on('error', () => undefined); // a dropped idle connection (Neon) must not crash the run

const rowsOf = async (word: string) => (await pool.query(`SELECT * FROM word_enrichment_jobs WHERE word = $1 ORDER BY created_at`, [word])).rows;
const bossJobs = async (word: string) => boss.findJobs(ENRICH_QUEUE, { key: word });

beforeAll(async () => {
  for (const level of ['info', 'warn', 'error'] as const) spies.push(jest.spyOn(console, level).mockImplementation(() => undefined));
  boss = await createStartedBoss(SETTINGS, 'sender');
  setEnrichmentEnqueuer(
    new PgBossEnrichmentEnqueuer({ pool: pool as any, getBoss: async () => boss, maxJobsPerDay: 1000, usageProvider: PROVIDER })
  );
  admins = await createAdmins(app);
});

afterAll(async () => {
  spies.splice(0).forEach((s) => s.mockRestore());
  await boss?.stop({ graceful: false, close: true }).catch(() => undefined);
  await cleanupFixtures();
  await pool.query(`DELETE FROM api_usage_counters WHERE provider LIKE $1`, [`${PROVIDER}%`]);
  await pool.query(`DROP SCHEMA IF EXISTS ${SETTINGS.schema} CASCADE`);
  await pool.end();
});

describe('add words through the real queue', () => {
  it('queues a word: a ledger row without a requesting user and a pg-boss job with the four fields of the job data', async () => {
    const word = fixtureWord('reala');
    const res = await admins.content_editor.agent.post(`${API}/jobs`).send({ words: [word] });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([{ word, status: 'queued' }]);

    const [row] = await rowsOf(word);
    expect(row).toMatchObject({ status: 'queued', requested_by: null, attempts: 0 });
    const [job] = await bossJobs(word);
    expect(job.data).toEqual({ word, requestedBy: null, ebookId: null, jobRowId: row.id });
  });

  it('sending the same word again is already_queued, and nothing new is written', async () => {
    const word = fixtureWord('realb');
    await admins.super_admin.agent.post(`${API}/jobs`).send({ words: [word] });
    const again = await admins.super_admin.agent.post(`${API}/jobs`).send({ words: [word] });
    expect(again.body.data.results).toEqual([{ word, status: 'already_queued' }]);
    expect(await rowsOf(word)).toHaveLength(1);
    expect(await bossJobs(word)).toHaveLength(1);
  });

  it('skips a word that already has an entry (published or not) and a word the cleaner rejects, without a job', async () => {
    await createEntry({ tag: 'realhas' });
    const has = fixtureWord('realhas');
    const res = await admins.content_editor.agent.post(`${API}/jobs`).send({ words: [has, 'abc123', 'two words'] });
    expect(res.body.data.results).toEqual([
      { word: has, status: 'skipped', reason: 'exists' },
      { word: 'abc123', status: 'skipped', reason: 'invalid_word' },
      { word: 'two words', status: 'skipped', reason: 'invalid_word' },
    ]);
    expect(await rowsOf(has)).toHaveLength(0);
    expect(await bossJobs(has)).toHaveLength(0);
  });

  it('the daily cap counts what the pages send (and "skipped" when it is used up)', async () => {
    maxJobsPerDay = 2;
    const provider = `${PROVIDER}_cap`;
    setEnrichmentEnqueuer(new PgBossEnrichmentEnqueuer({ pool: pool as any, getBoss: async () => boss, maxJobsPerDay, usageProvider: provider }));
    try {
      const words = ['capa', 'capb', 'capc'].map(fixtureWord);
      const res = await admins.content_editor.agent.post(`${API}/jobs`).send({ words });
      expect(res.body.data.results.map((r: any) => r.status + (r.reason ? `:${r.reason}` : ''))).toEqual(['queued', 'queued', 'skipped:daily_cap']);
      expect(await rowsOf(words[2])).toHaveLength(0);
    } finally {
      setEnrichmentEnqueuer(new PgBossEnrichmentEnqueuer({ pool: pool as any, getBoss: async () => boss, maxJobsPerDay: 1000, usageProvider: PROVIDER }));
    }
  });
});

describe('retry through the real queue', () => {
  it('a failed job gets a new job; the old row stays as history; a second retry is refused while the new one is waiting', async () => {
    const word = fixtureWord('retrya');
    const failed = await createJob({ tag: 'retrya', status: 'failed', reason: 'upstream_error', attempts: 4 });

    const res = await admins.content_editor.agent.post(`${API}/jobs/${failed}/retry`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ previous_job_id: failed, word, result: { status: 'queued' } });

    const rows = await rowsOf(word);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'queued']);
    expect(rows[1]).toMatchObject({ requested_by: null, attempts: 0 });
    expect((await bossJobs(word))[0].data).toMatchObject({ word, requestedBy: null, ebookId: null, jobRowId: rows[1].id });

    const second = await admins.content_editor.agent.post(`${API}/jobs/${failed}/retry`).send({});
    expect([second.status, second.body.error.code]).toEqual([409, 'WORD_ALREADY_ACTIVE']);
    expect(await rowsOf(word)).toHaveLength(2);
  });

  it('a job whose word has got an entry meanwhile is not queued again: the enqueuer says exists', async () => {
    const failed = await createJob({ tag: 'retryb', status: 'skipped', reason: 'budget' });
    await createEntry({ tag: 'retryb' });
    const res = await admins.super_admin.agent.post(`${API}/jobs/${failed}/retry`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.result).toEqual({ status: 'skipped', reason: 'exists' });
    expect(await rowsOf(fixtureWord('retryb'))).toHaveLength(1);
  });
});

describe('the pages see what was queued', () => {
  it('the list shows the new job as queued, and it is not retryable', async () => {
    const res = await admins.moderator.agent.get(`${API}/jobs?q=${fixtureWord('reala')}`);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ status: 'queued', retryable: false });
    const page = await request(app).get('/lookup/jobs');
    expect(page.status).toBe(302); // no session
  });
});
