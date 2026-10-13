import type { FdEntry } from '../upstream/freeDictionaryClient';
import { dedupeMeanings } from './senseSelection';
import type { Attribution, EnrichmentInfo, FdOutcome, SenseResult, TemporaryBody, UpstreamBundle } from './types';

/**
 * Merging the two sources into one verdict and one response — docs/lookup-spec.md §6, §4.2.
 * Pure functions; the matrix is covered row by row in tests/lookup/merge.test.ts.
 *
 *   G = Google gave a usable translation   F = Free Dictionary has the word
 *   FD404 = Free Dictionary says "no such word"   FDerr = Free Dictionary failed (timeout, 5xx, 429, breaker…)
 */

export type FdState = FdOutcome['status']; // 'found' | 'not_found' | 'error'

export type MatrixVerdict =
  | { kind: 'full'; missing: [] }
  | { kind: 'partial'; missing: string[] }
  | { kind: 'not_found'; missing: [] }
  | { kind: 'unavailable'; missing: [] };

/** The §6 matrix, nothing else. */
export function decide(googleUsable: boolean, fd: FdState): MatrixVerdict {
  if (googleUsable && fd === 'found') return { kind: 'full', missing: [] }; // F and G
  if (fd === 'found') return { kind: 'partial', missing: ['translation_vi'] }; // F, not G
  if (googleUsable) return { kind: 'partial', missing: ['pos', 'definition_en', 'ipa', 'audio_url'] }; // G, FD404 / FDerr
  if (fd === 'not_found') return { kind: 'not_found', missing: [] }; // not G, FD404
  return { kind: 'unavailable', missing: [] }; // not G, FDerr
}

export type Merged =
  | { kind: 'not_found' }
  | { kind: 'unavailable' }
  | {
      kind: 'temporary';
      partial: boolean;
      missing: string[];
      translation_vi: string | null;
      meanings_vi: string[];
      senses: SenseResult[];
    };

const lowerFirst = (s: string): string => (s ? s.charAt(0).toLocaleLowerCase('vi') + s.slice(1) : s);

export function mergeOutcome(bundle: UpstreamBundle, maxMeanings: number): Merged {
  const googleUsable = bundle.google.status === 'ok';
  const verdict = decide(googleUsable, bundle.fd.status);
  if (verdict.kind === 'not_found') return { kind: 'not_found' };
  if (verdict.kind === 'unavailable') return { kind: 'unavailable' };

  // meanings_vi = unique([headline, ...glosses]) cut to the maximum. When Google failed it is EMPTY:
  // translation_vi is null, never the looked-up word (the old bug: "Google down → echo the word").
  const meanings = googleUsable
    ? dedupeMeanings([lowerFirst((bundle.google as { headline: string }).headline), ...bundle.step2.glosses.map(lowerFirst)], maxMeanings)
    : [];

  const missing = [...verdict.missing];
  let partial = verdict.kind === 'partial';

  // Definitions that should have been translated but were not (failure or no time left).
  if (bundle.step2.status === 'failed' || bundle.step2.status === 'skipped_no_time') {
    partial = true;
    missing.push('definition_vi');
  }
  if (bundle.deadlineExceeded) partial = true;

  return {
    kind: 'temporary',
    partial,
    missing,
    translation_vi: meanings.length > 0 ? meanings.join('; ') : null,
    meanings_vi: meanings,
    senses: bundle.step2.senses,
  };
}

/** Attribution required by Free Dictionary's data licence (Wiktionary, CC BY-SA). Empty when FD gave nothing. */
export function buildAttribution(fd: FdEntry | undefined): Attribution[] {
  if (!fd) return [];
  const license = fd.license?.name ?? '';
  const sources = fd.sourceUrls.length > 0 ? fd.sourceUrls : fd.license?.url ? [fd.license.url] : [];
  return sources.slice(0, 3).map((url) => ({ name: 'Wiktionary via Free Dictionary API', license, url }));
}

/**
 * Builds the source='translation' response. Fields that already existed in the old response keep their
 * name, position and type (pos stays a string, phonetic stays the IPA); everything else is new.
 */
export function composeTemporary(
  merged: Extract<Merged, { kind: 'temporary' }>,
  bundle: UpstreamBundle,
  displayWord: string,
  enrichment: EnrichmentInfo
): TemporaryBody {
  const fd = bundle.fd.status === 'found' ? bundle.fd.entry : undefined;
  const ipa = fd?.ipa.any ?? null;

  const providers: string[] = [];
  if (bundle.google.status === 'ok') providers.push('google_translate');
  if (fd) providers.push('free_dictionary_api');

  return {
    source: 'translation',
    temporary: true,
    word: displayWord,
    translation_vi: merged.translation_vi,
    phonetic: ipa,
    audio_url: fd?.audio.any ?? null,
    pos: fd?.pos[0] ?? null,
    definitions_en: merged.senses.map((s) => s.definition_en),
    examples: merged.senses.filter((s) => s.example_en).slice(0, 3).map((s) => ({ en: s.example_en as string, vi: null })),
    providers,
    cached: false,
    headword: fd?.headword ?? displayWord,
    pos_list: fd?.pos ?? [],
    ipa,
    meanings_vi: merged.meanings_vi,
    senses: merged.senses,
    partial: merged.partial,
    missing: merged.missing,
    attribution: buildAttribution(fd),
    enrichment,
  };
}
