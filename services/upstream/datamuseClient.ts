import { CircuitBreaker } from './circuitBreaker';
import { UpstreamConfigError, UpstreamUnavailable } from './errors';
import { FetchLike, fetchWithTimeout, parseRetryAfter, withRetry } from './http';
import { uniqueLower } from './text';

/**
 * Datamuse client (https://www.datamuse.com/api/) — synonyms / antonyms for background enrichment.
 * Docs consulted 2026-10-13: GET /words?rel_syn=<word>&max=<n> and rel_ant, JSON array of
 * { word, score }; `max` default 100, up to 1000; "100,000 requests/day" without a key.
 *
 * relations() NEVER throws: any failure yields { synonyms: [], antonyms: [], degraded: true }
 * (or the half that did succeed). Datamuse is a nice-to-have, never a reason to fail a job.
 */

export const DATAMUSE_PROVIDER = 'datamuse' as const;
export const DATAMUSE_MAX_RESULTS = 20;

export interface DatamuseRelations {
  synonyms: string[];
  antonyms: string[];
  /** true when at least one of the two requests failed or was skipped by the breaker. */
  degraded?: true;
}

export interface DatamuseClientConfig {
  enabled: boolean;
  baseUrl: string;
  /** Empty = anonymous calls. */
  apiKey?: string;
  timeoutMs: number;
  maxAttempts?: number;
}

/**
 * THE ONE PLACE where the Datamuse API key is attached to a request.
 *
 * TODO(datamuse-key): https://www.datamuse.com/api/ (read 2026-10-13) announces that an API key
 * becomes mandatory in 2027 (the page contradicts itself: "January 1, 2027" in one place,
 * "February 1, 2027" in another) and says keys are still "being set up", but does NOT say how the
 * key is sent (header or query parameter, and its name). Until Datamuse publishes that, this is a
 * deliberate no-op: inventing a parameter name would send the secret somewhere it means nothing.
 * When the docs appear, implement it here and nowhere else (e.g. url.searchParams.set(<name>, key)
 * or headers.set(<name>, key)) and update tests/lookup/datamuseClient.test.ts.
 */
export function applyDatamuseAuth(_url: URL, _headers: Headers, _apiKey: string): void {
  /* intentionally empty — see TODO above */
}

export interface DatamuseDeps {
  breaker: CircuitBreaker;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Override to test key handling. Defaults to applyDatamuseAuth. */
  applyAuth?: (url: URL, headers: Headers, apiKey: string) => void;
  /** Receives non-fatal problems (never the API key). Defaults to silent. */
  onDegraded?: (word: string, err: unknown) => void;
}

export class DatamuseClient {
  constructor(
    private readonly config: DatamuseClientConfig,
    private readonly deps: DatamuseDeps
  ) {}

  async relations(word: string, opts: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<DatamuseRelations> {
    if (!this.config.enabled) return { synonyms: [], antonyms: [] };

    const w = typeof word === 'string' ? word.trim() : '';
    if (!w) return { synonyms: [], antonyms: [], degraded: true };

    try {
      // Both lookups share one breaker call: one logical outage counts once.
      return await this.deps.breaker.exec(async () => {
        const [syn, ant] = await Promise.allSettled([
          this.fetchRelation('rel_syn', w, opts),
          this.fetchRelation('rel_ant', w, opts),
        ]);

        if (syn.status === 'rejected' && ant.status === 'rejected') throw syn.reason;

        const result: DatamuseRelations = {
          synonyms: syn.status === 'fulfilled' ? syn.value : [],
          antonyms: ant.status === 'fulfilled' ? ant.value : [],
        };
        if (syn.status === 'rejected' || ant.status === 'rejected') {
          result.degraded = true;
          this.report(w, syn.status === 'rejected' ? syn.reason : (ant as PromiseRejectedResult).reason);
        }
        return result;
      });
    } catch (err) {
      this.report(w, err);
      return { synonyms: [], antonyms: [], degraded: true };
    }
  }

  private report(word: string, err: unknown): void {
    try {
      this.deps.onDegraded?.(word, err);
    } catch {
      /* never let an observer break the caller */
    }
  }

  private fetchRelation(rel: 'rel_syn' | 'rel_ant', word: string, opts: { deadlineAt?: number; signal?: AbortSignal }): Promise<string[]> {
    return withRetry((ctx) => this.requestOnce(rel, word, ctx.remainingMs, opts.signal), {
      maxAttempts: this.config.maxAttempts ?? 2,
      deadlineAt: opts.deadlineAt,
      sleep: this.deps.sleep,
      random: this.deps.random,
    });
  }

  private async requestOnce(rel: 'rel_syn' | 'rel_ant', word: string, remainingMs: number, signal?: AbortSignal): Promise<string[]> {
    const url = new URL('/words', this.config.baseUrl);
    url.searchParams.set(rel, word);
    url.searchParams.set('max', String(DATAMUSE_MAX_RESULTS));

    const headers = new Headers({ accept: 'application/json' });
    if (this.config.apiKey) (this.deps.applyAuth ?? applyDatamuseAuth)(url, headers, this.config.apiKey);

    const timeoutMs = Math.max(1, Math.min(this.config.timeoutMs, remainingMs));
    const res = await fetchWithTimeout(
      url.toString(),
      { method: 'GET', headers },
      { provider: DATAMUSE_PROVIDER, timeoutMs, signal, fetchImpl: this.deps.fetchImpl }
    );

    if (res.status === 200) {
      let json: unknown;
      try {
        json = JSON.parse(await res.text());
      } catch {
        throw new UpstreamUnavailable(DATAMUSE_PROVIDER, 'bad_response', { status: 200, message: 'response is not JSON' });
      }
      if (!Array.isArray(json)) {
        throw new UpstreamUnavailable(DATAMUSE_PROVIDER, 'bad_response', { status: 200, message: 'response is not an array' });
      }
      const words = json.map((item: any) => (typeof item?.word === 'string' ? item.word : ''));
      // Same word as the query is noise; multi-word phrases are kept (they can be real synonyms).
      return uniqueLower(words).filter((w) => w !== word.toLowerCase());
    }

    if (res.status === 429) {
      throw new UpstreamUnavailable(DATAMUSE_PROVIDER, 'rate_limited', {
        status: 429,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    if (res.status >= 500 || res.status === 408) {
      throw new UpstreamUnavailable(DATAMUSE_PROVIDER, res.status === 408 ? 'timeout' : 'http_5xx', { status: res.status });
    }
    if (res.status === 401 || res.status === 403) {
      throw new UpstreamConfigError(DATAMUSE_PROVIDER, `HTTP ${res.status}`, res.status);
    }
    throw new UpstreamUnavailable(DATAMUSE_PROVIDER, 'bad_response', { status: res.status, message: `unexpected HTTP ${res.status}` });
  }
}
