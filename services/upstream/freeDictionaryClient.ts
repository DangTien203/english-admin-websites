import { CircuitBreaker } from './circuitBreaker';
import { UpstreamConfigError, UpstreamUnavailable } from './errors';
import { FetchLike, fetchWithTimeout, parseRetryAfter, withRetry } from './http';
import { TokenBucket } from './tokenBucket';
import { uniqueLower } from './text';

/**
 * Free Dictionary API client (https://dictionaryapi.dev) — docs/lookup-spec.md §5 F8, §11.
 * Response shape and quirks come from real captures: docs/lookup-api-notes.md and
 * tests/fixtures/lookup/free-dictionary/.
 *
 * Quirks handled here:
 *  - The same headword can come back as several entries (e.g. "ran" → 3 entries): they are merged.
 *  - Accent is only known from the audio file name suffix (-us, -uk, -au, …), never from a field.
 *  - `phonetics[].audio` is "" when there is no recording; `text` may be missing.
 *  - A 404 is "word not found" ONLY when the body is the API's JSON error. The service has been seen
 *    returning an HTML 404 page (and Cloudflare 522) for real words, which is an outage, not a miss.
 */

export const FREE_DICTIONARY_PROVIDER = 'free_dictionary' as const;

export interface FdSense {
  pos: string;
  definition: string;
  example: string | null;
  synonyms: string[];
  antonyms: string[];
}

export interface FdAccentValues {
  us: string | null;
  uk: string | null;
  /** Best value regardless of accent (prefers us, then uk, then anything). */
  any: string | null;
}

export interface FdEntry {
  headword: string;
  ipa: FdAccentValues;
  audio: FdAccentValues;
  pos: string[];
  senses: FdSense[];
  license: { name: string; url: string } | null;
  sourceUrls: string[];
}

export type FdLookupResult = { found: false } | { found: true; entry: FdEntry };

export interface FreeDictionaryClientConfig {
  /** e.g. https://api.dictionaryapi.dev/api/v2/entries/en (no trailing slash). */
  baseUrl: string;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Total attempts for transient network failures. Default 2. */
  maxAttempts?: number;
}

export interface FreeDictionaryDeps {
  breaker: CircuitBreaker;
  bucket: TokenBucket;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface FdLookupOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
}

export class FreeDictionaryClient {
  constructor(
    private readonly config: FreeDictionaryClientConfig,
    private readonly deps: FreeDictionaryDeps
  ) {}

  async lookup(word: string, opts: FdLookupOptions = {}): Promise<FdLookupResult> {
    if (typeof word !== 'string' || word.trim() === '') throw new TypeError('lookup() expects a non-empty word');
    const url = `${this.config.baseUrl}/${encodeURIComponent(word.trim())}`;

    return this.deps.breaker.exec(() =>
      withRetry((ctx) => this.requestOnce(url, word, ctx.remainingMs, opts.signal), {
        maxAttempts: this.config.maxAttempts ?? 2,
        deadlineAt: opts.deadlineAt,
        sleep: this.deps.sleep,
        random: this.deps.random,
      })
    );
  }

  private async requestOnce(url: string, word: string, remainingMs: number, signal?: AbortSignal): Promise<FdLookupResult> {
    // One token per real request (a retry costs a token too). Empty bucket = our own limit, not an outage.
    if (!this.deps.bucket.tryRemove(1)) {
      throw new UpstreamUnavailable(FREE_DICTIONARY_PROVIDER, 'local_rate_limit', {
        message: 'internal request budget exhausted',
        retryAfterMs: this.deps.bucket.msUntilAvailable(1),
      });
    }

    const timeoutMs = Math.max(1, Math.min(this.config.timeoutMs, remainingMs));
    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers: { accept: 'application/json' } },
      { provider: FREE_DICTIONARY_PROVIDER, timeoutMs, signal, fetchImpl: this.deps.fetchImpl }
    );

    let bodyText: string;
    try {
      bodyText = await res.text();
    } catch (err: any) {
      const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
      throw new UpstreamUnavailable(FREE_DICTIONARY_PROVIDER, reason, { message: 'body read failed', cause: err });
    }

    const status = res.status;
    if (status === 200) return this.parseOk(bodyText, word);
    if (status === 404) return this.parseNotFound(bodyText);

    if (status === 429) {
      throw new UpstreamUnavailable(FREE_DICTIONARY_PROVIDER, 'rate_limited', {
        status,
        message: 'HTTP 429',
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    if (status === 408) throw new UpstreamUnavailable(FREE_DICTIONARY_PROVIDER, 'timeout', { status, message: 'HTTP 408' });
    if (status >= 500) throw new UpstreamUnavailable(FREE_DICTIONARY_PROVIDER, 'http_5xx', { status, message: `HTTP ${status}` });
    if (status === 401 || status === 403) {
      throw new UpstreamConfigError(FREE_DICTIONARY_PROVIDER, `HTTP ${status}`, status);
    }
    // 400 and other 4xx: the API has no key, so this is about THIS request/word, not a global
    // configuration problem. Report it as a bad answer but do not let it trip the breaker for everyone.
    throw new UpstreamUnavailable(FREE_DICTIONARY_PROVIDER, 'bad_response', {
      status,
      message: `unexpected HTTP ${status}`,
      affectsBreaker: false,
    });
  }

  private parseNotFound(bodyText: string): FdLookupResult {
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = undefined;
    }
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      return { found: false }; // the API's own JSON "No Definitions Found"
    }
    throw new UpstreamUnavailable(FREE_DICTIONARY_PROVIDER, 'bad_response', {
      status: 404,
      message: '404 without the API JSON error body (CDN/edge anomaly), not treated as "word not found"',
      // Seen for real words ("run"): a wrong 404 page cached by the CDN for that URL only. It says nothing
      // about the other words, so it must not push the breaker towards opening.
      affectsBreaker: false,
    });
  }

  private parseOk(bodyText: string, requestedWord: string): FdLookupResult {
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new UpstreamUnavailable(FREE_DICTIONARY_PROVIDER, 'bad_response', { status: 200, message: 'response is not JSON' });
    }
    if (!Array.isArray(json)) {
      throw new UpstreamUnavailable(FREE_DICTIONARY_PROVIDER, 'bad_response', { status: 200, message: 'response is not an array' });
    }
    const entry = normalizeFreeDictionaryResponse(json, requestedWord);
    return entry ? { found: true, entry } : { found: false };
  }
}

// ── normalization (pure, exported for tests) ─────────────────────────────────

const ACCENT_SUFFIX = /-(us|uk|au|ca|in|nz|ie|za|gb)\.(?:mp3|ogg|wav|m4a)$/i;

/** Accent from the audio file name, e.g. ".../hello-uk.mp3" → "uk". Anything else → null. */
export function accentFromAudioUrl(url: string): string | null {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* keep raw string */
  }
  const m = ACCENT_SUFFIX.exec(pathname);
  return m ? m[1].toLowerCase() : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function normalizeFreeDictionaryResponse(raw: unknown[], requestedWord: string): FdEntry | null {
  const entries = raw.filter((e): e is Record<string, any> => e !== null && typeof e === 'object');
  if (entries.length === 0) return null;

  // Merge only entries that share the headword (case-insensitive). Prefer the word that was asked for.
  const requested = requestedWord.trim().toLowerCase();
  const headEntry = entries.find((e) => str(e.word).toLowerCase() === requested) ?? entries[0];
  const headKey = str(headEntry.word).toLowerCase();
  const merged = entries.filter((e) => str(e.word).toLowerCase() === headKey);
  const headword = str(headEntry.word);
  if (!headword) return null;

  const ipaPool: Array<{ text: string; accent: string | null }> = [];
  const audioPool: Array<{ url: string; accent: string | null }> = [];
  const pos: string[] = [];
  const senses: FdSense[] = [];
  const sourceUrls: string[] = [];
  let license: FdEntry['license'] = null;

  for (const e of merged) {
    // Top-level `phonetic` has no accent information.
    const topPhonetic = str(e.phonetic);
    if (topPhonetic) ipaPool.push({ text: topPhonetic, accent: null });

    for (const p of Array.isArray(e.phonetics) ? e.phonetics : []) {
      const audio = str(p?.audio);
      const accent = audio ? accentFromAudioUrl(audio) : null;
      const text = str(p?.text);
      if (text) ipaPool.push({ text, accent });
      if (audio) audioPool.push({ url: audio, accent });
    }

    for (const m of Array.isArray(e.meanings) ? e.meanings : []) {
      const partOfSpeech = str(m?.partOfSpeech).toLowerCase();
      if (partOfSpeech && !pos.includes(partOfSpeech)) pos.push(partOfSpeech);

      for (const d of Array.isArray(m?.definitions) ? m.definitions : []) {
        const definition = str(d?.definition);
        if (!definition) continue;
        senses.push({
          pos: partOfSpeech,
          definition,
          example: str(d?.example) || null,
          // Meaning-level lists apply to every definition of that part of speech.
          synonyms: uniqueLower([...(Array.isArray(d?.synonyms) ? d.synonyms : []), ...(Array.isArray(m?.synonyms) ? m.synonyms : [])]),
          antonyms: uniqueLower([...(Array.isArray(d?.antonyms) ? d.antonyms : []), ...(Array.isArray(m?.antonyms) ? m.antonyms : [])]),
        });
      }
    }

    if (!license && e.license && str(e.license.name)) {
      license = { name: str(e.license.name), url: str(e.license.url) };
    }
    for (const u of Array.isArray(e.sourceUrls) ? e.sourceUrls : []) {
      const url = str(u);
      if (url && !sourceUrls.includes(url)) sourceUrls.push(url);
    }
  }

  return {
    headword,
    ipa: pickByAccent(ipaPool.map((p) => ({ value: p.text, accent: p.accent }))),
    audio: pickByAccent(audioPool.map((p) => ({ value: p.url, accent: p.accent }))),
    pos,
    senses,
    license,
    sourceUrls,
  };
}

/** us / uk only when the accent is known; `any` prefers us, then uk, then the first available value. */
function pickByAccent(items: Array<{ value: string; accent: string | null }>): FdAccentValues {
  const us = items.find((i) => i.accent === 'us')?.value ?? null;
  const uk = items.find((i) => i.accent === 'uk')?.value ?? null;
  return { us, uk, any: us ?? uk ?? items[0]?.value ?? null };
}
