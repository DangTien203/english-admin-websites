import type { FdEntry } from '../upstream/freeDictionaryClient';

/** Minimal database surface (pg.Pool and PoolClient both satisfy it) so tests can inject a fake. */
export interface Db {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export interface NormalizedWord {
  /** lowercase, validated: the lookup key */
  normalized: string;
  /** as typed (punctuation stripped): shown to the user */
  display: string;
}

export interface LookupInput {
  userId: string;
  ebookId: string;
  /** Already verified to belong to the ebook (or null). */
  paragraphId: string | null;
  word: NormalizedWord;
}

// ── Upstream (fast path steps 1 and 2) ───────────────────────────────────────

/**
 * Result of the fast translator step (the short Vietnamese meanings). 'ok' means at least one usable meaning.
 * `engine` is who actually produced them (after a Haiku → Google fallback it is 'google').
 */
export type TranslationOutcome =
  | {
      status: 'ok';
      meanings: string[];
      engine: 'google' | 'haiku';
      ms: number;
      fallback?: { from: 'haiku'; reason: string };
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { status: 'error'; error: unknown; ms: number };

export type FdOutcome =
  | { status: 'found'; entry: FdEntry; ms: number }
  | { status: 'not_found'; ms: number }
  | { status: 'error'; error: unknown; ms: number };

export interface SenseResult {
  pos: string;
  definition_en: string;
  definition_vi: string | null;
  gloss_vi: string | null;
  example_en: string | null;
}

export type Step2Status =
  | 'ran' // definitions were sent to Google
  | 'skipped_flag' // LOOKUP_TRANSLATE_DEFINITIONS=false
  | 'skipped_no_fd' // nothing to translate
  | 'skipped_no_translation' // no usable meaning from the fast translator
  | 'skipped_no_time' // not enough of the total deadline left
  | 'failed'; // Google call failed or returned garbage

export interface Step2Outcome {
  status: Step2Status;
  /** The selected senses (<= LOOKUP_MAX_MEANINGS); vi fields are null unless status is 'ran'. */
  senses: SenseResult[];
  /** Usable short glosses, in sense order. */
  glosses: string[];
  ms: number;
  error?: unknown;
}

export interface UpstreamBundle {
  word: string;
  translation: TranslationOutcome;
  fd: FdOutcome;
  step2: Step2Outcome;
  totalMs: number;
  /** true when the LOOKUP_TOTAL_DEADLINE_MS ran out before everything finished. */
  deadlineExceeded: boolean;
}

// ── Response ─────────────────────────────────────────────────────────────────

export interface EnrichmentInfo {
  status: 'queued' | 'already_queued' | 'skipped' | 'disabled';
  reason?: string;
}

export interface Attribution {
  name: string;
  license: string;
  url: string;
}

/** Body of a source='translation' response (everything except lookup_context, added by the route). */
export interface TemporaryBody {
  source: 'translation';
  temporary: true;
  // ── fields that already existed, same name and type ──
  word: string;
  translation_vi: string | null;
  phonetic: string | null;
  audio_url: string | null;
  /** First part of speech (string, as before). The full list is `pos_list`. */
  pos: string | null;
  definitions_en: string[];
  examples: Array<{ en: string; vi: string | null }>;
  providers: string[];
  cached: false;
  // ── new fields (docs/lookup-spec.md §4.2) ──
  headword: string;
  pos_list: string[];
  ipa: string | null;
  meanings_vi: string[];
  senses: SenseResult[];
  partial: boolean;
  missing: string[];
  attribution: Attribution[];
  enrichment: EnrichmentInfo;
}

export type LookupResult =
  | { kind: 'dictionary'; entry: any; matchedForm?: string }
  | { kind: 'temporary'; body: TemporaryBody }
  | { kind: 'not_found' }
  | { kind: 'unavailable' }
  | { kind: 'rate_limited'; retryAfterSeconds: number };
