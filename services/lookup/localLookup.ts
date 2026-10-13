import { FULL_ENTRY_SQL } from '../../utils/entryQueries';
import type { Db } from './types';

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
 */
export async function lookupLocal(db: Db, word: string): Promise<LocalHit | null> {
  const { rows } = await db.query(
    `${FULL_ENTRY_SQL}
     WHERE e.published = TRUE
       AND (LOWER(e.headword) = $1
            OR LOWER(e.lemma) = $1
            OR e.id IN (SELECT wf.entry_id FROM word_forms wf WHERE LOWER(wf.form_value) = $1))
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

/** Collects tags from a reduced Wiktionary row: data.tags and data.senses[].tags (shape assumed for P4). */
function tagsOf(data: any): string[] {
  const out: string[] = [];
  const add = (v: unknown) => Array.isArray(v) && v.forEach((x) => typeof x === 'string' && out.push(x));
  add(data?.tags);
  if (Array.isArray(data?.senses)) data.senses.forEach((s: any) => add(s?.tags));
  return out;
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
    const tags = refRows.filter((r) => String(r.lemma_of).toLowerCase() === lemma).flatMap((r) => tagsOf(r.data));
    return { entry: local.entry, matchedForm: word, lemma, formType: inferFormType(tags) };
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
