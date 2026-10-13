import type { FdLookupResult } from '../upstream/freeDictionaryClient';
import { buildPrefixedQuery, selectSenses, splitGloss } from './senseSelection';
import type { FdOutcome, GoogleOutcome, SenseResult, Step2Outcome, UpstreamBundle } from './types';

/**
 * Steps 1 and 2 of the fast path (docs/lookup-spec.md §5 F8, F9). Everything here talks to external
 * services, so it runs under single-flight and a hard overall deadline; nothing is cached or stored.
 */

/** Below this many ms left it is not worth starting the second Google request. */
export const MIN_STEP2_MS = 300;

export interface UpstreamConfig {
  totalDeadlineMs: number;
  maxMeanings: number;
  translateDefinitions: boolean;
  maxDefinitionChars: number;
}

export interface UpstreamDeps {
  google: { translate: (texts: string[], opts?: { deadlineAt?: number }) => Promise<string[]> };
  freeDictionary: { lookup: (word: string, opts?: { deadlineAt?: number }) => Promise<FdLookupResult> };
  config: UpstreamConfig;
  /** Monotonic-ish clock in ms (injectable for tests). */
  now?: () => number;
}

// A string discriminant (not a boolean) so TypeScript narrows it even with strictNullChecks off.
type Timed<T> = { status: 'ok'; value: T; ms: number } | { status: 'err'; error: unknown; ms: number };

async function timed<T>(now: () => number, fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = now();
  try {
    return { status: 'ok', value: await fn(), ms: now() - t0 };
  } catch (error) {
    return { status: 'err', error, ms: now() - t0 };
  }
}

/** G is "usable" when non-empty; an exact echo of the word counts only if Free Dictionary confirms the word (taxi). */
export function isHeadlineUsable(headline: string, word: string, fdFound: boolean): boolean {
  const h = headline.trim();
  if (!h) return false;
  if (h.toLowerCase() === word.toLowerCase()) return fdFound;
  return true;
}

export async function fetchUpstream(word: string, deps: UpstreamDeps, opts: { startedAt?: number } = {}): Promise<UpstreamBundle> {
  const now = deps.now ?? Date.now;
  const cfg = deps.config;
  // The deadline belongs to the WHOLE lookup, so it starts when the lookup started — time already spent on
  // the local database counts (on a slow database it can be a noticeable part of the budget).
  const start = opts.startedAt ?? now();
  const deadlineAt = start + cfg.totalDeadlineMs;

  // ── Step 1: Google (headline) and Free Dictionary in parallel ──
  const [g, f] = await Promise.all([
    timed(now, async () => (await deps.google.translate([word], { deadlineAt }))[0] ?? ''),
    timed(now, () => deps.freeDictionary.lookup(word, { deadlineAt })),
  ]);

  const fd: FdOutcome =
    f.status === 'err'
      ? { status: 'error', error: f.error, ms: f.ms }
      : f.value.found
        ? { status: 'found', entry: f.value.entry, ms: f.ms }
        : { status: 'not_found', ms: f.ms };

  const fdFound = fd.status === 'found';
  let google: GoogleOutcome = g.status === 'ok' ? { status: 'ok', headline: g.value.trim(), ms: g.ms } : { status: 'error', error: g.error, ms: g.ms };
  // An unusable headline (empty, or an untranslated echo of an unconfirmed word) is "no Google result".
  if (google.status === 'ok' && !isHeadlineUsable(google.headline, word, fdFound)) {
    google = { status: 'error', error: new Error('headline unusable (empty or untranslated echo)'), ms: google.ms };
  }

  // ── Step 2: translate the selected definitions in ONE request (F9) ──
  const step2 = await runStep2(word, fd, google, deadlineAt, deps, now);

  const totalMs = now() - start;
  return { word, google, fd, step2, totalMs, deadlineExceeded: now() >= deadlineAt || step2.status === 'skipped_no_time' };
}

async function runStep2(
  word: string,
  fd: FdOutcome,
  google: GoogleOutcome,
  deadlineAt: number,
  deps: UpstreamDeps,
  now: () => number
): Promise<Step2Outcome> {
  const cfg = deps.config;
  const none = (status: Step2Outcome['status']): Step2Outcome => ({ status, senses: [], glosses: [], ms: 0 });

  if (fd.status !== 'found' || fd.entry.senses.length === 0) return none('skipped_no_fd');

  const picked = selectSenses(fd.entry.senses, cfg.maxMeanings);
  const untranslated: SenseResult[] = picked.map((p) => ({
    pos: p.pos,
    definition_en: p.definition,
    definition_vi: null,
    gloss_vi: null,
    example_en: p.example,
  }));
  const without = (status: Step2Outcome['status']): Step2Outcome => ({ status, senses: untranslated, glosses: [], ms: 0 });

  if (!cfg.translateDefinitions) return without('skipped_flag');
  if (google.status !== 'ok') return without('skipped_no_google');
  if (deadlineAt - now() < MIN_STEP2_MS) return without('skipped_no_time');

  const headword = fd.entry.headword;
  const queries = picked.map((p) => buildPrefixedQuery(headword, p.definition, cfg.maxDefinitionChars));
  const r = await timed(now, () => deps.google.translate(queries, { deadlineAt }));
  if (r.status === 'err') return { ...without('failed'), ms: r.ms, error: r.error };

  // An echoed gloss is a real answer only for loanwords: the headline echoed the word too.
  const keepEcho = google.headline.toLowerCase() === word.toLowerCase();
  const senses: SenseResult[] = untranslated.map((s, i) => {
    const split = splitGloss(r.value[i] ?? '', headword, keepEcho);
    return { ...s, gloss_vi: split.gloss_vi, definition_vi: split.definition_vi };
  });
  return { status: 'ran', senses, glosses: senses.map((s) => s.gloss_vi).filter((x): x is string => Boolean(x)), ms: r.ms };
}
