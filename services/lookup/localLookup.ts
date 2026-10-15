import { FULL_ENTRY_SQL } from '../../utils/entryQueries';
import type { Db } from './types';
import { isNonStandardSense, targetsOf } from './wiktionaryTags';

/**
 * Local (database) part of the fast path — docs/lookup-spec.md §5 F4 and F4b. No external calls.
 */

export interface LocalHit {
  entry: any;
  /** Set when the word matched through word_forms (or a local inflection table), not headword/lemma. */
  matchedForm?: string;
}

/**
 * F4: published entry matching headword, lemma or any word_forms.form_value (case-insensitive).
 * headword beats lemma beats form when several entries match.
 *
 * The three ways to match are a UNION of three index lookups, not an OR inside one WHERE: with an OR, PostgreSQL cannot use the
 * lower(headword) / lower(lemma) indexes (a hashed sub-plan in an OR branch is not indexable), so it reads EVERY entry for EVERY
 * lookup. Measured with 200,000 entries: 42–56 ms per lookup with the OR, 0.1 ms with the UNION; at the 852 entries of today both
 * are under a millisecond (docs/lookup-loadtest.md §3). Same rows, same order.
 */
export async function lookupLocal(db: Db, word: string): Promise<LocalHit | null> {
  const { rows } = await db.query(
    `${FULL_ENTRY_SQL}
     WHERE e.published = TRUE
       AND e.id IN (SELECT id FROM dictionary_entries WHERE LOWER(headword) = $1
                    UNION
                    SELECT id FROM dictionary_entries WHERE LOWER(lemma) = $1
                    UNION
                    SELECT wf.entry_id FROM word_forms wf WHERE LOWER(wf.form_value) = $1)
     ORDER BY CASE WHEN LOWER(e.headword) = $1 THEN 0 WHEN LOWER(e.lemma) = $1 THEN 1 ELSE 2 END
     LIMIT 1`,
    [word]
  );
  if (rows.length === 0) return null;

  const entry = rows[0];
  const viaHeadwordOrLemma = String(entry.headword ?? '').toLowerCase() === word || String(entry.lemma ?? '').toLowerCase() === word;
  if (viaHeadwordOrLemma) return { entry };

  const form = (Array.isArray(entry.word_forms) ? entry.word_forms : []).find((f: any) => String(f?.form_value ?? '').toLowerCase() === word);
  return { entry, matchedForm: form?.form_value ?? word };
}

export interface FormHit extends LocalHit {
  matchedForm: string;
  lemma: string;
  /** word_forms.form_type for this inflection, or null when it cannot be told from the reference data. */
  formType: string | null;
}

/** The 9 values word_forms.form_type accepts (CHECK constraint, migration 01). */
export const FORM_TYPES = [
  'base',
  'third_person_singular',
  'past_simple',
  'past_participle',
  'present_participle',
  'plural',
  'possessive',
  'comparative',
  'superlative',
] as const;
export type FormType = (typeof FORM_TYPES)[number];

/**
 * Maps Wiktionary (kaikki) tags to a word_forms.form_type. Wiktionary tags the form entry's senses,
 * e.g. ['past'], ['past','participle'], ['present','participle'], ['third-person','singular'], ['plural'].
 * Returns null when the tags do not identify one of the 9 allowed types (nothing is guessed).
 */
export function inferFormType(tags: readonly string[]): FormType | null {
  const t = new Set(tags.map((x) => String(x).toLowerCase()));
  if (t.has('third-person') && t.has('singular')) return 'third_person_singular';
  if (t.has('present') && t.has('participle')) return 'present_participle';
  if (t.has('past') && t.has('participle')) return 'past_participle';
  if (t.has('past')) return 'past_simple';
  if (t.has('comparative')) return 'comparative';
  if (t.has('superlative')) return 'superlative';
  if (t.has('possessive')) return 'possessive';
  if (t.has('plural')) return 'plural';
  return null;
}

/**
 * Tags that describe how `lemma` relates to the word, taken from ONE sense of a reduced row (shape produced by
 * scripts/refdata, verified on the real dump): the first STANDARD sense whose form_of / alt_of points to the lemma.
 * Mixing the tags of all senses is wrong: the row for "ran" has a sense "past of run", a sense "past of rin" and a
 * colloquial NONSTANDARD "past participle of run" — the union of their tags reads as a past participle.
 * Falls back to a non-standard sense, then to the row's own tags, when no standard sense qualifies.
 */
export function tagsForLemma(data: any, lemma: string): string[] {
  const senses: any[] = Array.isArray(data?.senses) ? data.senses : [];
  const pointing = senses.filter((s) => targetsOf(s).includes(lemma));
  const chosen = pointing.find((s) => !isNonStandardSense(s)) ?? pointing[0];
  if (chosen) return Array.isArray(chosen.tags) ? chosen.tags.filter((t: unknown) => typeof t === 'string') : [];
  return Array.isArray(data?.tags) ? data.tags.filter((t: unknown) => typeof t === 'string') : [];
}

/**
 * F4b: the word is an inflected form of a lemma according to ref_wiktionary_en (lemma_of IS NOT NULL).
 * If a published entry exists for that lemma, return it with the matched form. Errors (e.g. the ref
 * tables are missing or empty) are swallowed by the caller: this step is optional by design.
 */
export async function resolveViaForms(db: Db, refDb: Db, word: string): Promise<FormHit | null> {
  const { rows: refRows } = await refDb.query(
    `SELECT lemma_of, data FROM ref_wiktionary_en WHERE word = $1 AND lemma_of IS NOT NULL LIMIT 20`,
    [word]
  );
  if (refRows.length === 0) return null; // table empty or word unknown: skip silently

  const lemmas = [...new Set(refRows.map((r) => String(r.lemma_of).toLowerCase()).filter((l) => l && l !== word))];
  for (const lemma of lemmas) {
    const local = await lookupLocal(db, lemma);
    if (!local) continue;
    // First row that points to this lemma and yields a recognizable type (rows come in dump order).
    let formType: FormType | null = null;
    for (const row of refRows.filter((r) => String(r.lemma_of).toLowerCase() === lemma)) {
      formType = inferFormType(tagsForLemma(row.data, lemma));
      if (formType) break;
    }
    return { entry: local.entry, matchedForm: word, lemma, formType };
  }
  return null;
}

/**
 * Remembers "<word> is a form of <entry>" so the next lookup is a plain F4 hit. Idempotent
 * (ON CONFLICT DO NOTHING). Does nothing when the form type is unknown or equals headword/lemma.
 */
export async function recordForm(db: Db, hit: FormHit): Promise<void> {
  if (!hit.formType) return;
  const w = hit.matchedForm.toLowerCase();
  if (String(hit.entry.headword ?? '').toLowerCase() === w || String(hit.entry.lemma ?? '').toLowerCase() === w) return;

  await db.query(
    `INSERT INTO word_forms (entry_id, form_type, form_value)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [hit.entry.id, hit.formType, hit.matchedForm]
  );
}

/** §7 "trusted word": known to the local Wiktionary dump or the frequency list. */
export async function isKnownInReferenceData(refDb: Db, word: string): Promise<boolean> {
  const { rows: w } = await refDb.query(`SELECT 1 FROM ref_wiktionary_en WHERE word = $1 LIMIT 1`, [word]);
  if (w.length > 0) return true;
  const { rows: f } = await refDb.query(`SELECT 1 FROM ref_word_frequency WHERE word = $1 LIMIT 1`, [word]);
  return f.length > 0;
}
