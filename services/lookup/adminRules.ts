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
