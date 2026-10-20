import { IPA_UNTAGGED_MARK } from '../services/enrichment/assemble';

/**
 * Reads dictionary_entries.admin_note of an entry that the enrichment job created (docs/lookup-spec.md §10.2).
 *
 * The job writes `[auto] ` and then parts joined with ' · ' (buildEntry in services/enrichment/assemble.ts):
 *
 *   nguồn: wiktionary, haiku · model: … · job: <id> · published=false: chờ duyệt (…) · thiếu tầng A: … · thiếu tầng B: a, b
 *   · ước tính: cefr_level=B2 · [ipa-untagged] ipa_us lấy từ … · loại từ của Wiktionary không có trong mục: … · ghi chú của Haiku: x | y
 *
 * Best effort: an admin may have edited the note by hand, and services/enrichment/backfillIpa.ts appends a part after the notes
 * of Haiku. A part that is not recognised is kept in `other`; nothing is thrown away and nothing is invented.
 */

export const AUTO_NOTE_PREFIX = '[auto]';
/** Appended to admin_note by `oxford:apply-cefr` (scripts/enrichment/oxford-apply-cefr.ts): cefr_level now comes from the Oxford list. */
export const OXFORD_CEFR_MARK = '[oxford-cefr]';
const SEP = ' · ';
const NOTES_PREFIX = 'ghi chú của Haiku: ';

export interface ParsedAutoNote {
  is_auto: boolean;
  sources: string[];
  model: string | null;
  job_id: string | null;
  /** "published=false: chờ duyệt …": what the job decided when it wrote the entry (not the current state) */
  publish_note: string | null;
  tier_a_missing: string[];
  tier_b_missing: string[];
  estimated: string[];
  /** notes_for_review of Haiku: what the model was unsure about */
  review_notes: string[];
  /** parts that follow no known format */
  other: string[];
}

/** Parts the job writes itself. After the notes of Haiku, only a part with one of these starts something new. */
const KNOWN_PARTS = ['nguồn: ', 'model: ', 'job: ', 'published=', 'thiếu tầng A: ', 'thiếu tầng B: ', 'ước tính: ', IPA_UNTAGGED_MARK, OXFORD_CEFR_MARK, 'ipa_us lấy từ Free Dictionary', 'loại từ của Wiktionary'];

const list = (text: string, sep = ', ') =>
  text
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);

export function isAutoNote(adminNote: string | null | undefined): boolean {
  return typeof adminNote === 'string' && adminNote.startsWith(AUTO_NOTE_PREFIX);
}

export function parseAutoNote(adminNote: string | null | undefined): ParsedAutoNote {
  const out: ParsedAutoNote = {
    is_auto: isAutoNote(adminNote),
    sources: [],
    model: null,
    job_id: null,
    publish_note: null,
    tier_a_missing: [],
    tier_b_missing: [],
    estimated: [],
    review_notes: [],
    other: [],
  };
  if (!out.is_auto) return out;

  const parts = (adminNote as string).slice(AUTO_NOTE_PREFIX.length).trim().split(SEP);
  let notesText: string | null = null;

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;

    if (notesText !== null && !KNOWN_PARTS.some((k) => part.startsWith(k))) {
      // a note of Haiku that itself contained the separator
      notesText += SEP + part;
      continue;
    }

    if (part.startsWith('nguồn: ')) out.sources = list(part.slice('nguồn: '.length));
    else if (part.startsWith('model: ')) out.model = part.slice('model: '.length).trim() || null;
    else if (part.startsWith('job: ')) out.job_id = part.slice('job: '.length).trim() || null;
    else if (part.startsWith('published=')) out.publish_note = part;
    else if (part.startsWith('thiếu tầng A: ')) out.tier_a_missing = list(part.slice('thiếu tầng A: '.length));
    else if (part.startsWith('thiếu tầng B: ')) out.tier_b_missing = list(part.slice('thiếu tầng B: '.length));
    else if (part.startsWith('ước tính: ')) out.estimated = list(part.slice('ước tính: '.length));
    else if (part.startsWith(NOTES_PREFIX)) notesText = part.slice(NOTES_PREFIX.length);
    else out.other.push(part);
  }

  if (notesText !== null) out.review_notes = list(notesText, ' | ');
  return out;
}
