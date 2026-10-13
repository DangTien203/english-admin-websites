import { UpstreamUnavailable, UpstreamProvider, UnavailableReason } from './errors';

/**
 * HTTP helpers shared by every external-service client.
 * No client may call fetch() directly: timeouts, error mapping and retry live here.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  provider: UpstreamProvider;
  /** Hard cap for this single attempt, enforced with AbortSignal.timeout. */
  timeoutMs: number;
  /** Optional extra cancellation (e.g. request aborted by the caller). */
  signal?: AbortSignal;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * fetch() with a hard timeout. Never throws raw fetch errors:
 *   timeout        → UpstreamUnavailable('timeout')
 *   anything else  → UpstreamUnavailable('network')
 * Status codes are NOT interpreted here; the caller maps them.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, opts: FetchOptions): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(opts.timeoutMs)));
  const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));

  try {
    return await doFetch(url, { ...init, signal });
  } catch (err: any) {
    if (timeoutSignal.aborted || err?.name === 'TimeoutError') {
      throw new UpstreamUnavailable(opts.provider, 'timeout', { message: `timeout after ${opts.timeoutMs}ms`, cause: err });
    }
    // Deliberately do not copy err.message: it can contain the request URL.
    throw new UpstreamUnavailable(opts.provider, 'network', { message: `network error (${err?.cause?.code ?? err?.name ?? 'unknown'})`, cause: err });
  }
}

/**
 * Parses a Retry-After header: delta-seconds or an HTTP date. Returns milliseconds, or undefined.
 * Clamped to [0, maxMs] so a hostile or buggy header cannot stall a worker for hours.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now(), maxMs = 3_600_000): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (v === '') return undefined;

  let ms: number | undefined;
  if (/^\d+(\.\d+)?$/.test(v)) {
    ms = Math.round(Number(v) * 1000);
  } else {
    const at = Date.parse(v);
    if (!Number.isNaN(at)) ms = at - now;
  }
  if (ms === undefined) return undefined;
  return Math.min(Math.max(ms, 0), maxMs);
}

// ── Retry ────────────────────────────────────────────────────────────────────

export interface RetryContext {
  /** 1-based attempt number. */
  attempt: number;
  /** Milliseconds left before the overall deadline (Infinity when there is none). Use it to shorten the per-attempt timeout. */
  remainingMs: number;
}

export interface RetryOptions {
  /** Total attempts including the first. 1 = no retry. */
  maxAttempts: number;
  /** Absolute deadline in epoch ms. A retry is only started when it can still fit. */
  deadlineAt?: number;
  baseDelayMs?: number; // default 100
  maxDelayMs?: number; // default 1000
  /** Smallest remaining time worth another attempt. Default 200. */
  minAttemptMs?: number;
  /** Only these transient reasons are retried. Default: network errors and timeouts. */
  retryOn?: ReadonlySet<UnavailableReason>;
  // Test seams
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_RETRY_REASONS: ReadonlySet<UnavailableReason> = new Set<UnavailableReason>(['network', 'timeout']);

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs fn, retrying ONLY transient network failures, with full-jitter exponential backoff.
 * Everything else (404, 429, 5xx answers, config errors, budget) is rethrown immediately.
 */
export async function withRetry<T>(fn: (ctx: RetryContext) => Promise<T>, opts: RetryOptions): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const base = opts.baseDelayMs ?? 100;
  const cap = opts.maxDelayMs ?? 1000;
  const minAttempt = opts.minAttemptMs ?? 200;
  const retryOn = opts.retryOn ?? DEFAULT_RETRY_REASONS;
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts));

  for (let attempt = 1; ; attempt++) {
    const remainingMs = opts.deadlineAt === undefined ? Infinity : opts.deadlineAt - now();
    try {
      return await fn({ attempt, remainingMs });
    } catch (err) {
      const retryable = err instanceof UpstreamUnavailable && retryOn.has(err.reason);
      if (!retryable || attempt >= maxAttempts) throw err;

      // Full jitter: random in [0, min(cap, base * 2^(attempt-1))]
      const delay = Math.floor(random() * Math.min(cap, base * 2 ** (attempt - 1)));
      const remainingAfterDelay = opts.deadlineAt === undefined ? Infinity : opts.deadlineAt - now() - delay;
      if (remainingAfterDelay < minAttempt) throw err; // no room left for a useful second attempt

      if (delay > 0) await sleep(delay);
    }
  }
}
