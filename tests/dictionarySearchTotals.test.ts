/**
 * GET /api/v1/dictionary/search answers the page AND the total from one statement (COUNT(*) OVER ()). A page without rows has no row to
 * carry the total, so the route asks for it separately in exactly that case. Real app and database; the entries are made by the test.
 */
import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { RUN, cleanup, createEntry, fixtureWord } from './helpers/lookupAdminFixtures';

jest.setTimeout(120_000);

const token = `qzq${RUN}srch`;
const search = (qs: string) => request(app).get(`/api/v1/dictionary/search?${qs}`);

beforeAll(async () => {
  for (const tag of ['srch1', 'srch2', 'srch3']) await createEntry({ tag, published: true });
  await createEntry({ tag: 'srch4', published: false }); // matches the text but is not published
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('dictionary search totals', () => {
  it('the first page carries the real total, not the size of the page', async () => {
    const res = await search(`q=${token}&limit=2&page=1`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.meta).toEqual({ total: 3, page: 1, limit: 2 });
  });

  it('the last page is short and still knows the total', async () => {
    const res = await search(`q=${token}&limit=2&page=2`);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.meta.total).toBe(3);
  });

  it('a page past the end is empty and still reports the total (settled by the separate count)', async () => {
    const res = await search(`q=${token}&limit=2&page=9`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.meta).toEqual({ total: 3, page: 9, limit: 2 });
  });

  it('no match is an empty list with a total of 0', async () => {
    const res = await search(`q=${token}zzzz`);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.meta.total).toBe(0);
  });

  it('only published entries are counted and listed, the exact headword first, and the items carry no total_count', async () => {
    const res = await search(`q=${fixtureWord('srch2')}`);
    expect(res.body.data.meta.total).toBe(1);
    expect(res.body.data.items[0].headword).toBe(fixtureWord('srch2'));
    expect(res.body.data.items[0]).not.toHaveProperty('total_count');
  });

  it('keeps the filters in the total (part of speech and level)', async () => {
    const matching = await search(`q=${token}&pos=noun&cefr=B1`);
    expect(matching.body.data.meta.total).toBe(3);
    const none = await search(`q=${token}&pos=adverb`);
    expect(none.body.data.meta.total).toBe(0);
  });
});
