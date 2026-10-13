/**
 * Error taxonomy shared by every external-service client (docs/lookup-spec.md §11).
 *
 * Callers branch on the class, never on message text:
 *   UpstreamNotFound     – the service answered "no such thing" (healthy answer, not a failure)
 *   UpstreamUnavailable  – timeout, network error, 5xx, 429, open breaker, local rate limit, garbage response
 *   UpstreamConfigError  – 400 / 401 / 403 or a missing API key: never retry, fix the configuration
 *   BudgetExceeded       – a spend / quota limit (local counter or provider side): never retry
 */

export type UpstreamProvider = 'google_translate' | 'free_dictionary' | 'datamuse' | 'anthropic';

export type UnavailableReason =
  | 'timeout'
  | 'network'
  | 'http_5xx'
  | 'rate_limited' // provider answered 429
  | 'local_rate_limit' // our own token bucket is empty
  | 'breaker_open'
  | 'bad_response'; // 200 but unusable (wrong shape, wrong array length, HTML instead of JSON, ...)

export type BudgetReason = 'monthly_chars' | 'provider_quota' | 'spend_limit';

export abstract class UpstreamError extends Error {
  readonly provider: UpstreamProvider;
  /** HTTP status when a response was received. */
  readonly status?: number;

  protected constructor(provider: UpstreamProvider, message: string, status?: number, cause?: unknown) {
    super(`[${provider}] ${message}`, cause === undefined ? undefined : { cause });
    this.provider = provider;
    this.status = status;
  }
}

export class UpstreamNotFound extends UpstreamError {
  constructor(provider: UpstreamProvider, message = 'not found') {
    super(provider, message, 404);
    this.name = 'UpstreamNotFound';
  }
}

export class UpstreamUnavailable extends UpstreamError {
  readonly reason: UnavailableReason;
  /** Parsed Retry-After (ms), when the provider sent one. */
  readonly retryAfterMs?: number;
  /**
   * false = the problem is specific to ONE request/word (e.g. a poisoned CDN cache entry), not a sign
   * that the provider is unhealthy, so the circuit breaker must ignore it. Default true.
   */
  readonly affectsBreaker: boolean;

  constructor(
    provider: UpstreamProvider,
    reason: UnavailableReason,
    opts: { message?: string; status?: number; retryAfterMs?: number; cause?: unknown; affectsBreaker?: boolean } = {}
  ) {
    super(provider, opts.message ?? reason, opts.status, opts.cause);
    this.name = 'UpstreamUnavailable';
    this.reason = reason;
    this.retryAfterMs = opts.retryAfterMs;
    this.affectsBreaker = opts.affectsBreaker ?? true;
  }
}

export class UpstreamConfigError extends UpstreamError {
  constructor(provider: UpstreamProvider, message: string, status?: number) {
    super(provider, message, status);
    this.name = 'UpstreamConfigError';
  }
}

export class BudgetExceeded extends UpstreamError {
  readonly reason: BudgetReason;
  /** Parsed Retry-After (ms), when the provider sent one. */
  readonly retryAfterMs?: number;

  constructor(
    provider: UpstreamProvider,
    reason: BudgetReason,
    opts: { message?: string; status?: number; retryAfterMs?: number } = {}
  ) {
    super(provider, opts.message ?? reason, opts.status);
    this.name = 'BudgetExceeded';
    this.reason = reason;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export const isUpstreamError = (e: unknown): e is UpstreamError => e instanceof UpstreamError;
