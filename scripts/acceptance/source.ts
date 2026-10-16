/**
 * Free Dictionary as the acceptance run sees it (docs/lookup-runbook.md §12): a direct probe of the real service before the run, the
 * signs in the lookups themselves that it was failing (so the run can wait for the circuit breaker of the server to close), and the
 * wording of the "cannot be judged" rows. Apart from the probe's fetch there is no I/O here, so it is tested with plain objects
 * (tests/acceptance/source.test.ts).
 *
 * The probe talks to Free Dictionary DIRECTLY, not through the server: the server's breaker counts failures, and a probe that went
 * through it would be one of the things that open it.
 */
import { isSourceOutage, type FastObservation, type SourceHealth } from './evaluate';
import { RUN_ORDER, type Group } from './words';

/**
 * Three ordinary words, ONE PER ATTEMPT. Not a single sample word, and not `hello`: on 16/10/2026 the service answered `hello` in 0.2 s
 * (its CDN had it cached) while every other word hung for more than 8 s, so a probe on `hello` called a dead service healthy.
 */
export const PROBE_WORDS: readonly string[] = ['house', 'water', 'tree'];
export const PROBE_ATTEMPTS = 3;
export const PROBE_GAP_MS = 500;

export interface ProbeAttempt {
  /** the word asked for in this attempt */
  word: string;
  ok: boolean;
  /** HTTP status, null when there was no answer (timeout, network error) */
  status: number | null;
  ms: number;
  /** short code: timeout, http_503, not_a_word_list, TypeError … */
  error: string | null;
}

export interface ProbeResult {
  words: string[];
  attempts: ProbeAttempt[];
  /** every attempt answered 200 with a non-empty list of entries within the timeout */
  healthy: boolean;
}

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Asks Free Dictionary for one word, PROBE_ATTEMPTS times in a row. Healthy only when ALL of them answer: a source that fails one
 * request in three will time out a good share of a 30-word run, and that is the case in which a verdict on the words is not fair.
 */
export async function probeFreeDictionary(baseUrl: string, timeoutMs: number, deps: ProbeDeps = {}, words: string | readonly string[] = PROBE_WORDS, attempts: number = PROBE_ATTEMPTS): Promise<ProbeResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => performance.now());
  const list = typeof words === 'string' ? [words] : words;
  const base = baseUrl.replace(/\/+$/, '');

  const out: ProbeAttempt[] = [];
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(PROBE_GAP_MS);
    const word = list[i % list.length];
    const url = `${base}/${encodeURIComponent(word)}`;
    const started = now();
    try {
      const res = await doFetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      const body: unknown = await res.json().catch(() => null);
      const ok = res.status === 200 && Array.isArray(body) && body.length > 0;
      out.push({ word, ok, status: res.status, ms: Math.round(now() - started), error: ok ? null : res.status === 200 ? 'not_a_word_list' : `http_${res.status}` });
    } catch (err: any) {
      const name = String(err?.name ?? 'Error');
      out.push({ word, ok: false, status: null, ms: Math.round(now() - started), error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name });
    }
  }
  return { words: [...new Set(out.map((a) => a.word))], attempts: out, healthy: out.length === attempts && out.every((a) => a.ok) };
}

/**
 * Does this lookup show Free Dictionary failing? Only the cases the spec makes unambiguous:
 *   - 503 TRANSLATION_UNAVAILABLE in any group (§6 "không G, FDerr": the only way to get it),
 *   - in C, D and H (words Free Dictionary knows): a 200 temporary answer that lacks the part of speech, i.e. it gave nothing.
 * A 404 for a proper noun or a garbage word is NOT evidence: Free Dictionary legitimately does not have those.
 */
export function fdFailureEvidence(group: Group, obs: FastObservation): boolean {
  if (isSourceOutage(obs)) return true;
  if ((group === 'C' || group === 'D' || group === 'H') && obs.status === 200 && obs.body?.data?.source === 'translation') {
    const missing = obs.body.data.missing;
    return Array.isArray(missing) && missing.includes('pos');
  }
  return false;
}

/**
 * Does the end of the history look like an OPEN circuit breaker? The server's breaker opens after UPSTREAM_BREAKER_FAILURE_THRESHOLD
 * failures in a row. `history` has one entry per lookup that reached Free Dictionary, in order, true = fdFailureEvidence.
 */
export function breakerLikelyOpen(history: readonly boolean[], threshold: number): boolean {
  if (!(threshold >= 1) || history.length < threshold) return false;
  return history.slice(-threshold).every(Boolean);
}

/** How long to wait before the next group: the breaker stays open UPSTREAM_BREAKER_RESET_MS after its last failure, plus a margin. */
export function breakerWaitMs(lastEvidenceAt: number, now: number, resetMs: number, marginMs: number = 2000): number {
  return Math.max(0, lastEvidenceAt + resetMs + marginMs - now);
}

/**
 * One more look at ONE word, after the fast path: does Free Dictionary have it?
 *   has     it answers 200 with entries NOW, although the server got nothing from it when it looked the word up (a timeout, a bad
 *           response or an open circuit breaker at that moment): the source was failing, the word is fine;
 *   absent  it answers 404: it really does not have the word, so an empty answer was correct (and the word is a bad choice);
 *   error   it does not answer this time either.
 * The sample word of the probe (`hello`) is cached by the service's CDN and always answers; an uncached word is where it struggles.
 */
export type WordCheck = 'has' | 'absent' | 'error';

export function classifyWordCheck(attempt: ProbeAttempt | undefined): WordCheck {
  if (attempt?.ok) return 'has';
  if (attempt?.status === 404) return 'absent';
  return 'error';
}

/** What was known about Free Dictionary when a word was looked up, at the end of the fast path, and (for one word) when asked again. */
export function sourceHealthFor(at: { probeHealthy: boolean | null; breakerOpen: boolean }, endProbeHealthy: boolean | null, wordCheck: WordCheck | null = null): SourceHealth {
  if (at.breakerOpen) return { unhealthy: true, why: 'mạch ngắt Free Dictionary đang mở sau nhiều lần lỗi liên tiếp' };
  if (at.probeHealthy === false) return { unhealthy: true, why: 'lần thăm dò Free Dictionary trước đó không khỏe' };
  if (endProbeHealthy === false) return { unhealthy: true, why: 'lần thăm dò Free Dictionary sau lượt tra không khỏe' };
  if (wordCheck === 'has') return { unhealthy: true, why: 'thăm dò lại đúng từ này thì Free Dictionary có dữ liệu, nhưng máy chủ không nhận được gì lúc tra (timeout, phản hồi hỏng hoặc mạch ngắt)' };
  if (wordCheck === 'error') return { unhealthy: true, why: 'thăm dò lại đúng từ này, Free Dictionary vẫn không trả lời' };
  return { unhealthy: false, why: wordCheck === 'absent' ? 'Free Dictionary không có từ này (404 khi thăm dò lại)' : 'Free Dictionary khỏe' };
}

/** The command that runs again only the groups that could not be judged (in the order they are run). */
export function rerunCommand(groups: Iterable<Group>, baseUrl: string): string {
  const wanted = new Set(groups);
  const list = RUN_ORDER.filter((g) => wanted.has(g));
  return `npm run acceptance:lookup -- --staging --only ${list.join(',')} --base-url ${baseUrl}`;
}

export function describeProbe(p: ProbeResult): string {
  return p.attempts.map((a, i) => `lần ${i + 1} (${a.word}): ${a.ok ? 'OK' : (a.error ?? 'lỗi')}${a.status !== null ? ` (HTTP ${a.status})` : ''} ${a.ms} ms`).join('; ');
}
