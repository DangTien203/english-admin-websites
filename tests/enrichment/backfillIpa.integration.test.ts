/**
 * The IPA backfill on a REAL PostgreSQL (the database in .env, like the other suites). Fixture entries are named
 * "qzq<run code><letter>" and are deleted at the end (the edit history goes with them: ON DELETE CASCADE). The Wiktionary rows
 * are crafted and injected, so no real entry is read or touched: the plan is limited to the fixtures with `lemmaPrefix`.
 */
import pool from '../../config/db';
import { IPA_UNTAGGED_MARK } from '../../services/enrichment/assemble';
import { applyIpaBackfill, planIpaBackfill } from '../../services/enrichment/backfillIpa';
import type { WiktionaryRow } from '../../services/enrichment/types';
import { wrow } from './fixtures';

jest.setTimeout(60_000);

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const PREFIX = `qzq${RUN}`;
const lemma = (letter: string) => `${PREFIX}${letter}`;

const AUTO_NOTE = '[auto] nguồn: wiktionary, haiku · model: m · job: j · published=false: chờ duyệt · thiếu tầng B: ipa, etymology · ước tính: cefr_level=B2';

async function insertEntry(letter: string, o: { published?: boolean; note?: string | null; ipaUs?: string | null; ipaUk?: string | null }): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, source, published, admin_note, ipa_us, ipa_uk)
     VALUES ($1, $1, ARRAY['noun']::varchar[], 'nghĩa thử', 'wiktionary', $2, $3, $4, $5) RETURNING id`,
    [lemma(letter), o.published ?? false, o.note === undefined ? AUTO_NOTE : o.note, o.ipaUs ?? null, o.ipaUk ?? null]
  );
  return rows[0].id as string;
}

const entry = async (id: string) => (await pool.query('SELECT ipa_us, ipa_uk, admin_note, published FROM dictionary_entries WHERE id = $1', [id])).rows[0];
const history = async (id: string) => (await pool.query('SELECT field_name, old_value, new_value, admin_id FROM entry_edit_history WHERE entry_id = $1 ORDER BY field_name', [id])).rows;

const WIKTIONARY: Record<string, WiktionaryRow[]> = {
  [lemma('a')]: [wrow({ word: lemma('a'), pos: 'noun', sounds: [{ ipa: '/first-untagged/' }, { ipa: '/second-untagged/' }, { tags: ['US'], audio: 'en-us-a.ogg' }] })],
  [lemma('b')]: [wrow({ word: lemma('b'), pos: 'noun', sounds: [{ ipa: '/untagged-b/' }, { ipa: '/us-b/', tags: ['US'] }] })],
  [lemma('c')]: [wrow({ word: lemma('c'), pos: 'noun', sounds: [{ ipa: '/c/' }] })],
  [lemma('d')]: [wrow({ word: lemma('d'), pos: 'noun', sounds: [{ ipa: '/d/' }] })],
  [lemma('e')]: [wrow({ word: lemma('e'), pos: 'noun', sounds: [{ ipa: '/e-new/' }] })],
  [lemma('f')]: [wrow({ word: lemma('f'), pos: 'noun', sounds: [{ tags: ['US'], audio: 'en-us-f.ogg' }] })],
  [lemma('g')]: [wrow({ word: lemma('g'), pos: 'noun', sounds: [{ ipa: '/g-uk/', tags: ['Received-Pronunciation'] }, { ipa: '/g-bare/' }] })],
};
const fetchRows = async (l: string) => WIKTIONARY[l] ?? [];

const ids: Record<string, string> = {};

beforeAll(async () => {
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  ids.a = await insertEntry('a', {}); // untagged only
  ids.b = await insertEntry('b', {}); // a US-tagged IPA exists
  ids.c = await insertEntry('c', { published: true }); // published: never touched
  ids.d = await insertEntry('d', { note: 'nhập tay, không phải tự động' }); // not automatic
  ids.e = await insertEntry('e', { ipaUs: '/already/' }); // already has ipa_us
  ids.f = await insertEntry('f', {}); // no IPA anywhere
  ids.g = await insertEntry('g', { ipaUk: '/kept-uk/' }); // has ipa_uk, lacks ipa_us
});

afterAll(async () => {
  await pool.query(`DELETE FROM dictionary_entries WHERE lemma LIKE $1`, [`${PREFIX}%`]);
});

describe('enrich:backfill-ipa on the real database', () => {
  it('the plan (= the dry run) writes NOTHING', async () => {
    const before = await Promise.all(Object.values(ids).map(entry));
    const plan = await planIpaBackfill({ db: pool, fetchRows, lemmaPrefix: PREFIX });
    const after = await Promise.all(Object.values(ids).map(entry));
    expect(after).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS n FROM entry_edit_history WHERE entry_id = ANY($1::uuid[])', [Object.values(ids)])).rows[0].n).toBe(0);

    // only the automatic, unpublished entries that lack ipa_us are candidates: a, b, c (published), f, g
    expect(plan.scanned).toBe(5);
    expect(plan.items.map((i) => i.lemma).sort()).toEqual([lemma('a'), lemma('b'), lemma('g')]);
    expect(plan.noIpa.map((e) => e.lemma)).toEqual([lemma('f')]);
    expect(plan.skippedPublished.map((e) => e.lemma)).toEqual([lemma('c')]);
  });

  it('--confirm: US-tagged IPA, else the first untagged one with the marker; nothing else is touched', async () => {
    const plan = await planIpaBackfill({ db: pool, fetchRows, lemmaPrefix: PREFIX });
    const result = await applyIpaBackfill(pool as any, plan);
    expect(result).toEqual({ updated: 3, skipped: 0 });

    // a: no US tag → the FIRST untagged IPA, marked
    const a = await entry(ids.a);
    expect(a.ipa_us).toBe('/first-untagged/');
    expect(a.admin_note).toContain(IPA_UNTAGGED_MARK);
    expect(a.admin_note.startsWith('[auto]')).toBe(true);
    expect(a.admin_note).toContain('thiếu tầng B: etymology');
    expect(a.admin_note).not.toMatch(/thiếu tầng B: ipa/);
    expect(a.published).toBe(false);

    // b: a US tag exists → it is used, no marker
    const b = await entry(ids.b);
    expect(b.ipa_us).toBe('/us-b/');
    expect(b.admin_note).not.toContain(IPA_UNTAGGED_MARK);

    // g: ipa_uk is left exactly as it was; only ipa_us is filled
    const g = await entry(ids.g);
    expect([g.ipa_us, g.ipa_uk]).toEqual(['/g-bare/', '/kept-uk/']);

    // untouched: published, manual, already has an IPA, no IPA available
    expect((await entry(ids.c)).ipa_us).toBeNull();
    expect((await entry(ids.c)).admin_note).toBe(AUTO_NOTE);
    expect((await entry(ids.d)).ipa_us).toBeNull();
    expect((await entry(ids.d)).admin_note).toBe('nhập tay, không phải tự động');
    expect((await entry(ids.e)).ipa_us).toBe('/already/');
    expect((await entry(ids.f)).ipa_us).toBeNull();
    expect((await entry(ids.f)).admin_note).toBe(AUTO_NOTE);
  });

  it('entry_edit_history: ipa_us and admin_note lines, admin_id NULL, only for the entries that changed', async () => {
    const h = await history(ids.a);
    expect(h.map((r) => r.field_name)).toEqual(['admin_note', 'ipa_us']);
    expect(h.every((r) => r.admin_id === null)).toBe(true);
    const ipa = h.find((r) => r.field_name === 'ipa_us')!;
    expect([ipa.old_value, ipa.new_value]).toEqual([null, '/first-untagged/']);
    const note = h.find((r) => r.field_name === 'admin_note')!;
    expect(note.old_value).toBe(AUTO_NOTE);
    expect(note.new_value).toContain(IPA_UNTAGGED_MARK);

    for (const untouched of ['c', 'd', 'e', 'f']) expect(await history(ids[untouched])).toEqual([]);
  });

  it('the entries can be listed by the marker', async () => {
    const { rows } = await pool.query(`SELECT lemma FROM dictionary_entries WHERE lemma LIKE $1 AND admin_note LIKE '%[ipa-untagged]%' ORDER BY lemma`, [`${PREFIX}%`]);
    expect(rows.map((r) => r.lemma)).toEqual([lemma('a'), lemma('g')]);
  });

  it('running it again changes nothing (idempotent)', async () => {
    const again = await planIpaBackfill({ db: pool, fetchRows, lemmaPrefix: PREFIX });
    expect(again.items).toEqual([]);
    expect(again.scanned).toBe(2); // only c (published) and f (no IPA) are left; d is not automatic; a, b, g are done
    expect(again.noIpa.map((e) => e.lemma)).toEqual([lemma('f')]);
    expect(again.skippedPublished.map((e) => e.lemma)).toEqual([lemma('c')]);
  });

  it('applying a STALE plan changes nothing either: the guards in the UPDATE hold', async () => {
    const stale = {
      scanned: 1,
      noIpa: [],
      skippedPublished: [],
      items: [
        { id: ids.a, lemma: lemma('a'), headword: lemma('a'), ipa: '/overwrite/', source: 'untagged' as const, oldAdminNote: '', newAdminNote: '[auto] overwritten' }, // already has ipa_us now
        { id: ids.c, lemma: lemma('c'), headword: lemma('c'), ipa: '/overwrite/', source: 'untagged' as const, oldAdminNote: '', newAdminNote: '[auto] overwritten' }, // published
        { id: ids.d, lemma: lemma('d'), headword: lemma('d'), ipa: '/overwrite/', source: 'untagged' as const, oldAdminNote: '', newAdminNote: '[auto] overwritten' }, // not automatic
      ],
    };
    const result = await applyIpaBackfill(pool as any, stale);
    expect(result).toEqual({ updated: 0, skipped: 3 });
    expect((await entry(ids.a)).ipa_us).toBe('/first-untagged/');
    expect((await entry(ids.c)).ipa_us).toBeNull();
    expect((await entry(ids.d)).ipa_us).toBeNull();
    expect((await history(ids.a)).length).toBe(2);
  });
});
