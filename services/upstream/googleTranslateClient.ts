import { ApiUsage, currentPeriod } from './apiUsage';
import { CircuitBreaker } from './circuitBreaker';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from './errors';
import { FetchLike, fetchWithTimeout, parseRetryAfter, withRetry } from './http';
import { decodeHtmlEntities } from './text';

/**
 * Google Cloud Translation v2 (Basic) client — docs/lookup-spec.md §5 F8/F9, §11.
 * Verified against the real API: see docs/lookup-api-notes.md.
 *
 * - POST JSON body { q: string[], source:'en', target:'vi', format:'text' }.
 * - The API key travels in the X-Goog-Api-Key header, never in the URL, so it cannot leak through
 *   logs, error messages or proxies (verified to work against the real API).
 * - Characters are reserved in api_usage_counters BEFORE the call (monthly budget, UTC month).
 */

export const GOOGLE_PROVIDER = 'google_translate' as const;
/** Google Translate v2 hard limits: 128 strings and ~30k characters per request. */
export const GOOGLE_MAX_STRINGS = 128;
export const GOOGLE_MAX_CHARS_PER_REQUEST = 30_000;

export interface GoogleTranslateClientConfig {
  /** Empty = Google disabled; translate() then throws UpstreamConfigError without touching the network. */
  apiKey?: string;
  baseUrl: string;
  monthlyCharLimit: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Total attempts for transient network failures (1 = no retry). Default 2. */
  maxAttempts?: number;
}

export interface GoogleTranslateDeps {
  usage: Pick<ApiUsage, 'reserve' | 'release'>;
  breaker: CircuitBreaker;
  fetchImpl?: FetchLike;
  now?: () => Date;
  // Test seams for the retry loop
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface TranslateOptions {
  /** Epoch ms after which no new attempt is started (the lookup's overall deadline). */
  deadlineAt?: number;
  signal?: AbortSignal;
}

export class GoogleTranslateClient {
  constructor(
    private readonly config: GoogleTranslateClientConfig,
    private readonly deps: GoogleTranslateDeps
  ) {}

  /** True when an API key is configured. */
  get enabled(): boolean {
    return Boolean(this.config.apiKey);
  }

  /** Translates en → vi. Result[i] corresponds to texts[i]. */
  async translate(texts: string[], opts: TranslateOptions = {}): Promise<string[]> {
    if (texts.length === 0) return [];

    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new UpstreamConfigError(GOOGLE_PROVIDER, 'GOOGLE_TRANSLATE_API_KEY is empty (Google disabled)');
    }

    if (texts.some((t) => typeof t !== 'string')) throw new TypeError('translate() expects string[]');
    if (texts.length > GOOGLE_MAX_STRINGS) throw new RangeError(`at most ${GOOGLE_MAX_STRINGS} strings per request`);
    const chars = texts.reduce((n, t) => n + t.length, 0);
    if (chars > GOOGLE_MAX_CHARS_PER_REQUEST) throw new RangeError(`at most ${GOOGLE_MAX_CHARS_PER_REQUEST} characters per request`);

    const period = currentPeriod('month', this.deps.now?.() ?? new Date());

    // The budget is reserved inside the breaker: an open circuit must not consume budget.
    return this.deps.breaker.exec(async () => {
      const reserved = await this.deps.usage.reserve(GOOGLE_PROVIDER, 'chars', period, chars, this.config.monthlyCharLimit);
      if (!reserved) {
        throw new BudgetExceeded(GOOGLE_PROVIDER, 'monthly_chars', {
          message: `monthly character budget (${this.config.monthlyCharLimit}) would be exceeded by ${chars} chars`,
        });
      }

      try {
        return await withRetry((ctx) => this.requestOnce(apiKey, texts, ctx.remainingMs, opts.signal), {
          maxAttempts: this.config.maxAttempts ?? 2,
          deadlineAt: opts.deadlineAt,
          now: () => Date.now(),
          sleep: this.deps.sleep,
          random: this.deps.random,
        });
      } catch (err) {
        // Give the characters back only when Google certainly did not process the request.
        if (shouldRefund(err)) {
          await this.deps.usage.release(GOOGLE_PROVIDER, 'chars', period, chars).catch(() => undefined);
        }
        throw err;
      }
    });
  }

  private async requestOnce(apiKey: string, texts: string[], remainingMs: number, signal?: AbortSignal): Promise<string[]> {
    const timeoutMs = Math.max(1, Math.min(this.config.timeoutMs, remainingMs));

    const res = await fetchWithTimeout(
      this.config.baseUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ q: texts, source: 'en', target: 'vi', format: 'text' }),
      },
      { provider: GOOGLE_PROVIDER, timeoutMs, signal, fetchImpl: this.deps.fetchImpl }
    );

    const bodyText = await readBody(res, GOOGLE_PROVIDER, timeoutMs);

    if (res.status === 200) return parseTranslations(bodyText, texts.length);
    throw this.errorFor(res, bodyText, apiKey);
  }

  private errorFor(res: Response, bodyText: string, apiKey: string): Error {
    const status = res.status;
    const detail = describeGoogleError(bodyText, apiKey);

    if (status === 429) {
      return new UpstreamUnavailable(GOOGLE_PROVIDER, 'rate_limited', {
        status,
        message: `HTTP 429 ${detail}`,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    if (status === 408) {
      return new UpstreamUnavailable(GOOGLE_PROVIDER, 'timeout', { status, message: `HTTP 408 ${detail}` });
    }
    if (status >= 500) {
      return new UpstreamUnavailable(GOOGLE_PROVIDER, 'http_5xx', { status, message: `HTTP ${status} ${detail}` });
    }
    // 400 / 401 / 403 / 404 / other 4xx: our request or key is wrong. Retrying cannot help (spec §11.3).
    return new UpstreamConfigError(GOOGLE_PROVIDER, `HTTP ${status} ${detail}`, status);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Refund only for answers that prove the request was rejected, not processed. */
function shouldRefund(err: unknown): boolean {
  if (err instanceof UpstreamConfigError) return true;
  return err instanceof UpstreamUnavailable && (err.reason === 'rate_limited' || err.reason === 'http_5xx');
}

async function readBody(res: Response, provider: typeof GOOGLE_PROVIDER, timeoutMs: number): Promise<string> {
  try {
    return await res.text();
  } catch (err: any) {
    // The body stream can still fail or be aborted by the timeout after the headers arrived.
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
    throw new UpstreamUnavailable(provider, reason, { message: `body read failed after headers (${timeoutMs}ms budget)`, cause: err });
  }
}

function parseTranslations(bodyText: string, expected: number): string[] {
  let json: any;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new UpstreamUnavailable(GOOGLE_PROVIDER, 'bad_response', { status: 200, message: 'response is not JSON' });
  }

  const translations = json?.data?.translations;
  if (!Array.isArray(translations)) {
    throw new UpstreamUnavailable(GOOGLE_PROVIDER, 'bad_response', { status: 200, message: 'data.translations is missing' });
  }
  if (translations.length !== expected) {
    throw new UpstreamUnavailable(GOOGLE_PROVIDER, 'bad_response', {
      status: 200,
      message: `expected ${expected} translations, got ${translations.length}`,
    });
  }

  return translations.map((item: any, i: number) => {
    if (typeof item?.translatedText !== 'string') {
      throw new UpstreamUnavailable(GOOGLE_PROVIDER, 'bad_response', { status: 200, message: `translations[${i}].translatedText is not a string` });
    }
    return decodeHtmlEntities(item.translatedText).trim();
  });
}

/** Short, key-free description of a Google error body. */
function describeGoogleError(bodyText: string, apiKey: string): string {
  let message = '';
  let reason = '';
  try {
    const err = JSON.parse(bodyText)?.error;
    message = typeof err?.message === 'string' ? err.message : '';
    const info = Array.isArray(err?.details) ? err.details.find((d: any) => typeof d?.reason === 'string') : undefined;
    reason = info?.reason ?? err?.errors?.[0]?.reason ?? err?.status ?? '';
  } catch {
    /* non-JSON error body: keep it empty */
  }
  const text = [reason, message].filter(Boolean).join(': ').slice(0, 300);
  return text.split(apiKey).join('<key>');
}
