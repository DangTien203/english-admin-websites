/**
 * `enrich:publish`: publish, from the command line, the entries the job made, by the SAME rule as the "publish in bulk" button of
 * /lookup/review (docs/lookup-admin.md §3.4): made by the job ('[auto]'), not published yet, tier A complete, and no note of Haiku
 * that needs a look (services/lookup/reviewNotes.ts). Nothing is published unless the caller asks (--confirm).
 *
 * The rule is not copied: tierAMissing, tierAFactsFor, parseAutoNote and blockingReviewNotes are the very functions that
 * services/lookup/adminService.ts uses for `eligible_for_bulk_publish`. tests/enrichment/oxfordPublish.integration.test.ts checks that the
 * two answers agree.
 *
 * Every published entry gets an entry_edit_history line: field_name = 'published', admin_id NULL, old_value 'false', new_value 'true (cli)'.
 *
 * --accept-notes: the caller may accept whole categories of "needs a look" notes (a person has read them). An entry whose blocking notes
 * are ALL in the accepted categories is published, and its history line says which ones it went through with:
 * 'true (cli, accepted: meaning_doubt,validator_flag)'. Tier A is never waived, and a note of a category that was not named still holds.
 */
import { tierAFactsFor } from '../../../models/AutoEntry';
import { tierAMissing } from '../../lookup/adminRules';
import { blockingReviewNotes, type ClassifiedNote, type ReviewNoteCategoryId } from '../../lookup/reviewNotes';
import { AUTO_NOTE_PREFIX, parseAutoNote } from '../../../utils/autoEntryNote';
import type { Cefr } from './list';
import type { Queryable } from './plan';

export const DEFAULT_PUBLISH_LIMIT = 500;
export const MAX_PUBLISH_LIMIT = 5000;
export const CLI_PUBLISH_VALUE = 'true (cli)';

export interface PublishCandidate {
  id: string;
  headword: string;
  cefr_level: string | null;
  admin_note: string | null;
  /** only set when the entry has blocking notes that the caller accepted: their categories */
  accepted?: ReviewNoteCategoryId[];
}

/** The value of the history line: 'true (cli)', or 'true (cli, accepted: <categories>)' when notes were accepted for the entry. */
export function publishedValue(accepted?: readonly string[]): string {
  return accepted && accepted.length > 0 ? `true (cli, accepted: ${[...accepted].sort().join(',')})` : CLI_PUBLISH_VALUE;
}

export interface PublishSkip {
  id: string;
  headword: string;
  reason: 'tier_a_incomplete' | 'has_review_notes';
  tier_a_missing?: string[];
  blocking?: Array<Pick<ClassifiedNote, 'text' | 'category' | 'label'>>;
}

export interface PublishPlan {
  /** '[auto]' entries that are not published (and match --cefr) */
  candidates: number;
  /** every eligible entry, in publishing order (CEFR, then headword) */
  eligible: PublishCandidate[];
  skipped: PublishSkip[];
  /** what this run would publish: the first `limit` eligible */
  selected: PublishCandidate[];
}

const CHUNK = 1000;
const LEVEL_ORDER_SQL = `CASE cefr_level WHEN 'A1' THEN 1 WHEN 'A2' THEN 2 WHEN 'B1' THEN 3 WHEN 'B2' THEN 4 WHEN 'C1' THEN 5 WHEN 'C2' THEN 6 ELSE 7 END`;

/** Decides, for the given entries, who may be published. Reads the child tables in batches. */
export async function evaluate(
  db: Queryable,
  entries: readonly PublishCandidate[],
  accept: readonly ReviewNoteCategoryId[] = []
): Promise<{ eligible: PublishCandidate[]; skipped: PublishSkip[] }> {
  const accepted = new Set<string>(accept);
  const facts = new Map<string, any>();
  for (let i = 0; i < entries.length; i += CHUNK) {
    const part = await tierAFactsFor(db, entries.slice(i, i + CHUNK).map((e) => e.id));
    for (const [id, f] of part) facts.set(id, f);
  }
  const eligible: PublishCandidate[] = [];
  const skipped: PublishSkip[] = [];
  for (const e of entries) {
    const missing = facts.has(e.id) ? tierAMissing(facts.get(e.id)) : ['headword'];
    if (missing.length > 0) {
      skipped.push({ id: e.id, headword: e.headword, reason: 'tier_a_incomplete', tier_a_missing: missing });
      continue;
    }
    const all = blockingReviewNotes(parseAutoNote(e.admin_note).review_notes);
    const blocking = all.filter((n) => !accepted.has(n.category));
    if (blocking.length > 0) {
      skipped.push({ id: e.id, headword: e.headword, reason: 'has_review_notes', blocking: blocking.map(({ text, category, label }) => ({ text, category, label })) });
      continue;
    }
    eligible.push(all.length > 0 ? { ...e, accepted: [...new Set(all.map((n) => n.category))] } : e);
  }
  return { eligible, skipped };
}

export async function planPublish(db: Queryable, o: { cefr?: readonly Cefr[]; limit?: number; accept?: readonly ReviewNoteCategoryId[] } = {}): Promise<PublishPlan> {
  const limit = o.limit ?? DEFAULT_PUBLISH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PUBLISH_LIMIT) throw new Error(`--limit must be a whole number from 1 to ${MAX_PUBLISH_LIMIT}`);
  const params: any[] = [`${AUTO_NOTE_PREFIX}%`];
  let cefrSql = '';
  if (o.cefr && o.cefr.length > 0) {
    params.push([...o.cefr]);
    cefrSql = `AND cefr_level = ANY($2::text[])`;
  }
  const { rows } = await db.query(
    `SELECT id, headword, cefr_level, admin_note FROM dictionary_entries
      WHERE admin_note LIKE $1 AND published = FALSE ${cefrSql}
      ORDER BY ${LEVEL_ORDER_SQL}, LOWER(headword), id`,
    params
  );
  const { eligible, skipped } = await evaluate(db, rows, o.accept);
  return { candidates: rows.length, eligible, skipped, selected: eligible.slice(0, limit) };
}

export interface TxDb extends Queryable {
  release?(err?: Error | boolean): void;
}
export interface Connectable {
  connect(): Promise<TxDb & { release(err?: Error | boolean): void }>;
}

export interface PublishResult {
  published: Array<{ id: string; headword: string }>;
  /** chosen by the plan but no longer eligible once the rows were locked (changed meanwhile) */
  dropped: PublishSkip[];
}

/**
 * Publishes the selected entries in ONE transaction. Rows are locked and the rule is applied AGAIN to what is locked, so an entry
 * edited (or published by someone else) between the plan and the commit is left alone. Either every history line is written with its
 * UPDATE or nothing is.
 */
export async function publishSelected(
  source: Connectable,
  selected: readonly PublishCandidate[],
  o: { accept?: readonly ReviewNoteCategoryId[] } = {}
): Promise<PublishResult> {
  if (selected.length === 0) return { published: [], dropped: [] };
  const client = await source.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const ids = selected.map((e) => e.id).sort();
    const { rows: locked } = await client.query(
      `SELECT id, headword, cefr_level, admin_note FROM dictionary_entries
        WHERE id = ANY($1::uuid[]) AND admin_note LIKE $2 AND published = FALSE ORDER BY id FOR UPDATE`,
      [ids, `${AUTO_NOTE_PREFIX}%`]
    );
    const { eligible, skipped } = await evaluate(client, locked, o.accept);
    const changed = eligible.length
      ? (await client.query(`UPDATE dictionary_entries SET published = TRUE, updated_at = NOW() WHERE id = ANY($1::uuid[]) AND published = FALSE RETURNING id`, [eligible.map((e) => e.id)])).rows.map((r) => r.id as string)
      : [];
    if (changed.length > 0) {
      const doneIds = new Set(changed);
      const lines = eligible.filter((e) => doneIds.has(e.id));
      await client.query(
        `INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value)
         SELECT t.id, NULL, 'published', 'false', t.val FROM UNNEST($1::uuid[], $2::text[]) AS t(id, val)`,
        [lines.map((e) => e.id), lines.map((e) => publishedValue(e.accepted))]
      );
    }
    await client.query('COMMIT');
    const done = new Set(changed);
    return { published: eligible.filter((e) => done.has(e.id)).map((e) => ({ id: e.id, headword: e.headword })), dropped: skipped };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken ? true : undefined);
  }
}
