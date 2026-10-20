/**
 * `oxford:apply-cefr`: set cefr_level of the entries the job made ('[auto]') from the Oxford list (docs/lookup-runbook.md §13).
 *
 * Only entries whose admin_note starts with '[auto]' are touched; the other entries of the dictionary never are. The level of an
 * entry is the LOWEST level Oxford gives its word. Every change leaves an entry_edit_history line (field_name = 'cefr_level',
 * admin_id NULL, the old and the new value) and the mark '[oxford-cefr]' is appended to admin_note. An entry that carries the mark is
 * left alone, so a second run changes nothing.
 */
import { AUTO_NOTE_PREFIX, OXFORD_CEFR_MARK } from '../../../utils/autoEntryNote';
import { CEFR_LEVELS, cefrRank, type Cefr, type OxfordWord } from './list';
import type { Queryable } from './plan';

export interface AutoEntryRow {
  id: string;
  headword: string;
  cefr_level: string | null;
  admin_note: string | null;
  published: boolean;
}

export type CefrAction = 'change' | 'agree' | 'already' | 'no_oxford_level';

export interface CefrDecision {
  entry: AutoEntryRow;
  oxford: Cefr | null;
  /** the level Haiku proposed (read back from the history when the entry already carries the mark) */
  haiku: string | null;
  action: CefrAction;
}

export const hasMark = (note: string | null | undefined): boolean => typeof note === 'string' && note.includes(OXFORD_CEFR_MARK);

const CHUNK = 1000;

/** The '[auto]' entries whose headword is one of these words. */
export async function loadAutoEntries(db: Queryable, words: readonly string[]): Promise<AutoEntryRow[]> {
  const out: AutoEntryRow[] = [];
  for (let i = 0; i < words.length; i += CHUNK) {
    const { rows } = await db.query(
      `SELECT id, headword, cefr_level, admin_note, published FROM dictionary_entries
        WHERE admin_note LIKE $1 AND LOWER(headword) = ANY($2::text[]) ORDER BY LOWER(headword), id`,
      [`${AUTO_NOTE_PREFIX}%`, words.slice(i, i + CHUNK).map((w) => w.toLowerCase())]
    );
    out.push(...rows);
  }
  return out;
}

/** The first cefr_level value the entry had when the job wrote it, for entries that already carry the mark. */
async function haikuLevels(db: Queryable, ids: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (entry_id) entry_id, old_value FROM entry_edit_history
        WHERE field_name = 'cefr_level' AND entry_id = ANY($1::uuid[]) AND admin_id IS NULL
        ORDER BY entry_id, created_at ASC, id ASC`,
      [ids.slice(i, i + CHUNK)]
    );
    for (const r of rows) out.set(r.entry_id, r.old_value);
  }
  return out;
}

/** Decides what to do with each entry. Pure given the rows. */
export function decide(entries: readonly AutoEntryRow[], oxford: ReadonlyMap<string, OxfordWord>, originals: ReadonlyMap<string, string | null>): CefrDecision[] {
  return entries.map((entry) => {
    const target = oxford.get(entry.headword.toLowerCase())?.cefr ?? null;
    const marked = hasMark(entry.admin_note);
    // a marked entry whose change was a no-op (Haiku agreed) has no history line: its current level is the original
    const haiku = marked ? (originals.has(entry.id) ? originals.get(entry.id)! : entry.cefr_level) : entry.cefr_level;
    let action: CefrAction;
    if (marked) action = 'already';
    else if (!target) action = 'no_oxford_level';
    else if (entry.cefr_level === target) action = 'agree';
    else action = 'change';
    return { entry, oxford: target, haiku, action };
  });
}

export async function planCefr(db: Queryable, words: readonly OxfordWord[]): Promise<CefrDecision[]> {
  const byWord = new Map(words.map((w) => [w.word, w]));
  const entries = await loadAutoEntries(db, words.map((w) => w.word));
  const marked = entries.filter((e) => hasMark(e.admin_note)).map((e) => e.id);
  return decide(entries, byWord, await haikuLevels(db, marked));
}

// ── the matrix ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Matrix {
  /** haiku level (rows, with '-' for none) → oxford level (columns) → entries */
  cells: Record<string, Record<string, number>>;
  total: number;
  same: number;
  /** Haiku proposed a level one step away, two or more steps away, or none */
  off1: number;
  off2plus: number;
  haikuMissing: number;
  /** Haiku HIGHER (harder) than Oxford / LOWER (easier) */
  haikuHarder: number;
  haikuEasier: number;
}

const KEYS = [...CEFR_LEVELS, '-'] as const;

/** Haiku against Oxford, over the entries that have an Oxford level. */
export function buildMatrix(decisions: readonly CefrDecision[]): Matrix {
  const cells: Matrix['cells'] = {};
  for (const h of KEYS) cells[h] = Object.fromEntries(CEFR_LEVELS.map((o) => [o, 0]));
  const m: Matrix = { cells, total: 0, same: 0, off1: 0, off2plus: 0, haikuMissing: 0, haikuHarder: 0, haikuEasier: 0 };
  for (const d of decisions) {
    if (!d.oxford) continue;
    const h = d.haiku && (CEFR_LEVELS as readonly string[]).includes(d.haiku) ? d.haiku : '-';
    cells[h][d.oxford]++;
    m.total++;
    if (h === '-') m.haikuMissing++;
    else {
      const gap = cefrRank(h) - cefrRank(d.oxford);
      if (gap === 0) m.same++;
      else {
        if (Math.abs(gap) === 1) m.off1++;
        else m.off2plus++;
        if (gap > 0) m.haikuHarder++;
        else m.haikuEasier++;
      }
    }
  }
  return m;
}

export function formatMatrix(m: Matrix): string[] {
  const cols = CEFR_LEVELS.filter((o) => KEYS.some((h) => m.cells[h][o] > 0));
  const rows = KEYS.filter((h) => cols.some((o) => m.cells[h][o] > 0));
  const out: string[] = [];
  out.push(`Haiku (hàng) so với Oxford (cột), ${m.total} mục từ có mức Oxford:`);
  out.push(`         ${cols.map((c) => c.padStart(5)).join('')}   tổng`);
  for (const h of rows) {
    const sum = cols.reduce((s, o) => s + m.cells[h][o], 0);
    out.push(`  ${(h === '-' ? 'không' : h).padEnd(6)} ${cols.map((o) => String(m.cells[h][o]).padStart(5)).join('')}   ${String(sum).padStart(4)}`);
  }
  const pct = (n: number) => (m.total > 0 ? `${((n * 100) / m.total).toFixed(0)}%` : '-');
  out.push(`  trùng ${m.same} (${pct(m.same)}) · lệch 1 bậc ${m.off1} · lệch từ 2 bậc ${m.off2plus} · Haiku không đề xuất ${m.haikuMissing}`);
  out.push(`  Haiku khó hơn Oxford ${m.haikuHarder} · dễ hơn ${m.haikuEasier}`);
  return out;
}

// ── applying ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TxDb extends Queryable {
  release?(err?: Error | boolean): void;
}

export interface Connectable {
  connect(): Promise<TxDb & { release(err?: Error | boolean): void }>;
}

export interface ApplyResult {
  changed: number;
  markedOnly: number;
  alreadyMarked: number;
  noOxfordLevel: number;
}

/**
 * Applies the decisions in ONE transaction. Rows are locked and checked again inside it: an entry that gained the mark in the
 * meantime, or lost its '[auto]' note, is left alone.
 */
export async function applyCefr(source: Connectable, decisions: readonly CefrDecision[]): Promise<ApplyResult> {
  const result: ApplyResult = { changed: 0, markedOnly: 0, alreadyMarked: 0, noOxfordLevel: 0 };
  for (const d of decisions) {
    if (d.action === 'already') result.alreadyMarked++;
    if (d.action === 'no_oxford_level') result.noOxfordLevel++;
  }
  const todo = decisions.filter((d) => d.action === 'change' || d.action === 'agree');
  if (todo.length === 0) return result;

  const client = await source.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const ids = todo.map((d) => d.entry.id).sort();
    const { rows: locked } = await client.query(
      `SELECT id, cefr_level, admin_note FROM dictionary_entries WHERE id = ANY($1::uuid[]) AND admin_note LIKE $2 ORDER BY id FOR UPDATE`,
      [ids, `${AUTO_NOTE_PREFIX}%`]
    );
    const current = new Map(locked.map((r) => [r.id, r]));
    for (const d of todo) {
      const row = current.get(d.entry.id);
      if (!row || hasMark(row.admin_note) || !d.oxford) continue;
      const changes = row.cefr_level !== d.oxford;
      await client.query(`UPDATE dictionary_entries SET cefr_level = $2, admin_note = admin_note || $3, updated_at = NOW() WHERE id = $1`, [
        d.entry.id,
        d.oxford,
        ` · ${OXFORD_CEFR_MARK}`,
      ]);
      if (changes) {
        await client.query(`INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value) VALUES ($1, NULL, 'cefr_level', $2, $3)`, [d.entry.id, row.cefr_level, d.oxford]);
        result.changed++;
      } else {
        result.markedOnly++;
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken ? true : undefined);
  }
}
