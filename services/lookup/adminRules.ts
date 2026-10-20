/**
 * Pure rules of the lookup / enrichment admin pages (P8). No database, no clock, no network: everything here is decided from
 * values that the caller already loaded, so the rules can be tested without a server.
 *
 *   - who may do what (docs/lookup-spec.md §12.6),
 *   - which failed jobs may be sent again,
 *   - tier A of a new entry (docs/lookup-spec.md §3), which decides bulk publishing,
 *   - the Vietnamese meanings of a sense, split for quick review, with the flags a reviewer looks for,
 *   - the colour level of a usage meter.
 */

// ── roles (docs/lookup-spec.md §12.6) ──────────────────────────────────────────────────────────────────────────────────

export type AdminRole = 'super_admin' | 'content_editor' | 'moderator';

/** Everybody with an admin account may look at the pages and read the data. */
export const LOOKUP_ADMIN_READ_ROLES: readonly AdminRole[] = ['super_admin', 'content_editor', 'moderator'];
/** Only these may change anything (send jobs, retry, publish, hide). A moderator is read-only. */
export const LOOKUP_ADMIN_WRITE_ROLES: readonly AdminRole[] = ['super_admin', 'content_editor'];

export function canWriteLookupAdmin(role: string | undefined | null): boolean {
  return LOOKUP_ADMIN_WRITE_ROLES.includes(role as AdminRole);
}

/**
 * Who may change `published` of a dictionary entry, wherever they do it: the publish / hide buttons of the review pages, the
 * "Published" box of the entry editor (/dictionary/:id/edit). The same two roles as the write side of the review pages, so the
 * editor cannot be used to get around a 403 of the API (P9). Others keep editing the other fields.
 */
export const PUBLISH_ROLES: readonly AdminRole[] = LOOKUP_ADMIN_WRITE_ROLES;

export function canChangePublished(role: string | undefined | null): boolean {
  return PUBLISH_ROLES.includes(role as AdminRole);
}

// ── limits ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_WORDS_PER_REQUEST = 50;
export const MAX_BULK_PUBLISH = 100;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

// ── jobs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'rejected', 'failed', 'skipped'] as const;

/** A job that stopped because of something outside the word itself; sending it again may succeed. */
export const RETRYABLE_STATUSES: readonly string[] = ['failed', 'skipped'];
export const RETRYABLE_REASONS: readonly string[] = ['upstream_error', 'budget', 'daily_cap', 'stale', 'queue_error', 'dead_letter'];

export type RetryBlock = 'status_not_retryable' | 'word_active';

/** Why this job may not be sent again, or null when it may. `wordActive` = a queued / running row exists for the same word. */
export function retryBlock(job: { status: string; reason: string | null }, wordActive: boolean): RetryBlock | null {
  if (!RETRYABLE_STATUSES.includes(job.status) || !job.reason || !RETRYABLE_REASONS.includes(job.reason)) return 'status_not_retryable';
  if (wordActive) return 'word_active';
  return null;
}

/**
 * The list of words typed or pasted into the form: an array, or one string with a word per line. Trimmed, blank lines dropped,
 * nothing else changed (the enqueuer cleans each word with the same cleaner as the lookup path).
 */
export function toWordList(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/) : [];
  return raw.map((w) => (typeof w === 'string' ? w.trim() : '')).filter((w) => w.length > 0);
}

// ── tier A (docs/lookup-spec.md §3) ────────────────────────────────────────────────────────────────────────────────────

/** What is stored about one entry that tier A looks at. Counts come from the child tables. */
export interface TierAFacts {
  headword: string | null;
  lemma: string | null;
  pos: string[] | null;
  meaning_vi: string | null;
  /** entry_senses with a non-blank definition_en AND definition_vi */
  complete_senses: number;
  /** sense_examples (of this entry) with a non-blank example_en AND example_vi */
  complete_examples: number;
}

/** Same labels as `tierAMissing` in services/enrichment/assemble.ts, so the page and admin_note speak alike. */
export function tierAMissing(f: TierAFacts): string[] {
  const missing: string[] = [];
  if (!f.headword || !f.headword.trim()) missing.push('headword');
  if (!f.lemma || !f.lemma.trim()) missing.push('lemma');
  if (!f.pos || f.pos.length === 0) missing.push('pos');
  if (!f.meaning_vi || !f.meaning_vi.trim()) missing.push('meaning_vi');
  if (f.complete_senses < 1) missing.push('sense (definition_en và definition_vi)');
  if (f.complete_examples < 1) missing.push('ví dụ (example_en và example_vi)');
  return missing;
}

// ── Vietnamese meanings of a sense ─────────────────────────────────────────────────────────────────────────────────────

/** Limits of the validator that wrote them (docs/lookup-spec.md §9.7): each meaning at most 40 characters and 6 syllables. */
export const MEANING_MAX_CHARS = 40;
export const MEANING_MAX_WORDS = 6;

/** definition_vi is the meanings joined with '; ' (docs/lookup-spec.md §9.8). */
export function splitMeanings(definitionVi: string | null | undefined): string[] {
  if (!definitionVi) return [];
  return definitionVi
    .split(';')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

export interface MeaningView {
  text: string;
  /** longer than the writer was allowed to produce: edited by hand, or an older entry */
  too_long: boolean;
  /** one of notes_for_review mentions this meaning */
  in_review_notes: boolean;
}

const fold = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

export function flagMeanings(meanings: readonly string[], reviewNotes: readonly string[]): MeaningView[] {
  const notes = reviewNotes.map(fold);
  return meanings.map((text) => {
    const needle = fold(text);
    return {
      text,
      too_long: text.length > MEANING_MAX_CHARS || text.split(/\s+/).filter(Boolean).length > MEANING_MAX_WORDS,
      in_review_notes: needle.length >= 2 && notes.some((n) => n.includes(needle)),
    };
  });
}

// ── editing the Vietnamese of a sense (P9) ─────────────────────────────────────────────────────────────────────────────

/** Limits of what an admin may save. Generous next to the writer's own (MEANING_MAX_CHARS): an edit by hand may be longer. */
export const SENSE_VI_MAX_CHARS = 300;
export const SENSE_VI_MAX_MEANINGS = 8;
export const SENSE_MEANING_MAX_CHARS = 100;
export const EXAMPLE_VI_MAX_CHARS = 500;
export const MAX_EXAMPLES_PER_EDIT = 20;

/** Control characters (tab, new line, carriage return excepted: those become a space) and invisible formatting characters. */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/**
 * Cleans text typed by an admin before it is stored: Unicode NFC, invisible and control characters removed, every run of
 * white space (new lines and tabs included) becomes ONE space, ends trimmed. Not HTML-escaping: the pages and the app show text
 * as text; `<` and `>` are refused instead (see below).
 */
export function cleanText(input: string): string {
  return input.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/** (A plain shape, not a union on `ok`: the project compiles without strictNullChecks, where that union does not narrow.) */
export interface Validated<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/**
 * The Vietnamese meanings of a sense, typed as "a; b; c" (definition_vi is the meanings joined with '; ', spec §9.8).
 * Cleaned, split at ';', empty and repeated meanings dropped, then checked: at least one meaning, each at most
 * SENSE_MEANING_MAX_CHARS, at most SENSE_VI_MAX_MEANINGS of them, SENSE_VI_MAX_CHARS in all, no `<` or `>`.
 */
export function validateSenseDefinitionVi(input: unknown): Validated<{ value: string; meanings: string[] }> {
  if (typeof input !== 'string') return { ok: false, error: 'definition_vi phải là chuỗi' };
  const cleaned = cleanText(input);
  if (/[<>]/.test(cleaned)) return { ok: false, error: 'Nghĩa tiếng Việt không được chứa ký tự < hoặc >' };

  const seen = new Set<string>();
  const meanings: string[] = [];
  for (const part of cleaned.split(';')) {
    const m = part.trim();
    if (!m) continue;
    const key = m.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    meanings.push(m);
  }
  if (meanings.length === 0) return { ok: false, error: 'Nghĩa tiếng Việt không được để trống' };
  if (meanings.length > SENSE_VI_MAX_MEANINGS) return { ok: false, error: `Tối đa ${SENSE_VI_MAX_MEANINGS} nghĩa cho mỗi sense (đã nhập ${meanings.length})` };
  const tooLong = meanings.findIndex((m) => m.length > SENSE_MEANING_MAX_CHARS);
  if (tooLong >= 0) return { ok: false, error: `Mỗi nghĩa tối đa ${SENSE_MEANING_MAX_CHARS} ký tự (nghĩa thứ ${tooLong + 1} dài ${meanings[tooLong].length})` };

  const value = meanings.join('; ');
  if (value.length > SENSE_VI_MAX_CHARS) return { ok: false, error: `Tổng cộng tối đa ${SENSE_VI_MAX_CHARS} ký tự (đã nhập ${value.length})` };
  return { ok: true, value: { value, meanings } };
}

/** The Vietnamese translation of an example sentence: a non-empty line of text, cleaned, at most EXAMPLE_VI_MAX_CHARS. */
export function validateExampleVi(input: unknown): Validated<string> {
  if (typeof input !== 'string') return { ok: false, error: 'example_vi phải là chuỗi' };
  const value = cleanText(input);
  if (!value) return { ok: false, error: 'Bản dịch ví dụ không được để trống' };
  if (/[<>]/.test(value)) return { ok: false, error: 'Bản dịch ví dụ không được chứa ký tự < hoặc >' };
  if (value.length > EXAMPLE_VI_MAX_CHARS) return { ok: false, error: `Bản dịch ví dụ tối đa ${EXAMPLE_VI_MAX_CHARS} ký tự (đã nhập ${value.length})` };
  return { ok: true, value };
}

/** field_name of the entry_edit_history line of an edited sense (the column is VARCHAR(100): 6 + 36 + 14, and 6 + 36 + 12 + 36). */
export const senseHistoryField = (senseId: string): string => `sense:${senseId}:definition_vi`;
export const exampleHistoryField = (senseId: string, exampleId: string): string => `sense:${senseId}:example_vi:${exampleId}`;

// ── usage meters ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const WARN_RATIO = 0.8;

export type UsageLevel = 'ok' | 'warn' | 'critical' | 'unknown';

/** Colour level of "used out of limit": warning from 80 percent, critical from 100 percent. No usable limit → unknown. */
export function usageLevel(used: number | null | undefined, limit: number | null | undefined): UsageLevel {
  if (used == null || limit == null || !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 'unknown';
  const ratio = used / limit;
  if (ratio >= 1) return 'critical';
  if (ratio >= WARN_RATIO) return 'warn';
  return 'ok';
}

export type BreakerLevel = 'ok' | 'warn' | 'critical';

/** closed = fine, half_open = probing, open = the provider is being skipped. */
export function breakerLevel(state: string | undefined): BreakerLevel {
  if (state === 'open') return 'critical';
  if (state === 'half_open') return 'warn';
  return 'ok';
}
