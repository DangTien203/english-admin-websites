import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../upstream/errors';

/**
 * The "short Vietnamese meanings" step of the fast path (docs/lookup-spec.md §5, LOOKUP_FAST_TRANSLATOR).
 * It runs in parallel with Free Dictionary. Two engines implement it:
 *   - GoogleFastTranslator: the P3 behaviour, unchanged (Google translates the bare word → one headline).
 *   - HaikuFastTranslator: one Claude Haiku call that returns several short meanings at once.
 * FallbackFastTranslator wraps Haiku so any failure silently falls back to Google (step 1 only).
 *
 * Translating the DEFINITIONS (spec F9, senses[].definition_vi) is not part of this interface: it stays a
 * separate Google step that depends on Free Dictionary's answer and runs in both modes.
 */

export type TranslatorEngine = 'google' | 'haiku';

export interface FastTranslateInput {
  /** Normalized (lowercase) word. */
  word: string;
  /** Epoch ms after which nothing new may start; implementations must respect it. */
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface FastTranslateResult {
  /** Short Vietnamese meanings, most common first. EMPTY = the engine has no usable translation. */
  meanings_vi: string[];
  /** Reserved for engines that translate per Free Dictionary sense in one step (none today). */
  per_sense?: Array<{ gloss_vi: string | null; definition_vi: string | null }>;
  /** Which engine produced the meanings (after any fallback this is the engine that actually answered). */
  engine: TranslatorEngine;
  /** Part of speech of each meaning, same order, when the engine knows it (Haiku). */
  pos?: Array<string | null>;
  /** Tokens spent (Haiku), for the logs. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Set when Haiku failed and Google answered instead. */
  fallback?: { from: 'haiku'; reason: string };
}

export interface FastTranslator {
  translate(input: FastTranslateInput): Promise<FastTranslateResult>;
}

// ── Google ───────────────────────────────────────────────────────────────────

export interface GoogleLike {
  translate: (texts: string[], opts?: { deadlineAt?: number; signal?: AbortSignal }) => Promise<string[]>;
}

/** The P3 step-1 behaviour, wrapped: translate the bare word, the answer is the single headline meaning. */
export class GoogleFastTranslator implements FastTranslator {
  constructor(private readonly google: GoogleLike) {}

  async translate(input: FastTranslateInput): Promise<FastTranslateResult> {
    const [headline] = await this.google.translate([input.word], { deadlineAt: input.deadlineAt, signal: input.signal });
    const h = (headline ?? '').trim();
    return { meanings_vi: h ? [h] : [], engine: 'google' };
  }
}

// ── Fallback wrapper ─────────────────────────────────────────────────────────

/** Short code for why the primary engine failed (logged and returned in `fallback.reason`). */
export function describeFailure(err: unknown): string {
  if (err instanceof UpstreamUnavailable) return err.reason; // timeout, network, http_5xx, rate_limited, breaker_open, bad_response, …
  if (err instanceof BudgetExceeded) return 'budget';
  if (err instanceof UpstreamConfigError) return 'config';
  return 'unexpected';
}

/**
 * Time kept back for the fallback (ms). A Google headline took 83–322 ms in the P3b measurements (p95 ≈ 280),
 * so 500 ms is a safe margin. Without it a Haiku call that runs into the lookup deadline leaves the fallback
 * no time at all — which is exactly what happened on the first real run (cold database connection + a slow
 * Haiku answer = no translation).
 */
export const FALLBACK_RESERVE_MS = 500;

/**
 * Tries `primary` (Haiku); on ANY failure — error, timeout, spent budget, open circuit, malformed output —
 * asks `fallback` (Google) for the same word. Only that one cheap step is repeated, so the extra delay is
 * bounded by the Google call and the lookup deadline. An empty answer from the primary is NOT a failure:
 * it is the model saying "this is not a word" and is passed through.
 *
 * The primary only gets the lookup deadline minus FALLBACK_RESERVE_MS; when less than that is left it is not
 * even tried and Google answers straight away (reason 'no_time').
 */
export class FallbackFastTranslator implements FastTranslator {
  constructor(
    private readonly primary: FastTranslator,
    private readonly fallback: FastTranslator,
    private readonly onFallback?: (reason: string, err: unknown) => void,
    private readonly opts: { reserveMs?: number; now?: () => number } = {}
  ) {}

  async translate(input: FastTranslateInput): Promise<FastTranslateResult> {
    const reserveMs = this.opts.reserveMs ?? FALLBACK_RESERVE_MS;
    const now = this.opts.now ?? Date.now;

    // The primary must finish early enough to leave the fallback its share of the deadline.
    const primaryDeadline = input.deadlineAt === undefined ? undefined : input.deadlineAt - reserveMs;
    if (primaryDeadline !== undefined && primaryDeadline <= now()) {
      return this.runFallback(input, 'no_time', new UpstreamUnavailable('anthropic', 'timeout', { message: 'not enough time left for the primary translator' }));
    }

    try {
      return await this.primary.translate(primaryDeadline === undefined ? input : { ...input, deadlineAt: primaryDeadline });
    } catch (err) {
      if (input.signal?.aborted) throw err; // the caller gave up: do not start more work
      return this.runFallback(input, describeFailure(err), err);
    }
  }

  private async runFallback(input: FastTranslateInput, reason: string, err: unknown): Promise<FastTranslateResult> {
    try {
      this.onFallback?.(reason, err);
    } catch {
      /* observers must never break the lookup */
    }
    const result = await this.fallback.translate(input); // the fallback keeps the ORIGINAL deadline
    return { ...result, fallback: { from: 'haiku', reason } };
  }
}
