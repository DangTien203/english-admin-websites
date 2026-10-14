import * as fs from 'fs';
import * as path from 'path';
import { EnrichmentConfigError } from '../../services/enrichment/errors';
import { TOPIC_DESCRIPTIONS, TOPIC_NAMES, isTopicName, loadTopicIds, resetTopicCache } from '../../services/enrichment/topics';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

beforeEach(() => resetTopicCache());

describe('the 30 topics', () => {
  it('has 30 unique names, each with a description', () => {
    expect(TOPIC_NAMES).toHaveLength(30);
    expect(new Set(TOPIC_NAMES).size).toBe(30);
    for (const n of TOPIC_NAMES) expect(TOPIC_DESCRIPTIONS[n].length).toBeGreaterThan(20);
  });

  const reference = path.join(ROOT, 'docs/reference/classify-topics.mjs');
  (fs.existsSync(reference) ? it : it.skip)('copies docs/reference/classify-topics.mjs verbatim (names, order and descriptions)', () => {
    const src = read('docs/reference/classify-topics.mjs');
    const names = [...src.slice(src.indexOf('const TOPIC_NAMES = ['), src.indexOf('];', src.indexOf('const TOPIC_NAMES = [')) ).matchAll(/^\s*'([a-z_]+)',/gm)].map((m) => m[1]);
    expect([...TOPIC_NAMES]).toEqual(names);
    const block = src.slice(src.indexOf('const TOPIC_DESCRIPTIONS = {'), src.indexOf('\n};', src.indexOf('const TOPIC_DESCRIPTIONS = {')));
    for (const m of block.matchAll(/^\s*([a-z_]+):\s*'(.*)',\s*$/gm)) {
      expect(TOPIC_DESCRIPTIONS[m[1] as keyof typeof TOPIC_DESCRIPTIONS]).toBe(m[2]);
    }
  });

  const seedSql = path.join(ROOT, 'docs/seed-topics.sql');
  (fs.existsSync(seedSql) ? it : it.skip)('is the same set as docs/seed-topics.sql (the script that loads the tags)', () => {
    const sql = read('docs/seed-topics.sql');
    const values = sql.slice(sql.indexOf('INSERT INTO _topics'), sql.indexOf('INSERT INTO tags'));
    const names = [...values.matchAll(/\('([a-z_]+)'\)/g)].map((m) => m[1]);
    expect([...names].sort()).toEqual([...TOPIC_NAMES].sort());
  });

  it('isTopicName only accepts the 30 names (the 17 old tags are not topics)', () => {
    expect(isTopicName('food_drink')).toBe(true);
    for (const old of ['IELTS', 'TOEIC', 'Beginner', 'Food & Home', 'academic', '']) expect(isTopicName(old)).toBe(false);
  });
});

describe('loadTopicIds', () => {
  const idFor = (n: string) => `id-${n}`;

  it('returns the 30 ids and asks the database for exactly the 30 names (the old tags are never selected)', async () => {
    const query = jest.fn(async (_sql: string, params?: any[]) => ({ rows: (params![0] as string[]).map((name) => ({ id: idFor(name), name })) }));
    const ids = await loadTopicIds({ query });
    expect(ids.size).toBe(30);
    expect(ids.get('food_drink')).toBe('id-food_drink');
    expect(query.mock.calls[0][1]).toEqual([[...TOPIC_NAMES]]);
    expect(String(query.mock.calls[0][0])).toMatch(/^SELECT /); // read-only
  });

  it('keeps the ids in memory after the first success', async () => {
    const query = jest.fn(async (_sql: string, params?: any[]) => ({ rows: (params![0] as string[]).map((name) => ({ id: idFor(name), name })) }));
    await loadTopicIds({ query });
    await loadTopicIds({ query });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('throws EnrichmentConfigError "topics_not_seeded" listing the missing names', async () => {
    const present = TOPIC_NAMES.slice(0, 27);
    const query = jest.fn(async () => ({ rows: present.map((name) => ({ id: idFor(name), name })) }));
    const err: any = await loadTopicIds({ query }).catch((e) => e);
    expect(err).toBeInstanceOf(EnrichmentConfigError);
    expect(err.code).toBe('topics_not_seeded');
    expect(err.message).toMatch(/^topics_not_seeded: 3 of 30/);
    for (const missing of TOPIC_NAMES.slice(27)) expect(err.message).toContain(missing);
    expect(err.message).toContain('docs/seed-topics.sql');
  });

  it('does not cache a failure: after the tags are seeded the same process recovers', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockImplementation(async (_sql: string, params?: any[]) => ({ rows: (params![0] as string[]).map((name) => ({ id: idFor(name), name })) }));
    await expect(loadTopicIds({ query })).rejects.toThrow(/topics_not_seeded/);
    await expect(loadTopicIds({ query })).resolves.toHaveProperty('size', 30);
  });
});
