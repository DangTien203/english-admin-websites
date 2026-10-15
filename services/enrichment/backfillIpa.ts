import { ADMIN_NOTE_MAX_CHARS, cut, pickWiktionaryIpa, pickWiktionaryUntaggedIpa, selectEntryRows, untaggedIpaNote } from './assemble';
import type { WiktionaryRow } from './types';

/**
 * Backfill of ipa_us for entries the enrichment job created WITHOUT one (docs/lookup-enrichment.md §16, decision 3).
 *
 * Before the "untagged IPA is the last resort" rule, an entry whose Wiktionary IPAs carry no accent tag (ephemeral: the US
 * tag is only on the audio element) was written with ipa_us NULL. This fills it from the same rows, with the same order
 * as the job:  IPA tagged US  →  the first IPA with no tag at all (marked '[ipa-untagged]' in admin_note).
 *
 * Limits, by design:
 *   - only automatic entries ('[auto]' in admin_note) that still have ipa_us NULL, and ONLY unpublished ones
 *     (a published entry is never edited by an automatic tool);
 *   - ipa_uk is never touched; nothing is deleted; no AI and no network: Wiktionary rows from ref_wiktionary_en only;
 *   - every change is written to entry_edit_history (admin_id NULL), in one transaction.
 */

export interface BackfillDb {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface BackfillClient extends BackfillDb {
  release(err?: Error | boolean): void;
}
export interface BackfillPool extends BackfillDb {
  connect(): Promise<BackfillClient>;
}

export type IpaSource = 'tagged_us' | 'untagged';

export interface BackfillItem {
  id: string;
  lemma: string;
  headword: string;
  ipa: string;
  source: IpaSource;
  oldAdminNote: string;
  newAdminNote: string;
}

export interface BackfillPlan {
  /** Automatic entries with ipa_us NULL (published or not). */
  scanned: number;
  items: BackfillItem[];
  /** No usable IPA in Wiktionary: left empty. */
  noIpa: Array<{ id: string; lemma: string }>;
  /** published = true: not touched. */
  skippedPublished: Array<{ id: string; lemma: string }>;
}

export interface PlanOptions {
  db: BackfillDb;
  /** Rows of ref_wiktionary_en for one lemma (lowercase). */
  fetchRows: (lemma: string) => Promise<WiktionaryRow[]>;
  /** Only this lemma. */
  lemma?: string;
  /** Only lemmas starting with this (used by the tests to stay inside their own fixtures). */
  lemmaPrefix?: string;
}

/** `[auto]` entries still missing ipa_us. LIKE brackets are literal characters in PostgreSQL. */
export const CANDIDATES_SQL = `
  SELECT id, lemma, headword, published, admin_note
    FROM dictionary_entries
   WHERE admin_note LIKE '[auto]%' AND ipa_us IS NULL
     AND ($1::text IS NULL OR lower(lemma) = $1::text)
     AND ($2::text IS NULL OR starts_with(lower(lemma), $2::text))
   ORDER BY created_at, id`;

/** Removes "ipa" from the "thiếu tầng B: …" part of an admin_note written by the job (and the part itself when it was the only item). */
export function withoutIpaInTierB(note: string): string {
  const parts = note.split(' · ');
  const stop = parts.findIndex((p) => p.startsWith('ghi chú của Haiku:'));
  const limit = stop < 0 ? parts.length : stop;
  const out: string[] = [];
  parts.forEach((part, i) => {
    if (i < limit && part.startsWith('thiếu tầng B: ')) {
      const items = part.slice('thiếu tầng B: '.length).split(', ').filter((item) => item !== 'ipa');
      if (items.length > 0) out.push(`thiếu tầng B: ${items.join(', ')}`);
      return;
    }
    out.push(part);
  });
  return out.join(' · ');
}

export function noteForUntaggedIpa(note: string): string {
  return cut(`${withoutIpaInTierB(note)} · ${untaggedIpaNote()}`, ADMIN_NOTE_MAX_CHARS);
}

export function noteForTaggedIpa(note: string): string {
  return cut(withoutIpaInTierB(note), ADMIN_NOTE_MAX_CHARS);
}

export async function planIpaBackfill(opts: PlanOptions): Promise<BackfillPlan> {
  const { rows } = await opts.db.query(CANDIDATES_SQL, [opts.lemma?.toLowerCase() ?? null, opts.lemmaPrefix?.toLowerCase() ?? null]);
  const plan: BackfillPlan = { scanned: rows.length, items: [], noIpa: [], skippedPublished: [] };

  for (const row of rows) {
    const id = String(row.id);
    const lemma = String(row.lemma);
    if (row.published === true) {
      plan.skippedPublished.push({ id, lemma });
      continue;
    }
    const entryRows = selectEntryRows(await opts.fetchRows(lemma.toLowerCase()), lemma.toLowerCase());
    const tagged = pickWiktionaryIpa(entryRows, 'us');
    const untagged = tagged ? null : pickWiktionaryUntaggedIpa(entryRows);
    const ipa = tagged ?? untagged;
    if (!ipa) {
      plan.noIpa.push({ id, lemma });
      continue;
    }
    const oldAdminNote = String(row.admin_note ?? '');
    plan.items.push({
      id,
      lemma,
      headword: String(row.headword),
      ipa,
      source: tagged ? 'tagged_us' : 'untagged',
      oldAdminNote,
      newAdminNote: tagged ? noteForTaggedIpa(oldAdminNote) : noteForUntaggedIpa(oldAdminNote),
    });
  }
  return plan;
}

export interface ApplyResult {
  updated: number;
  /** Entries that changed (published, or got an IPA) between the plan and the write. */
  skipped: number;
}

/** Writes the plan in ONE transaction: the entry, then two entry_edit_history lines (ipa_us, admin_note) each. */
export async function applyIpaBackfill(pool: BackfillPool, plan: BackfillPlan): Promise<ApplyResult> {
  const client = await pool.connect();
  let discard = false;
  const result: ApplyResult = { updated: 0, skipped: 0 };
  try {
    await client.query('BEGIN');
    for (const item of plan.items) {
      // The same guards as the plan: still automatic, still unpublished, still without ipa_us.
      const upd = await client.query(
        `UPDATE dictionary_entries
            SET ipa_us = $2, admin_note = $3
          WHERE id = $1::uuid AND ipa_us IS NULL AND published = FALSE AND admin_note LIKE '[auto]%'
          RETURNING id`,
        [item.id, item.ipa, item.newAdminNote]
      );
      if (upd.rows.length === 0) {
        result.skipped++;
        continue;
      }
      await client.query(
        `INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value)
         VALUES ($1::uuid, NULL, 'ipa_us', NULL, $2), ($1::uuid, NULL, 'admin_note', $3, $4)`,
        [item.id, item.ipa, item.oldAdminNote, item.newAdminNote]
      );
      result.updated++;
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      discard = true;
    });
    throw err;
  } finally {
    client.release(discard ? true : undefined);
  }
}
