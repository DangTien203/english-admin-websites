/**
 * `oxford:apply-cefr` (services/enrichment/oxford/cefr.ts, run.ts) against the real PostgreSQL with entries named "qzq<run>…": the CEFR
 * level of '[auto]' entries is set from the Oxford list (lowest level), with its trace; other entries are never touched; a second run
 * changes nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pool from '../../config/db';
import { applyCefr, buildMatrix, hasMark, planCefr } from '../../services/enrichment/oxford/cefr';
import { parseOxford } from '../../services/enrichment/oxford/list';
import { runApplyCefr } from '../../services/enrichment/oxford/run';
import { OXFORD_CEFR_MARK, parseAutoNote } from '../../utils/autoEntryNote';
import { NOTE_CLEAN, RUN, cleanup, createEntry, fixtureWord } from '../helpers/lookupAdminFixtures';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oxford-cefr-'));
const L = (tag: string): string => tag.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
const word = (tag: string) => fixtureWord(L(tag));

jest.setTimeout(120_000);

beforeAll(async () => {
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
  await cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
  await pool.end();
});

function oxfordFile(name: string, rows: Array<[string, string]>): string {
  const file = path.join(TMP, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(rows.map(([tag, level], id) => ({ id, value: { word: word(tag), type: 'noun', level, us: {}, uk: {}, phonetics: {}, examples: [] } }))));
  return file;
}

const entry = async (id: string) => (await pool.query(`SELECT cefr_level, admin_note, published FROM dictionary_entries WHERE id = $1`, [id])).rows[0];
const history = async (id: string) => (await pool.query(`SELECT admin_id, field_name, old_value, new_value FROM entry_edit_history WHERE entry_id = $1 AND field_name = 'cefr_level' ORDER BY created_at, id`, [id])).rows;
const setLevel = (id: string, level: string | null) => pool.query(`UPDATE dictionary_entries SET cefr_level = $2 WHERE id = $1`, [id, level]);

/** Entries for a scenario; the Oxford file lists them with the given levels (the same word may be listed more than once). */
async function scenario(name: string) {
  const ids = {
    change: await createEntry({ tag: L(`${name}Change`) }),
    agree: await createEntry({ tag: L(`${name}Agree`) }),
    fromNull: await createEntry({ tag: L(`${name}Null`), published: true }),
    manual: await createEntry({ tag: L(`${name}Manual`), adminNote: 'tạo tay, không phải của job' }),
    noNote: await createEntry({ tag: L(`${name}NoNote`), adminNote: null }),
    noLevel: await createEntry({ tag: L(`${name}NoLevel`) }),
    notListed: await createEntry({ tag: L(`${name}NotListed`) }),
  };
  await setLevel(ids.change, 'B2');
  await setLevel(ids.agree, 'B1');
  await setLevel(ids.fromNull, null);
  await setLevel(ids.manual, 'B2');
  await setLevel(ids.noNote, 'B2');
  await setLevel(ids.noLevel, 'B2');
  await setLevel(ids.notListed, 'B2');
  const file = path.join(TMP, `${name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      [
        [`${name}Change`, 'B2'], // two rows, the lowest wins
        [`${name}Change`, 'A2'],
        [`${name}Agree`, 'B1'],
        [`${name}Null`, 'C1'],
        [`${name}Manual`, 'A1'],
        [`${name}NoNote`, 'A1'],
        [`${name}NoLevel`, ' '],
      ].map(([tag, level], id) => ({ id, value: { word: word(tag), type: 'noun', level } }))
    )
  );
  return { ids, file };
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { db: pool as any, source: pool as any, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe('planning', () => {
  it('decides per entry: change, agree (only the mark), already marked, no Oxford level; entries that are not [auto] are not even looked at', async () => {
    const { ids, file } = await scenario('plan');
    const parsed = parseOxford(JSON.parse(fs.readFileSync(file, 'utf8')));
    const decisions = await planCefr(pool as any, parsed.words);
    const by = Object.fromEntries(decisions.map((d) => [d.entry.id, d]));
    expect(by[ids.change]).toMatchObject({ action: 'change', oxford: 'A2', haiku: 'B2' });
    expect(by[ids.agree]).toMatchObject({ action: 'agree', oxford: 'B1', haiku: 'B1' });
    expect(by[ids.fromNull]).toMatchObject({ action: 'change', oxford: 'C1', haiku: null });
    expect(by[ids.noLevel]).toMatchObject({ action: 'no_oxford_level', oxford: null });
    expect(by[ids.manual]).toBeUndefined();
    expect(by[ids.noNote]).toBeUndefined();
    expect(by[ids.notListed]).toBeUndefined();
  });

  it('the matrix counts Haiku against Oxford, with the distance', async () => {
    const { file } = await scenario('matrix');
    const parsed = parseOxford(JSON.parse(fs.readFileSync(file, 'utf8')));
    const decisions = (await planCefr(pool as any, parsed.words)).filter((d) => d.entry.headword.startsWith(word('matrix')));
    const m = buildMatrix(decisions);
    expect(m.total).toBe(3); // change, agree, fromNull (noLevel has no Oxford level)
    expect(m.cells.B2.A2).toBe(1);
    expect(m.cells.B1.B1).toBe(1);
    expect(m.cells['-'].C1).toBe(1);
    expect(m).toMatchObject({ same: 1, off2plus: 1, off1: 0, haikuMissing: 1, haikuHarder: 1, haikuEasier: 0 });
  });
});

describe('--dry-run', () => {
  it('prints the plan and the matrix and changes NOTHING: no level, no note, no history', async () => {
    const { ids, file } = await scenario('dry');
    const h = io();
    expect(await runApplyCefr(['--file', file, '--dry-run'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('CHƯA ĐỔI GÌ');
    expect(text).toContain('Haiku (hàng) so với Oxford (cột)');
    for (const id of Object.values(ids)) {
      const e = await entry(id);
      expect(hasMark(e.admin_note)).toBe(false);
      expect(await history(id)).toEqual([]);
    }
    expect((await entry(ids.change)).cefr_level).toBe('B2');
    expect((await entry(ids.fromNull)).cefr_level).toBeNull();
  });
});

describe('applying', () => {
  it('sets the LOWEST Oxford level on [auto] entries, with a history line (admin_id NULL) and the mark; touches nothing else', async () => {
    const { ids, file } = await scenario('apply');
    const before = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await entry(id)])));
    const h = io();
    expect(await runApplyCefr(['--file', file], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/ĐÃ ÁP DỤNG: đổi mức \d+ · chỉ đánh dấu \d+/);

    const change = await entry(ids.change);
    expect(change.cefr_level).toBe('A2');
    expect(change.admin_note).toBe(`${before.change.admin_note} · ${OXFORD_CEFR_MARK}`);
    expect(await history(ids.change)).toEqual([{ admin_id: null, field_name: 'cefr_level', old_value: 'B2', new_value: 'A2' }]);

    const fromNull = await entry(ids.fromNull);
    expect(fromNull.cefr_level).toBe('C1');
    expect(fromNull.published).toBe(true); // publishing is not this tool's business
    expect(await history(ids.fromNull)).toEqual([{ admin_id: null, field_name: 'cefr_level', old_value: null, new_value: 'C1' }]);

    // Haiku already agreed: the level stays, the mark is added, there is nothing to put in the history
    const agree = await entry(ids.agree);
    expect(agree.cefr_level).toBe('B1');
    expect(hasMark(agree.admin_note)).toBe(true);
    expect(await history(ids.agree)).toEqual([]);

    // not [auto], or no Oxford level, or not in the file: untouched, not even marked
    for (const key of ['manual', 'noNote', 'noLevel', 'notListed'] as const) {
      const after = await entry(ids[key]);
      expect(after.cefr_level).toBe('B2');
      expect(after.admin_note).toBe(before[key].admin_note);
      expect(await history(ids[key])).toEqual([]);
    }
  });

  it('a second run changes nothing (idempotent): same levels, same notes, no new history, and the matrix is still the same', async () => {
    const { ids, file } = await scenario('twice');
    const first = io();
    await runApplyCefr(['--file', file], first.deps);
    const snapshot = async () => JSON.stringify(await Promise.all(Object.values(ids).map(async (id) => [await entry(id), (await history(id)).length])));
    const afterFirst = await snapshot();

    const second = io();
    expect(await runApplyCefr(['--file', file], second.deps)).toBe(0);
    expect(await snapshot()).toBe(afterFirst);
    const text = second.out.join('\n');
    expect(text).toMatch(/sẽ đổi mức: +0/);
    expect(text).toMatch(/đã đánh dấu \[oxford-cefr\]: +3 /);
    // the original Haiku level is read back from the history, so the matrix does not collapse into "all agree"
    expect(text).toMatch(/trùng 1 \(33%\)/);
  });

  it('the mark does not turn into a note of Haiku: the review notes of the entry are the same before and after', async () => {
    const id = await createEntry({ tag: L('markNotes'), adminNote: `${NOTE_CLEAN} · ghi chú của Haiku: Nghĩa 'phố' và 'dãy nhà' có thể gộp, cần kiểm tra lại.` });
    const file = oxfordFile('markNotes', [[L('markNotes'), 'A1']]);
    const before = parseAutoNote((await entry(id)).admin_note).review_notes;
    await runApplyCefr(['--file', file], io().deps);
    const after = parseAutoNote((await entry(id)).admin_note);
    expect(after.review_notes).toEqual(before);
    expect(after.review_notes).toHaveLength(1);
    expect(after.other).toEqual([OXFORD_CEFR_MARK]);
  });

  it('is ONE transaction: if the COMMIT fails, no entry is changed', async () => {
    const { ids, file } = await scenario('atomic');
    const parsed = parseOxford(JSON.parse(fs.readFileSync(file, 'utf8')));
    const decisions = await planCefr(pool as any, parsed.words);
    const failing = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, params?: any[]) => {
            if (/^\s*COMMIT/i.test(sql)) throw new Error('COMMIT failed (test)');
            return client.query(sql, params);
          },
          release: (e?: Error | boolean) => client.release(e),
        };
      },
    };
    await expect(applyCefr(failing as any, decisions)).rejects.toThrow('COMMIT failed');
    expect((await entry(ids.change)).cefr_level).toBe('B2');
    expect(hasMark((await entry(ids.change)).admin_note)).toBe(false);
    expect(await history(ids.change)).toEqual([]);
  });

  it('an entry that gained the mark between the plan and the write is left alone', async () => {
    const { ids, file } = await scenario('race');
    const parsed = parseOxford(JSON.parse(fs.readFileSync(file, 'utf8')));
    const decisions = await planCefr(pool as any, parsed.words);
    await pool.query(`UPDATE dictionary_entries SET admin_note = admin_note || $2 WHERE id = $1`, [ids.change, ` · ${OXFORD_CEFR_MARK}`]);
    const result = await applyCefr(pool as any, decisions);
    expect((await entry(ids.change)).cefr_level).toBe('B2'); // not changed by the stale plan
    expect(result.changed).toBe(1); // only fromNull
  });

  it('with nothing to do it does not even open a transaction', async () => {
    const connect = jest.fn();
    const result = await applyCefr({ connect } as any, []);
    expect(connect).not.toHaveBeenCalled();
    expect(result).toEqual({ changed: 0, markedOnly: 0, alreadyMarked: 0, noOxfordLevel: 0 });
  });
});

describe('usage', () => {
  it('needs --file; an unknown option is refused with exit 2; nothing is changed', async () => {
    const h = io();
    expect(await runApplyCefr([], h.deps)).toBe(2);
    expect(await runApplyCefr(['--file', 'x.json', '--yes'], h.deps)).toBe(2);
    expect(await runApplyCefr(['--confirm'], h.deps)).toBe(2);
    expect(h.out).toEqual([]);
  });
});
