/**
 * Headwords with a hyphen or an apostrophe (full-time, long-term, well-being, T-shirt, o'clock, good-for-nothing) are valid
 * entries, and the admin must take them everywhere a word is typed: the entry form, the editor, the search box, and the box that
 * sends words to the enrichment queue (the real enqueuer, with a fake database and queue). Real Express app and real
 * PostgreSQL for the entry pages; nothing touches the network.
 */
import app from '../../app';
import pool from '../../config/db';
import { setEnrichmentEnqueuer } from '../../services/lookup/index';
import { PgBossEnrichmentEnqueuer } from '../../services/queue/pgBossEnqueuer';
import { makeEnqueuerFakes } from '../queue/helpers';
import { RUN, cleanup, createAdmins, fixtureWord, type AdminFixture, type Role } from '../helpers/lookupAdminFixtures';

let admins: Record<Role, AdminFixture>;
const spies: jest.SpyInstance[] = [];

// what a person types, and what the form stores (the entry form lower-cases the headword)
const WORDS = ['full-time', 'long-term', 'well-being', 'T-shirt', "o'clock", 'good-for-nothing'];

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

const html = (s: string) => s.replace(/'/g, '&#39;');
const rowOf = async (headword: string) => (await pool.query(`SELECT id, headword, lemma FROM dictionary_entries WHERE headword = $1`, [headword])).rows[0];

describe('the entry form (POST /dictionary/create) and the pages around it', () => {
  it.each(WORDS)('creates %j, shows it, opens its editor and finds it by search', async (word) => {
    const stored = fixtureWord(word);
    const typed = `qzq${RUN}${word}`; // typed with its own capitals (T-shirt)
    const res = await admins.super_admin.agent
      .post('/dictionary/create')
      .type('form')
      .send({ headword: typed, lemma: typed, meaning_vi: 'nghĩa thử', source: 'manual', pos: ['noun'] });
    const row = await rowOf(stored);
    expect(row).toBeDefined();
    expect([res.status, res.headers.location]).toEqual([302, `/dictionary/${row.id}`]);

    const show = await admins.super_admin.agent.get(`/dictionary/${row.id}`);
    expect(show.status).toBe(200);
    expect(show.text).toContain(html(stored));

    const edit = await admins.super_admin.agent.get(`/dictionary/${row.id}/edit`);
    expect(edit.status).toBe(200);
    expect(edit.text).toContain(html(stored));

    const search = await admins.super_admin.agent.get('/dictionary').query({ search: stored, format: 'json' });
    expect(search.status).toBe(200);
    expect(search.body.entries.map((e: { headword: string }) => e.headword)).toContain(stored);
  });

  it('saves the editor with the hyphen kept', async () => {
    const stored = fixtureWord('edit-ok-well-being');
    const created = await admins.super_admin.agent
      .post('/dictionary/create')
      .type('form')
      .send({ headword: stored, lemma: stored, meaning_vi: 'nghĩa thử', source: 'manual', pos: ['noun'] });
    expect(created.status).toBe(302);
    const row = await rowOf(stored);
    const res = await admins.content_editor.agent
      .post(`/dictionary/${row.id}/edit`)
      .type('form')
      .send({ headword: stored, lemma: stored, meaning_vi: 'nghĩa đã sửa', source: 'manual', pos: ['noun'] });
    expect([res.status, res.headers.location]).toEqual([302, `/dictionary/${row.id}`]);
    expect((await rowOf(stored)).headword).toBe(stored);
  });
});

describe('the box that sends words to the queue (POST /lookup/api/jobs, real enqueuer rules)', () => {
  it('queues every valid hyphenated word and refuses the malformed ones and the phrases, as before', async () => {
    const fakes = makeEnqueuerFakes();
    setEnrichmentEnqueuer(new PgBossEnrichmentEnqueuer({ pool: fakes.pool, getBoss: fakes.getBoss, usageFor: fakes.usageFor, maxJobsPerDay: 500 }));

    const good = ['full-time', 'long-term', 'well-being', 'T-shirt', "o'clock", 'good-for-nothing'];
    const bad = ['-abc', 'abc-', 'a--b', 'ice cream', 'abc123'];
    const res = await admins.super_admin.agent.post('/lookup/api/jobs').send({ words: [...good, ...bad] });
    expect(res.status).toBe(200);

    const byWord = Object.fromEntries(res.body.data.results.map((r: { word: string; status: string; reason?: string }) => [r.word, [r.status, r.reason ?? null]]));
    for (const word of good) expect(byWord[word]).toEqual(['queued', null]);
    for (const word of bad) expect(byWord[word]).toEqual(['skipped', 'invalid_word']);
    expect(fakes.send.mock.calls.map((c) => (c[1] as { word: string }).word).sort()).toEqual(good.map((w) => w.toLowerCase()).sort());
  });
});
