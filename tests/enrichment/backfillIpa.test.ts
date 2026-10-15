import {
  applyIpaBackfill,
  CANDIDATES_SQL,
  noteForTaggedIpa,
  noteForUntaggedIpa,
  planIpaBackfill,
  withoutIpaInTierB,
  type BackfillClient,
  type BackfillPool,
} from '../../services/enrichment/backfillIpa';
import { IPA_UNTAGGED_MARK } from '../../services/enrichment/assemble';
import type { WiktionaryRow } from '../../services/enrichment/types';
import { wrow } from './fixtures';

const NOTE = '[auto] nguồn: wiktionary, haiku · model: m · job: j1 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · thiếu tầng B: ipa, is_countable · ước tính: cefr_level=C1';

function candidate(over: Partial<{ id: string; lemma: string; headword: string; published: boolean; admin_note: string }> = {}) {
  return { id: 'id-1', lemma: 'ephemeral', headword: 'ephemeral', published: false, admin_note: NOTE, ...over };
}

const rowsFor = (table: Record<string, WiktionaryRow[]>) => jest.fn(async (lemma: string) => table[lemma] ?? []);

describe('withoutIpaInTierB', () => {
  it('drops "ipa" from the list (first position)', () => {
    expect(withoutIpaInTierB(NOTE)).toBe(NOTE.replace('thiếu tầng B: ipa, is_countable', 'thiếu tầng B: is_countable'));
  });

  it('drops "ipa" from the list (last position)', () => {
    expect(withoutIpaInTierB('[auto] a · thiếu tầng B: cefr_level, ipa')).toBe('[auto] a · thiếu tầng B: cefr_level');
  });

  it('when "ipa" was the only item the whole part goes', () => {
    expect(withoutIpaInTierB('[auto] a · thiếu tầng B: ipa · b')).toBe('[auto] a · b');
  });

  it('leaves a note without the tier B part (or without ipa in it) untouched', () => {
    expect(withoutIpaInTierB('[auto] a · thiếu tầng B: etymology')).toBe('[auto] a · thiếu tầng B: etymology');
    expect(withoutIpaInTierB('[auto] a · b')).toBe('[auto] a · b');
  });

  it('does not read inside the notes of Haiku', () => {
    const note = '[auto] a · ghi chú của Haiku: x · thiếu tầng B: ipa · y';
    expect(withoutIpaInTierB(note)).toBe(note);
  });
});

describe('admin_note', () => {
  it('an untagged IPA adds the marker (and drops "ipa" from the missing tier B list)', () => {
    const n = noteForUntaggedIpa(NOTE);
    expect(n).toContain(IPA_UNTAGGED_MARK);
    expect(n).toContain('thiếu tầng B: is_countable');
    expect(n).not.toMatch(/thiếu tầng B: ipa/);
    expect(n.startsWith('[auto]')).toBe(true);
  });

  it('a tagged US IPA does not add the marker', () => {
    expect(noteForTaggedIpa(NOTE)).not.toContain(IPA_UNTAGGED_MARK);
  });

  it('stays within the 4000 characters of the job', () => {
    expect(noteForUntaggedIpa('[auto] ' + 'x'.repeat(5000)).length).toBeLessThanOrEqual(4000);
  });
});

describe('planIpaBackfill', () => {
  const taggedRow = wrow({ word: 'ephemeral', pos: 'adj', sounds: [{ ipa: '/untagged/' }, { ipa: '/tagged-us/', tags: ['US'] }] });
  const untaggedRow = wrow({ word: 'ephemeral', pos: 'adj', sounds: [{ ipa: '[bracket]' }, { ipa: '/first/' }, { ipa: '/second/' }, { tags: ['US'], audio: 'en-us-x.ogg' }] });
  const bareRow = wrow({ word: 'ephemeral', pos: 'adj', sounds: [{ tags: ['US'], audio: 'en-us-x.ogg' }] });

  it('selects automatic entries with ipa_us NULL (the query says so)', () => {
    expect(CANDIDATES_SQL).toContain("admin_note LIKE '[auto]%'");
    expect(CANDIDATES_SQL).toContain('ipa_us IS NULL');
  });

  it('IPA tagged US wins (no marker)', async () => {
    const db = { query: jest.fn(async () => ({ rows: [candidate()] })) };
    const plan = await planIpaBackfill({ db, fetchRows: rowsFor({ ephemeral: [taggedRow] }) });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ lemma: 'ephemeral', ipa: '/tagged-us/', source: 'tagged_us' });
    expect(plan.items[0].newAdminNote).not.toContain(IPA_UNTAGGED_MARK);
  });

  it('no US tag: the FIRST valid untagged IPA, with the marker', async () => {
    const db = { query: jest.fn(async () => ({ rows: [candidate()] })) };
    const plan = await planIpaBackfill({ db, fetchRows: rowsFor({ ephemeral: [untaggedRow] }) });
    expect(plan.items[0]).toMatchObject({ ipa: '/first/', source: 'untagged' });
    expect(plan.items[0].newAdminNote).toContain(IPA_UNTAGGED_MARK);
    expect(plan.items[0].oldAdminNote).toBe(NOTE);
  });

  it('no usable IPA: left empty and reported', async () => {
    const db = { query: jest.fn(async () => ({ rows: [candidate()] })) };
    const plan = await planIpaBackfill({ db, fetchRows: rowsFor({ ephemeral: [bareRow] }) });
    expect(plan.items).toEqual([]);
    expect(plan.noIpa).toEqual([{ id: 'id-1', lemma: 'ephemeral' }]);
  });

  it('no Wiktionary row at all: left empty', async () => {
    const db = { query: jest.fn(async () => ({ rows: [candidate({ lemma: 'zorp' })] })) };
    const plan = await planIpaBackfill({ db, fetchRows: rowsFor({}) });
    expect(plan.noIpa).toHaveLength(1);
  });

  it('a published entry is never planned and its rows are not even read', async () => {
    const db = { query: jest.fn(async () => ({ rows: [candidate({ published: true })] })) };
    const fetchRows = rowsFor({ ephemeral: [untaggedRow] });
    const plan = await planIpaBackfill({ db, fetchRows });
    expect(plan.items).toEqual([]);
    expect(plan.skippedPublished).toEqual([{ id: 'id-1', lemma: 'ephemeral' }]);
    expect(fetchRows).not.toHaveBeenCalled();
  });

  it('uses the same rows as the job: rows that are only a form of another word are ignored', async () => {
    const db = { query: jest.fn(async () => ({ rows: [candidate({ lemma: 'run' })] })) };
    const form = wrow({ word: 'run', pos: 'verb', lemma_of: 'rin', senses: [{ glosses: ['past participle of rin'], tags: ['form-of'], form_of: [{ word: 'rin' }] }], sounds: [{ ipa: '/form-ipa/' }] });
    const real = wrow({ word: 'run', pos: 'verb', sounds: [{ ipa: '/real-ipa/' }] });
    const plan = await planIpaBackfill({ db, fetchRows: rowsFor({ run: [form, real] }) });
    expect(plan.items[0].ipa).toBe('/real-ipa/');
  });

  it('can be limited to one lemma or to a prefix (parameters of the query)', async () => {
    const db = { query: jest.fn(async (_sql: string, _params?: any[]) => ({ rows: [] })) };
    await planIpaBackfill({ db, fetchRows: rowsFor({}), lemma: 'Ephemeral' });
    await planIpaBackfill({ db, fetchRows: rowsFor({}), lemmaPrefix: 'QZQ' });
    expect(db.query.mock.calls[0][1]).toEqual(['ephemeral', null]);
    expect(db.query.mock.calls[1][1]).toEqual([null, 'qzq']);
  });

  it('counts every candidate', async () => {
    const db = { query: jest.fn(async () => ({ rows: [candidate({ id: 'a', lemma: 'a' }), candidate({ id: 'b', lemma: 'b', published: true }), candidate({ id: 'c', lemma: 'c' })] })) };
    const own = (word: string, sounds: any[]) => wrow({ word, pos: 'noun', sounds });
    const plan = await planIpaBackfill({ db, fetchRows: rowsFor({ a: [own('a', [{ ipa: '/a/' }])], c: [own('c', [{ tags: ['US'], audio: 'en-us-c.ogg' }])] }) });
    expect([plan.scanned, plan.items.length, plan.noIpa.length, plan.skippedPublished.length]).toEqual([3, 1, 1, 1]);
  });
});

describe('applyIpaBackfill', () => {
  function fakePool(over: { updateRows?: (params: any[]) => any[]; failOn?: RegExp } = {}) {
    const log: Array<{ sql: string; params?: any[] }> = [];
    const client: BackfillClient & { query: jest.Mock; release: jest.Mock } = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        log.push({ sql: sql.trim(), params });
        if (over.failOn?.test(sql)) throw new Error('boom');
        if (sql.trim().startsWith('UPDATE')) return { rows: over.updateRows ? over.updateRows(params ?? []) : [{ id: params![0] }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool: BackfillPool = { query: client.query, connect: async () => client };
    return { pool, client, log };
  }
  const item = (id: string) => ({ id, lemma: id, headword: id, ipa: `/${id}/`, source: 'untagged' as const, oldAdminNote: '[auto] old', newAdminNote: '[auto] old · [ipa-untagged] x' });
  const plan = (...ids: string[]) => ({ scanned: ids.length, items: ids.map(item), noIpa: [], skippedPublished: [] });

  it('one transaction: BEGIN, UPDATE + history for each entry, COMMIT', async () => {
    const { pool, client, log } = fakePool();
    const r = await applyIpaBackfill(pool, plan('a', 'b'));
    expect(r).toEqual({ updated: 2, skipped: 0 });
    expect(log.map((l) => l.sql.split(/\s+/)[0])).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'UPDATE', 'INSERT', 'COMMIT']);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('the UPDATE only fills ipa_us, only on an unpublished automatic entry that still has none; ipa_uk is not mentioned', async () => {
    const { pool, log } = fakePool();
    await applyIpaBackfill(pool, plan('a'));
    const update = log.find((l) => l.sql.startsWith('UPDATE'))!;
    expect(update.sql).toMatch(/SET ipa_us = \$2, admin_note = \$3/);
    expect(update.sql).toMatch(/ipa_us IS NULL/);
    expect(update.sql).toMatch(/published = FALSE/);
    expect(update.sql).toMatch(/admin_note LIKE '\[auto\]%'/);
    expect(update.sql).not.toMatch(/ipa_uk/);
    expect(update.params).toEqual(['a', '/a/', '[auto] old · [ipa-untagged] x']);
  });

  it('writes entry_edit_history with admin_id NULL: ipa_us (old NULL) and admin_note (old and new)', async () => {
    const { pool, log } = fakePool();
    await applyIpaBackfill(pool, plan('a'));
    const history = log.find((l) => l.sql.startsWith('INSERT INTO entry_edit_history'))!;
    expect(history.sql).toMatch(/\(\$1::uuid, NULL, 'ipa_us', NULL, \$2\)/);
    expect(history.sql).toMatch(/\(\$1::uuid, NULL, 'admin_note', \$3, \$4\)/);
    expect(history.params).toEqual(['a', '/a/', '[auto] old', '[auto] old · [ipa-untagged] x']);
  });

  it('never deletes anything', async () => {
    const { pool, log } = fakePool();
    await applyIpaBackfill(pool, plan('a', 'b'));
    expect(log.some((l) => /\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i.test(l.sql))).toBe(false);
  });

  it('an entry that changed since the plan (the guarded UPDATE matches nothing) is skipped, with no history line', async () => {
    const { pool, log } = fakePool({ updateRows: (p) => (p[0] === 'b' ? [] : [{ id: p[0] }]) });
    const r = await applyIpaBackfill(pool, plan('a', 'b'));
    expect(r).toEqual({ updated: 1, skipped: 1 });
    expect(log.filter((l) => l.sql.startsWith('INSERT INTO entry_edit_history'))).toHaveLength(1);
  });

  it('an error rolls everything back and is rethrown; the connection is returned', async () => {
    const { pool, client, log } = fakePool({ failOn: /INSERT INTO entry_edit_history/ });
    await expect(applyIpaBackfill(pool, plan('a'))).rejects.toThrow('boom');
    expect(log.map((l) => l.sql.split(/\s+/)[0]).slice(-1)).toEqual(['ROLLBACK']);
    expect(log.some((l) => l.sql === 'COMMIT')).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  it('an empty plan still commits nothing harmful', async () => {
    const { pool, log } = fakePool();
    const r = await applyIpaBackfill(pool, plan());
    expect(r).toEqual({ updated: 0, skipped: 0 });
    expect(log.map((l) => l.sql)).toEqual(['BEGIN', 'COMMIT']);
  });
});
