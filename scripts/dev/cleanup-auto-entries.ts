/**
 * Removes the dictionary entries that the enrichment job created (the ones the /lookup/review screen lists: admin_note starts with
 * "[auto]", models/AutoEntry.ts). DRY RUN BY DEFAULT.
 *
 *   npx tsx scripts/dev/cleanup-auto-entries.ts            # only LIST what would go: entries, rows per table, how many are published
 *   npx tsx scripts/dev/cleanup-auto-entries.ts --confirm  # delete it, in ONE transaction, and print what was deleted
 *
 * What it will not do:
 *   - touch an entry that is not "[auto]" (the Oxford entries and everything made by hand): the delete itself repeats the test;
 *   - delete an [auto] entry that something else points at. It is REPORTED and SKIPPED when it is in a lesson (lesson_entries),
 *     is the synonym / antonym of ANOTHER entry (entry_synonyms / entry_antonyms), or is referenced by data that is not part of the
 *     entry (saved words, Leitner cards, flashcards, game lists, word families, batches). Skipping can chain: an entry that is the
 *     synonym of a skipped entry is skipped too;
 *   - delete anything with an unknown option on the command line (a typo of --confirm does not run as a confirmation).
 *
 * What goes with a deleted entry (ON DELETE CASCADE, counted per table in the plan): its senses, examples, tags, word forms, idioms,
 * phrasal verbs, collocations, edit history, answer aliases and caches, its own synonym / antonym links, and the lookup log rows that
 * point at it. word_enrichment_jobs.entry_id and the "synonym of" links of other senses are set to NULL (the rows stay).
 *
 * The tables are found in the database catalog, not listed here, so a table added later that points at dictionary_entries is counted,
 * and (unless it is one of the entry's own children) makes the entry be skipped instead of silently emptied.
 */
import 'dotenv/config';
import pool from '../../config/db';
import { AUTO_NOTE_PREFIX } from '../../utils/autoEntryNote';
import { dbLabel, describeDatabase } from '../acceptance/db';

export interface Queryable {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface Connectable {
  connect(): Promise<Queryable & { release(err?: Error | boolean): void }>;
}

// ── what points at an entry ─────────────────────────────────────────────────────────────────────────────────────────────

type DeleteRule = 'CASCADE' | 'SET NULL' | 'NO ACTION' | 'RESTRICT' | 'SET DEFAULT';
const RULES: Record<string, DeleteRule> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

export interface ForeignKey {
  table: string;
  column: string;
  parent: string;
  parentColumn: string;
  rule: DeleteRule;
}

/** Tables that hold the entry's OWN data (or a log of lookups of it): they go with it and never hold it back. */
export const OWN_TABLES: ReadonlySet<string> = new Set([
  'entry_senses',
  'entry_tags',
  'word_forms',
  'entry_idioms',
  'phrasal_verbs',
  'collocations',
  'entry_edit_history',
  'entry_answer_aliases',
  'answer_semantic_cache',
  'word_lookups',
]);

/**
 * The links that belong to the entry on ONE side only: entry_synonyms(entry_id, synonym_id) is the entry's own link when it is the
 * `entry_id`, but when the entry is the `synonym_id` the link belongs to another entry. Value = the column of the owner.
 */
const TWO_SIDED: Record<string, { own: string; other: string }> = {
  entry_synonyms: { own: 'entry_id', other: 'synonym_id' },
  entry_antonyms: { own: 'entry_id', other: 'antonym_id' },
};

const q = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/** Every single-column foreign key of the database, from the catalog. */
export async function loadForeignKeys(db: Queryable): Promise<ForeignKey[]> {
  const { rows } = await db.query(
    `SELECT con.conrelid::regclass::text AS child, ca.attname AS child_col,
            con.confrelid::regclass::text AS parent, pa.attname AS parent_col, con.confdeltype AS rule
       FROM pg_constraint con
       JOIN pg_attribute ca ON ca.attrelid = con.conrelid  AND ca.attnum = con.conkey[1]
       JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
      ORDER BY 1, 2`
  );
  return rows.map((r) => ({ table: r.child, column: r.child_col, parent: r.parent, parentColumn: r.parent_col, rule: RULES[r.rule] ?? 'NO ACTION' }));
}

/**
 * SQL condition ("which rows of `table` are deleted with the entries in $1") built along the CASCADE foreign keys:
 * the entry rows themselves, then every table that points at them with ON DELETE CASCADE, then the tables that point at those.
 * null = the table is not reached by a cascade.
 */
function cascadeCondition(table: string, fks: ForeignKey[], trail: string[] = []): string | null {
  if (table === 'dictionary_entries') return `id = ANY($1::uuid[])`;
  if (trail.includes(table)) return null;
  const parts: string[] = [];
  for (const fk of fks) {
    if (fk.table !== table || fk.rule !== 'CASCADE') continue;
    const parentCond = cascadeCondition(fk.parent, fks, [...trail, table]);
    if (parentCond) parts.push(`${q(fk.column)} IN (SELECT ${q(fk.parentColumn)} FROM ${fk.parent} WHERE ${parentCond})`);
  }
  return parts.length > 0 ? `(${parts.join(' OR ')})` : null;
}

/** Tables reached by a cascade from dictionary_entries, other than dictionary_entries itself. */
function cascadeTables(fks: ForeignKey[]): string[] {
  const seen = new Set<string>(['dictionary_entries']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const fk of fks) if (fk.rule === 'CASCADE' && seen.has(fk.parent) && !seen.has(fk.table)) (seen.add(fk.table), (grew = true));
  }
  seen.delete('dictionary_entries');
  return [...seen].sort();
}

/** The foreign keys straight into dictionary_entries that make an entry be SKIPPED (everything that is not its own data). */
export function blockingKeys(fks: ForeignKey[]): Array<ForeignKey & { owner?: string }> {
  const out: Array<ForeignKey & { owner?: string }> = [];
  for (const fk of fks) {
    if (fk.parent !== 'dictionary_entries' || fk.rule === 'SET NULL' || OWN_TABLES.has(fk.table)) continue;
    const two = TWO_SIDED[fk.table];
    if (two && fk.column === two.own) continue; // the entry's own link: goes with it
    out.push(two && fk.column === two.other ? { ...fk, owner: two.own } : fk);
  }
  return out;
}

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EntryRef {
  id: string;
  headword: string;
  published: boolean;
}

export interface Blocker {
  table: string;
  column: string;
  rows: number;
}

export interface CleanupPlan {
  /** entries whose admin_note starts with "[auto]" (inside the scope) */
  found: number;
  foundPublished: number;
  /** entries that are NOT "[auto]": never touched */
  untouched: number;
  toDelete: EntryRef[];
  toDeletePublished: number;
  skipped: Array<EntryRef & { blockers: Blocker[] }>;
  /** rows that go with the entries (ON DELETE CASCADE), per table, tables with 0 rows left out */
  cascadeRows: Array<{ table: string; rows: number }>;
  /** rows that stay and get NULL (ON DELETE SET NULL), per table and column, from rows that do not go themselves */
  nullRows: Array<{ table: string; column: string; rows: number }>;
}

export interface PlanOptions {
  /** Narrows the scope to these ids (tests). Never widens it: the "[auto]" test applies to them too. */
  onlyIds?: string[];
  /** Lock the entries (FOR UPDATE): needed when the plan is about to be executed in a transaction. */
  lock?: boolean;
}

const AUTO_LIKE = `${AUTO_NOTE_PREFIX}%`;

export async function planCleanup(db: Queryable, opts: PlanOptions = {}): Promise<CleanupPlan> {
  const scope = opts.onlyIds ? `AND id = ANY($2::uuid[])` : '';
  const params: any[] = opts.onlyIds ? [AUTO_LIKE, opts.onlyIds] : [AUTO_LIKE];
  const { rows: autos } = await db.query(
    `SELECT id, headword, published FROM dictionary_entries WHERE admin_note LIKE $1 ${scope} ORDER BY headword, id ${opts.lock ? 'FOR UPDATE' : ''}`,
    params
  );
  const scoped = opts.onlyIds ? await db.query(`SELECT count(*)::int AS n FROM dictionary_entries WHERE id = ANY($1::uuid[])`, [opts.onlyIds]) : await db.query(`SELECT count(*)::int AS n FROM dictionary_entries`);
  const total: number = scoped.rows[0].n;

  const fks = await loadForeignKeys(db);
  const blocking = blockingKeys(fks);

  // Which entries something else points at? Skipping can chain (A is the synonym of B, B is skipped, so A cannot go either): repeat
  // until nobody new is skipped.
  let keep: EntryRef[] = autos.map((r) => ({ id: r.id, headword: r.headword, published: Boolean(r.published) }));
  const blockers = new Map<string, Blocker[]>();
  for (;;) {
    const ids = keep.map((e) => e.id);
    if (ids.length === 0) break;
    const newlyBlocked = new Set<string>();
    for (const fk of blocking) {
      const other = fk.owner ? `AND ${q(fk.owner)} <> ALL($1::uuid[])` : '';
      const { rows } = await db.query(`SELECT ${q(fk.column)} AS id, count(*)::int AS n FROM ${fk.table} WHERE ${q(fk.column)} = ANY($1::uuid[]) ${other} GROUP BY 1`, [ids]);
      for (const r of rows) {
        const list = blockers.get(r.id) ?? [];
        const existing = list.find((b) => b.table === fk.table && b.column === fk.column);
        if (existing) existing.rows = r.n;
        else list.push({ table: fk.table, column: fk.column, rows: r.n });
        blockers.set(r.id, list);
        newlyBlocked.add(r.id);
      }
    }
    if (newlyBlocked.size === 0) break;
    keep = keep.filter((e) => !newlyBlocked.has(e.id));
  }
  const kept = new Set(keep.map((e) => e.id));
  const skipped = autos
    .filter((r) => !kept.has(r.id))
    .map((r) => ({ id: r.id as string, headword: r.headword as string, published: Boolean(r.published), blockers: blockers.get(r.id) ?? [] }));

  // What goes with the entries that stay on the list.
  const ids = keep.map((e) => e.id);
  const cascadeRows: CleanupPlan['cascadeRows'] = [];
  const nullRows: CleanupPlan['nullRows'] = [];
  if (ids.length > 0) {
    for (const table of cascadeTables(fks)) {
      const cond = cascadeCondition(table, fks);
      if (!cond) continue;
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${cond}`, [ids]);
      if (rows[0].n > 0) cascadeRows.push({ table, rows: rows[0].n });
    }
    for (const fk of fks) {
      if (fk.rule !== 'SET NULL' || fk.parent !== 'dictionary_entries') continue;
      // a row that is itself deleted (it belongs to a deleted entry) is not "set to NULL": it is gone
      const gone = cascadeCondition(fk.table, fks);
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${fk.table} WHERE ${q(fk.column)} = ANY($1::uuid[]) ${gone ? `AND NOT ${gone}` : ''}`, [ids]);
      if (rows[0].n > 0) nullRows.push({ table: fk.table, column: fk.column, rows: rows[0].n });
    }
  }

  return {
    found: autos.length,
    foundPublished: autos.filter((r) => r.published).length,
    untouched: Math.max(0, total - autos.length),
    toDelete: keep,
    toDeletePublished: keep.filter((e) => e.published).length,
    skipped,
    cascadeRows,
    nullRows,
  };
}

// ── looking (no change) and doing it ──

/**
 * The dry run: the plan, made inside a READ ONLY transaction (the database itself refuses any write there), rolled back at the end.
 */
export async function previewCleanup(source: Connectable, opts: PlanOptions = {}): Promise<CleanupPlan> {
  const client = await source.connect();
  let broken = false;
  try {
    await client.query('BEGIN READ ONLY');
    const plan = await planCleanup(client, opts);
    await client.query('ROLLBACK');
    return plan;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken ? true : undefined);
  }
}

// ── doing it ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CleanupResult extends CleanupPlan {
  /** dictionary_entries rows the DELETE reported */
  deleted: number;
}

/**
 * Deletes what planCleanup() lists, in ONE transaction: the entries are locked, the plan is made inside the transaction (so what is
 * checked is what is deleted), the DELETE repeats the "[auto]" test and must report exactly the planned number of rows, otherwise
 * everything is rolled back. The per-table numbers are counted just before the DELETE, inside the same transaction.
 */
export async function executeCleanup(source: Connectable, opts: PlanOptions = {}): Promise<CleanupResult> {
  const client = await source.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const plan = await planCleanup(client, { ...opts, lock: true });
    let deleted = 0;
    if (plan.toDelete.length > 0) {
      const res = await client.query(`DELETE FROM dictionary_entries WHERE id = ANY($1::uuid[]) AND admin_note LIKE $2`, [plan.toDelete.map((e) => e.id), AUTO_LIKE]);
      deleted = res.rowCount ?? 0;
      if (deleted !== plan.toDelete.length) throw new Error(`Dự kiến xóa ${plan.toDelete.length} mục từ nhưng DELETE báo ${deleted}: hủy toàn bộ (ROLLBACK)`);
    }
    await client.query('COMMIT');
    return { ...plan, deleted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true; // the state of the transaction is unknown: do not hand this connection back to the pool
    });
    throw err;
  } finally {
    client.release(broken ? true : undefined);
  }
}

// ── the command line ────────────────────────────────────────────────────────────────────────────────────────────────────

export function formatPlan(plan: CleanupPlan | CleanupResult, o: { database: string; confirmed: boolean }): string[] {
  const out: string[] = [];
  const done = 'deleted' in plan;
  out.push(`Cơ sở dữ liệu: ${o.database}`);
  out.push(`Mục từ [auto] (đúng tiêu chí màn /lookup/review: admin_note bắt đầu bằng "${AUTO_NOTE_PREFIX}"): ${plan.found}, trong đó đang published: ${plan.foundPublished}.`);
  out.push(`Không đụng tới ${plan.untouched} mục từ không phải [auto].`);
  out.push('');
  out.push(done ? `ĐÃ XÓA ${(plan as CleanupResult).deleted} mục từ (${plan.toDeletePublished} trong số đó đang published):` : `SẼ XÓA ${plan.toDelete.length} mục từ (${plan.toDeletePublished} trong số đó đang published):`);
  for (const e of plan.toDelete) out.push(`  ${e.published ? '[published]' : '[ẩn]      '} ${e.headword}`);
  if (plan.toDelete.length === 0) out.push('  (không có)');
  out.push('');
  out.push(done ? 'Số hàng đã xóa theo ở từng bảng liên quan (ON DELETE CASCADE):' : 'Số hàng sẽ xóa theo ở từng bảng liên quan (ON DELETE CASCADE):');
  out.push(`  dictionary_entries: ${done ? (plan as CleanupResult).deleted : plan.toDelete.length}`);
  for (const t of plan.cascadeRows) out.push(`  ${t.table}: ${t.rows}`);
  if (plan.cascadeRows.length === 0) out.push('  (bảng liên quan nào cũng 0 hàng)');
  if (plan.nullRows.length > 0) {
    out.push(done ? 'Hàng giữ lại, cột trỏ tới mục từ đã đặt NULL:' : 'Hàng giữ lại, cột trỏ tới mục từ sẽ đặt NULL:');
    for (const t of plan.nullRows) out.push(`  ${t.table}.${t.column}: ${t.rows}`);
  }
  if (plan.skipped.length > 0) {
    out.push('');
    out.push(`BỎ QUA ${plan.skipped.length} mục từ [auto] vì còn thứ khác trỏ tới (không xóa, không đổi gì):`);
    for (const s of plan.skipped) {
      const why = s.blockers.length > 0 ? s.blockers.map((b) => `${b.table}.${b.column}: ${b.rows}`).join(', ') : 'trỏ tới bởi một mục từ khác cũng bị bỏ qua';
      out.push(`  ${s.published ? '[published]' : '[ẩn]      '} ${s.headword}  ← ${why}`);
    }
  }
  out.push('');
  if (!o.confirmed) {
    out.push('CHƯA XÓA GÌ (chạy thử). Để xóa thật: thêm --confirm.');
  }
  return out;
}

const FLAGS = new Set(['--confirm']);

export interface CliDeps {
  source: Connectable;
  database: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 0 ok, 1 failed, 2 wrong usage. Only the exact flag --confirm deletes; anything else on the command line is refused. */
export async function run(argv: string[], deps: CliDeps, opts: PlanOptions = {}): Promise<number> {
  const unknown = argv.filter((a) => !FLAGS.has(a));
  if (unknown.length > 0) {
    deps.err(`Tùy chọn không biết: ${unknown.join(' ')}. Chỉ có --confirm (xóa thật). Không xóa gì.`);
    return 2;
  }
  const confirmed = argv.includes('--confirm');
  try {
    if (!confirmed) {
      const plan = await previewCleanup(deps.source, opts);
      formatPlan(plan, { database: deps.database, confirmed }).forEach(deps.out);
      return 0;
    }
    const result = await executeCleanup(deps.source, opts);
    formatPlan(result, { database: deps.database, confirmed }).forEach(deps.out);
    return 0;
  } catch (e) {
    deps.err(`Lỗi: ${String((e as Error)?.message ?? e)}. Không xóa gì (mọi thay đổi đã hủy).`);
    return 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2), {
    source: pool as unknown as Connectable,
    database: dbLabel(describeDatabase(pool)),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  })
    .then(async (code) => {
      await pool.end().catch(() => undefined);
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('cleanup-auto-entries failed:', String(err?.message ?? err));
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
