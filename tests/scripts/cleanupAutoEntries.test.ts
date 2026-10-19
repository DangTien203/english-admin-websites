/**
 * scripts/dev/cleanup-auto-entries.ts: lists the entries the enrichment job made (dry run by default) and deletes them only with
 * --confirm, in one transaction, never touching an entry that is not "[auto]" and skipping an [auto] entry that something else
 * points at. Real PostgreSQL (the dev database, which holds REAL [auto] entries): every test that deletes is scoped, through the
 * `onlyIds` option of the library functions (the command line has no such option), to entries this run made, named "qzq<run>…".
 * The tests that look at the whole database only read.
 */
import pool from '../../config/db';
import * as AutoEntry from '../../models/AutoEntry';
import { OWN_TABLES, blockingKeys, executeCleanup, formatPlan, loadForeignKeys, planCleanup, previewCleanup, run } from '../../scripts/dev/cleanup-auto-entries';
import { RUN, cleanup as cleanupFixtures, createEntry, createJob } from '../helpers/lookupAdminFixtures';

const MANUAL_NOTE = 'tạo tay, không phải của job';

// The dev database is a remote serverless one: a plan alone is about sixty queries, so a test that makes a plan, or a connection that
// is reset and re-opened in the middle of one, can take longer than the 20 s of the other suites.
jest.setTimeout(120_000);

beforeAll(async () => {
  // a serverless database may be asleep: the first connection of a run can be cut while TLS starts
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}, 30_000);

afterAll(async () => {
  await pool.query(`DELETE FROM lessons WHERE title LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM tags WHERE name LIKE $1`, [`qzq${RUN}%`]);
  await cleanupFixtures();
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`p8c-${RUN}-%`]);
  await pool.end();
});

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────────
let counter = 0;
/** letters only (the word cleaner rejects digits): a fresh tag for every entry */
const tag = (prefix: string): string => {
  let n = counter++;
  let s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${prefix}${s}`;
};

const auto = (prefix: string, o: { published?: boolean } = {}) => createEntry({ tag: tag(prefix), ...o });
const manual = (prefix: string) => createEntry({ tag: tag(prefix), adminNote: MANUAL_NOTE });
const noNote = (prefix: string) => createEntry({ tag: tag(prefix), adminNote: null });

const exists = async (id: string): Promise<boolean> => (await pool.query(`SELECT 1 FROM dictionary_entries WHERE id = $1`, [id])).rowCount === 1;
const countWhere = async (sql: string, params: any[]): Promise<number> => (await pool.query(sql, params)).rows[0].n as number;

async function addFamily(entryId: string, n: string) {
  await pool.query(`INSERT INTO word_forms (entry_id, form_type, form_value) VALUES ($1, 'plural', $2), ($1, 'past_simple', $3)`, [entryId, `${n}s`, `${n}ed`]);
  const t = (await pool.query(`INSERT INTO tags (name) VALUES ($1) RETURNING id`, [`qzq${RUN}tag${n}`])).rows[0].id;
  await pool.query(`INSERT INTO entry_tags (entry_id, tag_id) VALUES ($1, $2)`, [entryId, t]);
  await pool.query(`INSERT INTO entry_edit_history (entry_id, field_name, old_value, new_value) VALUES ($1, 'published', 'false', 'true')`, [entryId]);
}

async function testUser(): Promise<string> {
  const email = `p8c-${RUN}-user@example.com`;
  const found = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (found.rows[0]) return found.rows[0].id;
  return (await pool.query(`INSERT INTO users (email, password_hash, full_name) VALUES ($1, 'x', 'P8c reader') RETURNING id`, [email])).rows[0].id;
}

/** A source that records the first words of every statement and can be made to fail at COMMIT or to lie about the DELETE. */
function spySource(o: { failOnCommit?: boolean; deleteRowCount?: number } = {}) {
  const seen: string[] = [];
  const source = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, params?: any[]) => {
          const head = sql.trim().split(/\s+/).slice(0, 3).join(' ').toUpperCase();
          seen.push(head);
          if (o.failOnCommit && head.startsWith('COMMIT')) throw new Error('COMMIT failed (test)');
          const res = await client.query(sql, params);
          if (o.deleteRowCount !== undefined && head.startsWith('DELETE FROM DICTIONARY_ENTRIES')) return { rows: res.rows, rowCount: o.deleteRowCount };
          return res;
        },
        release: (e?: Error | boolean) => client.release(e),
      };
    },
  };
  return { seen, source };
}

// ═════════════════════════════════════════════════════════════════════════════
describe('what points at an entry (read from the database catalog)', () => {
  it('finds the foreign keys into dictionary_entries, with their delete rule', async () => {
    const fks = await loadForeignKeys(pool);
    const into = fks.filter((f) => f.parent === 'dictionary_entries');
    expect(into.find((f) => f.table === 'entry_senses')).toMatchObject({ column: 'entry_id', rule: 'CASCADE' });
    expect(into.find((f) => f.table === 'lesson_entries')).toMatchObject({ column: 'entry_id', rule: 'CASCADE' });
    expect(into.find((f) => f.table === 'word_enrichment_jobs')).toMatchObject({ rule: 'SET NULL' });
    expect(into.filter((f) => f.table === 'entry_synonyms').map((f) => f.column).sort()).toEqual(['entry_id', 'synonym_id']);
  });

  it('holds an entry back for what is not its own data: lessons, links FROM other entries, saved words, cards…', async () => {
    const blocking = blockingKeys(await loadForeignKeys(pool));
    const names = blocking.map((b) => `${b.table}.${b.column}`);
    for (const must of ['lesson_entries.entry_id', 'entry_synonyms.synonym_id', 'entry_antonyms.antonym_id', 'user_saved_words.entry_id', 'leitner_cards.entry_id']) expect(names).toContain(must);
  });

  it('does NOT hold it back for its own data or logs, or for what is merely set to NULL', async () => {
    const names = blockingKeys(await loadForeignKeys(pool)).map((b) => `${b.table}.${b.column}`);
    for (const own of ['entry_senses.entry_id', 'word_forms.entry_id', 'entry_tags.entry_id', 'entry_edit_history.entry_id', 'entry_synonyms.entry_id', 'entry_antonyms.entry_id', 'word_lookups.entry_id', 'word_enrichment_jobs.entry_id']) {
      expect(names).not.toContain(own);
    }
    expect([...OWN_TABLES]).toEqual(expect.arrayContaining(['entry_senses', 'entry_edit_history']));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the dry run (the default)', () => {
  it('on the whole database it only reads: the [auto] set is the one the review screen lists, the rest is left alone, and nothing is deleted', async () => {
    const before = await countWhere(`SELECT count(*)::int AS n FROM dictionary_entries`, []);
    const reviewScreen = await AutoEntry.listAutoEntries({ status: 'all' }, 1, 100000);
    const plan = await previewCleanup(pool);

    expect(plan.found).toBe(reviewScreen.total); // the SAME criterion as /lookup/review
    expect(plan.foundPublished).toBe(reviewScreen.rows.filter((r) => r.published).length);
    expect(plan.untouched).toBe(before - plan.found);
    expect(plan.toDelete.length + plan.skipped.length).toBe(plan.found);
    expect(plan.toDelete.every((e) => reviewScreen.rows.some((r) => r.id === e.id))).toBe(true);
    expect(await countWhere(`SELECT count(*)::int AS n FROM dictionary_entries`, [])).toBe(before);
  });

  it('never opens anything but a READ ONLY transaction, and never issues a write', async () => {
    const e = await auto('dryro');
    const { seen, source } = spySource();
    await previewCleanup(source, { onlyIds: [e] });
    expect(seen[0]).toBe('BEGIN READ ONLY');
    expect(seen[seen.length - 1]).toBe('ROLLBACK');
    expect(seen.filter((s) => /^(DELETE|UPDATE|INSERT|TRUNCATE|DROP|ALTER)\b/.test(s))).toEqual([]);
    expect(seen).not.toContain('COMMIT');
    expect(await exists(e)).toBe(true);
  });

  it('the database itself would refuse a write in it (that is what READ ONLY is for)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await expect(client.query(`DELETE FROM dictionary_entries WHERE id = '00000000-0000-0000-0000-000000000000'`)).rejects.toMatchObject({ code: '25006' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('counts the rows that would go, per related table, and the rows that would be set to NULL', async () => {
    const a = await auto('cnta');
    const b = await auto('cntb', { published: true });
    await addFamily(a, 'cnta');
    await addFamily(b, 'cntb');
    await createJob({ tag: 'cntjob', status: 'succeeded', entryId: a });
    const other = await manual('cntother');
    const otherSense = (await pool.query(`SELECT id FROM entry_senses WHERE entry_id = $1`, [other])).rows[0].id;
    await pool.query(`INSERT INTO sense_synonyms (sense_id, synonym_text, synonym_entry_id) VALUES ($1, 'x', $2)`, [otherSense, a]);

    const plan = await previewCleanup(pool, { onlyIds: [a, b, other] });
    const rows = Object.fromEntries(plan.cascadeRows.map((r) => [r.table, r.rows]));
    expect(plan.found).toBe(2);
    expect(plan.foundPublished).toBe(1);
    expect(plan.toDeletePublished).toBe(1);
    expect(plan.untouched).toBe(1); // the manual entry
    expect(rows).toMatchObject({ entry_senses: 2, sense_examples: 2, word_forms: 4, entry_tags: 2, entry_edit_history: 2 });
    expect(plan.nullRows).toEqual(
      expect.arrayContaining([
        { table: 'word_enrichment_jobs', column: 'entry_id', rows: 1 },
        { table: 'sense_synonyms', column: 'synonym_entry_id', rows: 1 }, // another entry's sense that points at a deleted one
      ])
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('--confirm (executeCleanup)', () => {
  it('deletes the [auto] entries and everything of theirs, and reports what it deleted', async () => {
    const a = await auto('delA');
    const b = await auto('delB', { published: true });
    await addFamily(a, 'dela');
    await addFamily(b, 'delb');
    const expectedSenses = await countWhere(`SELECT count(*)::int AS n FROM entry_senses WHERE entry_id = ANY($1::uuid[])`, [[a, b]]);
    const expectedForms = await countWhere(`SELECT count(*)::int AS n FROM word_forms WHERE entry_id = ANY($1::uuid[])`, [[a, b]]);

    const result = await executeCleanup(pool, { onlyIds: [a, b] });
    expect(result.deleted).toBe(2);
    expect(result.toDelete.map((e) => e.id).sort()).toEqual([a, b].sort());
    expect(result.toDeletePublished).toBe(1);
    const rows = Object.fromEntries(result.cascadeRows.map((r) => [r.table, r.rows]));
    expect(rows.entry_senses).toBe(expectedSenses);
    expect(rows.word_forms).toBe(expectedForms);

    for (const id of [a, b]) {
      expect(await exists(id)).toBe(false);
      for (const table of ['entry_senses', 'word_forms', 'entry_tags', 'entry_edit_history']) {
        expect(await countWhere(`SELECT count(*)::int AS n FROM ${table} WHERE entry_id = $1`, [id])).toBe(0);
      }
    }
    expect(await countWhere(`SELECT count(*)::int AS n FROM sense_examples x JOIN entry_senses s ON s.id = x.sense_id WHERE s.entry_id = ANY($1::uuid[])`, [[a, b]])).toBe(0);
  });

  it('leaves an entry that is not [auto] alone, whatever its note (a note by hand, no note), even when its id is asked for', async () => {
    const m = await manual('keepm');
    const n = await noNote('keepn');
    await addFamily(m, 'keepm');
    const result = await executeCleanup(pool, { onlyIds: [m, n] });
    expect(result).toMatchObject({ found: 0, deleted: 0 });
    expect(result.toDelete).toEqual([]);
    expect(await exists(m)).toBe(true);
    expect(await exists(n)).toBe(true);
    expect(await countWhere(`SELECT count(*)::int AS n FROM word_forms WHERE entry_id = $1`, [m])).toBe(2);
  });

  it('only touches the entries in scope: another [auto] entry of this run stays', async () => {
    const inScope = await auto('scopein');
    const outOfScope = await auto('scopeout');
    await executeCleanup(pool, { onlyIds: [inScope] });
    expect(await exists(inScope)).toBe(false);
    expect(await exists(outOfScope)).toBe(true);
  });

  it('keeps the rows that only point at the entry and sets the pointer to NULL (a job, another entry\'s "synonym of" link)', async () => {
    const a = await auto('nullA');
    const other = await manual('nullother');
    const job = await createJob({ tag: 'nulljob', status: 'succeeded', entryId: a });
    const sense = (await pool.query(`SELECT id FROM entry_senses WHERE entry_id = $1`, [other])).rows[0].id;
    await pool.query(`INSERT INTO sense_synonyms (sense_id, synonym_text, synonym_entry_id) VALUES ($1, 'cùng nghĩa', $2)`, [sense, a]);

    const result = await executeCleanup(pool, { onlyIds: [a] });
    expect(result.nullRows).toEqual(expect.arrayContaining([{ table: 'word_enrichment_jobs', column: 'entry_id', rows: 1 }, { table: 'sense_synonyms', column: 'synonym_entry_id', rows: 1 }]));
    expect((await pool.query(`SELECT entry_id FROM word_enrichment_jobs WHERE id = $1`, [job])).rows).toEqual([{ entry_id: null }]);
    expect((await pool.query(`SELECT synonym_text, synonym_entry_id FROM sense_synonyms WHERE sense_id = $1`, [sense])).rows).toEqual([{ synonym_text: 'cùng nghĩa', synonym_entry_id: null }]);
  });

  it('is ONE transaction: if the COMMIT fails, nothing is deleted', async () => {
    const a = await auto('atoma');
    const b = await auto('atomb');
    const { seen, source } = spySource({ failOnCommit: true });
    await expect(executeCleanup(source, { onlyIds: [a, b] })).rejects.toThrow('COMMIT failed');
    expect(seen[0]).toBe('BEGIN');
    expect(seen).toContain('ROLLBACK');
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(true);
    expect(await countWhere(`SELECT count(*)::int AS n FROM entry_senses WHERE entry_id = ANY($1::uuid[])`, [[a, b]])).toBe(2);
  });

  it('rolls everything back when the DELETE reports a number of rows other than the plan', async () => {
    const a = await auto('lieA');
    const b = await auto('lieB');
    const { source } = spySource({ deleteRowCount: 1 });
    await expect(executeCleanup(source, { onlyIds: [a, b] })).rejects.toThrow(/Dự kiến xóa 2 mục từ nhưng DELETE báo 1/);
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(true);
  });

  it('issues exactly one DELETE, on dictionary_entries, repeating the [auto] test', async () => {
    const a = await auto('onedel');
    const { seen, source } = spySource();
    await executeCleanup(source, { onlyIds: [a] });
    expect(seen.filter((s) => s.startsWith('DELETE'))).toEqual(['DELETE FROM DICTIONARY_ENTRIES']);
    expect(seen.filter((s) => /^(UPDATE|INSERT|TRUNCATE|DROP)\b/.test(s))).toEqual([]);
    expect(seen[0]).toBe('BEGIN');
    expect(seen[seen.length - 1]).toBe('COMMIT');
  });

  it('with nothing to delete it commits nothing harmful and says 0', async () => {
    const m = await manual('nothing');
    expect(await executeCleanup(pool, { onlyIds: [m] })).toMatchObject({ found: 0, deleted: 0, toDelete: [], skipped: [] });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('an [auto] entry that something else points at is REPORTED and SKIPPED', () => {
  it('in a lesson: kept, with the lesson and its row intact; the others of the run still go', async () => {
    const inLesson = await auto('lessonin');
    const free = await auto('lessonfree');
    const lesson = (await pool.query(`INSERT INTO lessons (title) VALUES ($1) RETURNING id`, [`qzq${RUN}lesson`])).rows[0].id;
    await pool.query(`INSERT INTO lesson_entries (lesson_id, entry_id) VALUES ($1, $2)`, [lesson, inLesson]);

    const result = await executeCleanup(pool, { onlyIds: [inLesson, free] });
    expect(result.deleted).toBe(1);
    expect(result.toDelete.map((e) => e.id)).toEqual([free]);
    expect(result.skipped).toEqual([expect.objectContaining({ id: inLesson, blockers: [{ table: 'lesson_entries', column: 'entry_id', rows: 1 }] })]);
    expect(await exists(inLesson)).toBe(true);
    expect(await exists(free)).toBe(false);
    expect(await countWhere(`SELECT count(*)::int AS n FROM lesson_entries WHERE lesson_id = $1`, [lesson])).toBe(1);
  });

  it('as the synonym of ANOTHER entry (entry_synonyms): kept; and likewise as an antonym', async () => {
    const asSynonym = await auto('synin');
    const asAntonym = await auto('antin');
    const holder = await manual('holder');
    await pool.query(`INSERT INTO entry_synonyms (entry_id, synonym_id) VALUES ($1, $2)`, [holder, asSynonym]);
    await pool.query(`INSERT INTO entry_antonyms (entry_id, antonym_id) VALUES ($1, $2)`, [holder, asAntonym]);

    const result = await executeCleanup(pool, { onlyIds: [asSynonym, asAntonym] });
    expect(result.deleted).toBe(0);
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.id, s.blockers.map((b) => `${b.table}.${b.column}`)]));
    expect(reasons).toEqual({ [asSynonym]: ['entry_synonyms.synonym_id'], [asAntonym]: ['entry_antonyms.antonym_id'] });
    expect(await exists(asSynonym)).toBe(true);
    expect(await exists(asAntonym)).toBe(true);
    expect(await countWhere(`SELECT count(*)::int AS n FROM entry_synonyms WHERE entry_id = $1`, [holder])).toBe(1);
    expect(await countWhere(`SELECT count(*)::int AS n FROM entry_antonyms WHERE entry_id = $1`, [holder])).toBe(1);
  });

  it('its OWN links to other entries do not hold it back: they go with it, and the other entry stays', async () => {
    const a = await auto('ownlink');
    const target = await manual('linktarget');
    await pool.query(`INSERT INTO entry_synonyms (entry_id, synonym_id) VALUES ($1, $2)`, [a, target]);
    await pool.query(`INSERT INTO entry_antonyms (entry_id, antonym_id) VALUES ($1, $2)`, [a, target]);

    const result = await executeCleanup(pool, { onlyIds: [a] });
    expect(result.deleted).toBe(1);
    expect(Object.fromEntries(result.cascadeRows.map((r) => [r.table, r.rows]))).toMatchObject({ entry_synonyms: 1, entry_antonyms: 1 });
    expect(await exists(target)).toBe(true);
    expect(await countWhere(`SELECT count(*)::int AS n FROM entry_synonyms WHERE synonym_id = $1`, [target])).toBe(0);
  });

  it('two [auto] entries that are synonyms of each other both go (the link is deleted with either)', async () => {
    const a = await auto('pairA');
    const b = await auto('pairB');
    await pool.query(`INSERT INTO entry_synonyms (entry_id, synonym_id) VALUES ($1, $2), ($2, $1)`, [a, b]);
    const result = await executeCleanup(pool, { onlyIds: [a, b] });
    expect(result.deleted).toBe(2);
    expect(result.skipped).toEqual([]);
  });

  it('the skip chains: an entry that is the synonym of a skipped entry is skipped too (nothing is left pointing at a deleted entry)', async () => {
    const b = await auto('chainB'); // in a lesson: skipped
    const a = await auto('chainA'); // the synonym of B
    const lesson = (await pool.query(`INSERT INTO lessons (title) VALUES ($1) RETURNING id`, [`qzq${RUN}chain`])).rows[0].id;
    await pool.query(`INSERT INTO lesson_entries (lesson_id, entry_id) VALUES ($1, $2)`, [lesson, b]);
    await pool.query(`INSERT INTO entry_synonyms (entry_id, synonym_id) VALUES ($1, $2)`, [b, a]);

    const result = await executeCleanup(pool, { onlyIds: [a, b] });
    expect(result.deleted).toBe(0);
    expect(result.skipped.map((s) => s.id).sort()).toEqual([a, b].sort());
    expect(result.skipped.find((s) => s.id === a)!.blockers).toEqual([{ table: 'entry_synonyms', column: 'synonym_id', rows: 1 }]);
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(true);
  });

  it('saved by a user (user_saved_words): kept, the user\'s row intact', async () => {
    const saved = await auto('saved', { published: true });
    const user = await testUser();
    await pool.query(`INSERT INTO user_saved_words (user_id, entry_id) VALUES ($1, $2)`, [user, saved]);
    const result = await executeCleanup(pool, { onlyIds: [saved] });
    expect(result.deleted).toBe(0);
    expect(result.skipped[0]).toMatchObject({ id: saved, published: true, blockers: [{ table: 'user_saved_words', column: 'entry_id', rows: 1 }] });
    expect(await exists(saved)).toBe(true);
    expect(await countWhere(`SELECT count(*)::int AS n FROM user_saved_words WHERE entry_id = $1`, [saved])).toBe(1);
  });

  it('a log of lookups of the entry does NOT hold it back: those rows go with it', async () => {
    const e = await auto('logged', { published: true });
    const user = await testUser();
    await pool.query(`INSERT INTO word_lookups (user_id, entry_id, word_text, source, lookup_result) VALUES ($1, $2, 'x', 'manual_search', 'dictionary')`, [user, e]);
    const result = await executeCleanup(pool, { onlyIds: [e] });
    expect(result.deleted).toBe(1);
    expect(Object.fromEntries(result.cascadeRows.map((r) => [r.table, r.rows])).word_lookups).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the command line', () => {
  const harness = (source: any = pool) => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { source, database: 'host.example / testdb', out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it('without options it is a dry run: it lists, says nothing was deleted, and deletes nothing', async () => {
    const a = await auto('cliDry');
    const b = await auto('cliDry2', { published: true });
    const h = harness();
    expect(await run([], h.deps, { onlyIds: [a, b] })).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('Cơ sở dữ liệu: host.example / testdb');
    expect(text).toContain('SẼ XÓA 2 mục từ (1 trong số đó đang published)');
    const headword = (await pool.query(`SELECT headword FROM dictionary_entries WHERE id = $1`, [a])).rows[0].headword;
    expect(text).toContain(headword); // the headwords are listed
    expect(text).toContain('entry_senses: 2');
    expect(text).toContain('CHƯA XÓA GÌ');
    expect(text).toContain('--confirm');
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(true);
  });

  it('with --confirm it deletes, in one go, and prints what it deleted', async () => {
    const a = await auto('cliDel');
    await addFamily(a, 'clidel');
    const h = harness();
    expect(await run(['--confirm'], h.deps, { onlyIds: [a] })).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('ĐÃ XÓA 1 mục từ');
    expect(text).toContain('Số hàng đã xóa theo ở từng bảng liên quan');
    expect(text).toContain('word_forms: 2');
    expect(text).not.toContain('CHƯA XÓA GÌ');
    expect(await exists(a)).toBe(false);
  });

  it('reports the entries it skipped, with the table that holds them', async () => {
    const e = await auto('cliSkip');
    const lesson = (await pool.query(`INSERT INTO lessons (title) VALUES ($1) RETURNING id`, [`qzq${RUN}cli`])).rows[0].id;
    await pool.query(`INSERT INTO lesson_entries (lesson_id, entry_id) VALUES ($1, $2)`, [lesson, e]);
    const h = harness();
    expect(await run([], h.deps, { onlyIds: [e] })).toBe(0);
    expect(h.out.join('\n')).toMatch(/BỎ QUA 1 mục từ \[auto\] vì còn thứ khác trỏ tới[\s\S]*lesson_entries\.entry_id: 1/);
  });

  it.each([['--confirmed'], ['confirm'], ['--yes'], ['-y'], ['--force'], ['--confirm=true'], ['--CONFIRM']])('an option it does not know (%s) is refused with exit 2, and nothing is deleted', async (flag) => {
    const a = await auto('cliTypo');
    const h = harness();
    expect(await run([flag], h.deps, { onlyIds: [a] })).toBe(2);
    expect(h.err.join('\n')).toContain('Tùy chọn không biết');
    expect(h.out).toEqual([]);
    expect(await exists(a)).toBe(true);
  });

  it('a known flag next to an unknown one is refused too (a typo cannot ride on --confirm)', async () => {
    const a = await auto('cliBoth');
    const h = harness();
    expect(await run(['--confirm', '--all'], h.deps, { onlyIds: [a] })).toBe(2);
    expect(await exists(a)).toBe(true);
  });

  it('a failure is reported with exit 1 and the promise that nothing was deleted', async () => {
    const a = await auto('cliFail');
    const { source } = spySource({ failOnCommit: true });
    const h = harness(source);
    expect(await run(['--confirm'], h.deps, { onlyIds: [a] })).toBe(1);
    expect(h.err.join('\n')).toMatch(/Không xóa gì/);
    expect(await exists(a)).toBe(true);
  });
});

describe('formatPlan', () => {
  it('marks published entries, and says "đã xóa" only for a result', async () => {
    const a = await auto('fmtA', { published: true });
    const b = await auto('fmtB');
    const plan = await previewCleanup(pool, { onlyIds: [a, b] });
    const dry = formatPlan(plan, { database: 'db', confirmed: false }).join('\n');
    expect(dry).toMatch(/\[published\] qzq/);
    expect(dry).toMatch(/\[ẩn\]\s+qzq/);
    expect(dry).toContain('SẼ XÓA 2');
    expect(dry).not.toContain('ĐÃ XÓA');

    const done = formatPlan({ ...plan, deleted: 2 }, { database: 'db', confirmed: true }).join('\n');
    expect(done).toContain('ĐÃ XÓA 2');
    expect(done).not.toContain('CHƯA XÓA GÌ');
  });
});
