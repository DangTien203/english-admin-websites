import { buildAttribution, composeTemporary, decide, FdState, mergeOutcome } from '../../services/lookup/merge';
import { isHeadlineUsable } from '../../services/lookup/upstream';
import type { UpstreamBundle } from '../../services/lookup/types';
import { realFdEntry } from './serviceHarness';

/** The §6 matrix, one test per row. */
describe('decide() — merge matrix (docs/lookup-spec.md §6)', () => {
  const rows: Array<[string, boolean, FdState, string, string[]]> = [
    ['F and G', true, 'found', 'full', []],
    ['F, not G', false, 'found', 'partial', ['translation_vi']],
    ['G, FD404', true, 'not_found', 'partial', ['pos', 'definition_en', 'ipa', 'audio_url']],
    ['G, FDerr', true, 'error', 'partial', ['pos', 'definition_en', 'ipa', 'audio_url']],
    ['not G, FD404', false, 'not_found', 'not_found', []],
    ['not G, FDerr', false, 'error', 'unavailable', []],
  ];

  it.each(rows)('%s', (_name, g, fd, kind, missing) => {
    expect(decide(g, fd)).toEqual({ kind, missing });
  });
});

describe('isHeadlineUsable (the definition of G)', () => {
  it.each([
    ['chạy', 'run', false, true],
    ['', 'run', true, false],
    ['   ', 'run', true, false],
    ['run', 'run', false, false], // untranslated echo of an unconfirmed word
    ['Run', 'run', false, false],
    ['taxi', 'taxi', true, true], // loanword confirmed by Free Dictionary
  ])('%j for %j (FD found: %s) → %s', (headline, word, fdFound, expected) => {
    expect(isHeadlineUsable(headline, word, fdFound)).toBe(expected);
  });
});

interface BundleOptions {
  googleHeadline?: string | null; // null = Google failed
  fdState?: 'found' | 'not_found' | 'error';
  step2?: UpstreamBundle['step2'];
  deadlineExceeded?: boolean;
  /** Which engine produced the meanings (default google). With haiku, `googleHeadline` is the first Haiku meaning. */
  engine?: 'google' | 'haiku';
  /** Extra meanings from the translator (Haiku returns several). */
  moreMeanings?: string[];
}

function bundle(o: BundleOptions = {}): UpstreamBundle {
  const headline = o.googleHeadline === undefined ? 'chào' : o.googleHeadline;
  const state = o.fdState ?? 'found';
  return {
    word: 'hello',
    translation:
      headline === null
        ? { status: 'error', error: new Error('down'), ms: 5 }
        : { status: 'ok', meanings: [headline, ...(o.moreMeanings ?? [])], engine: o.engine ?? 'google', ms: 5 },
    fd:
      state === 'found'
        ? { status: 'found', entry: realFdEntry('hello'), ms: 7 }
        : state === 'not_found'
          ? { status: 'not_found', ms: 7 }
          : { status: 'error', error: new Error('boom'), ms: 7 },
    step2: o.step2 ?? { status: 'ran', senses: [], glosses: [], ms: 9 },
    totalMs: 20,
    deadlineExceeded: o.deadlineExceeded ?? false,
  };
}

describe('mergeOutcome', () => {
  it('F and G: meanings are [headline, ...glosses], de-duplicated and cut to the maximum', () => {
    const b = bundle({
      googleHeadline: 'Chào',
      step2: { status: 'ran', senses: [], glosses: ['xin chào', 'chào', 'lời chào', 'chào hỏi', 'extra'], ms: 1 },
    });
    expect(mergeOutcome(b, 4)).toMatchObject({
      kind: 'temporary',
      partial: false,
      missing: [],
      meanings_vi: ['chào', 'xin chào', 'lời chào', 'chào hỏi'],
      translation_vi: 'chào; xin chào; lời chào; chào hỏi',
    });
  });

  it('REGRESSION (old bug): Google down + Free Dictionary fine → translation_vi is null, never the looked-up word', () => {
    const merged = mergeOutcome(bundle({ googleHeadline: null, fdState: 'found', step2: { status: 'skipped_no_translation', senses: [], glosses: [], ms: 0 } }), 4);
    expect(merged).toMatchObject({ kind: 'temporary', partial: true, translation_vi: null, meanings_vi: [], missing: ['translation_vi'] });
    expect((merged as any).translation_vi).not.toBe('hello');
  });

  it('G with Free Dictionary 404 or error: partial, with the documented missing list', () => {
    for (const fd of ['not_found', 'error'] as const) {
      const merged = mergeOutcome(bundle({ fdState: fd, step2: { status: 'skipped_no_fd', senses: [], glosses: [], ms: 0 } }), 4);
      expect(merged).toMatchObject({ kind: 'temporary', partial: true, missing: ['pos', 'definition_en', 'ipa', 'audio_url'], translation_vi: 'chào' });
    }
  });

  it('neither source knows the word → not_found; both failed → unavailable', () => {
    expect(mergeOutcome(bundle({ googleHeadline: null, fdState: 'not_found' }), 4)).toEqual({ kind: 'not_found' });
    expect(mergeOutcome(bundle({ googleHeadline: null, fdState: 'error' }), 4)).toEqual({ kind: 'unavailable' });
  });

  it('a failed second step keeps the result but marks definition_vi missing and partial', () => {
    const merged = mergeOutcome(bundle({ step2: { status: 'failed', senses: [], glosses: [], ms: 3 } }), 4);
    expect(merged).toMatchObject({ kind: 'temporary', partial: true, missing: ['definition_vi'] });
  });

  it('running out of time is partial even when everything else is present', () => {
    expect(mergeOutcome(bundle({ deadlineExceeded: true }), 4)).toMatchObject({ kind: 'temporary', partial: true });
  });

  it('lowercases the first letter of the headline ("Phải" → "phải")', () => {
    expect(mergeOutcome(bundle({ googleHeadline: 'Phải' }), 4)).toMatchObject({ meanings_vi: ['phải'] });
  });
});

describe('composeTemporary — response shape', () => {
  const merged = () => mergeOutcome(bundle({ step2: { status: 'ran', senses: [], glosses: ['xin chào'], ms: 1 } }), 4) as any;

  it('keeps every pre-existing field with its old name and type, and adds the new ones', () => {
    const b = bundle({ step2: { status: 'ran', senses: [{ pos: 'noun', definition_en: 'A greeting.', definition_vi: 'Lời chào.', gloss_vi: 'xin chào', example_en: 'Hello, everyone.' }], glosses: ['xin chào'], ms: 1 } });
    const body = composeTemporary(mergeOutcome(b, 4) as any, b, 'Hello', { status: 'disabled' });

    // pre-existing fields (same names, same types as the old TranslationResult)
    expect(body).toMatchObject({
      source: 'translation',
      word: 'Hello',
      translation_vi: 'chào; xin chào',
      pos: 'noun',
      definitions_en: ['A greeting.'],
      examples: [{ en: 'Hello, everyone.', vi: null }],
      providers: ['google_translate', 'free_dictionary_api'],
      cached: false,
    });
    expect(typeof body.pos).toBe('string'); // NOT string[]: the old type is kept
    expect(body.phonetic).toBe('/həˈləʊ/');
    expect(body.audio_url).toMatch(/hello-uk\.mp3$/);

    // new fields (spec §4.2)
    expect(body).toMatchObject({
      temporary: true,
      headword: 'hello',
      pos_list: ['noun', 'verb', 'interjection'],
      ipa: '/həˈləʊ/',
      meanings_vi: ['chào', 'xin chào'],
      partial: false,
      missing: [],
      enrichment: { status: 'disabled' },
    });
    expect(body.senses).toHaveLength(1);
  });

  it('never repeats the looked-up word as translation_vi when Google failed', () => {
    const b = bundle({ googleHeadline: null, step2: { status: 'skipped_no_translation', senses: [], glosses: [], ms: 0 } });
    const body = composeTemporary(mergeOutcome(b, 4) as any, b, 'hello', { status: 'disabled' });
    expect(body.translation_vi).toBeNull();
    expect(body.meanings_vi).toEqual([]);
    expect(body.providers).toEqual(['free_dictionary_api']);
  });

  it('Google only: arrays are empty, strings are null', () => {
    const b = bundle({ fdState: 'error', step2: { status: 'skipped_no_fd', senses: [], glosses: [], ms: 0 } });
    const body = composeTemporary(mergeOutcome(b, 4) as any, b, 'Taxi', { status: 'disabled' });
    expect(body).toMatchObject({ headword: 'Taxi', pos: null, pos_list: [], phonetic: null, ipa: null, audio_url: null, definitions_en: [], examples: [], senses: [], attribution: [], providers: ['google_translate'] });
  });

  it('carries the enrichment status it is given', () => {
    const b = bundle();
    expect(composeTemporary(merged(), b, 'hello', { status: 'queued' }).enrichment).toEqual({ status: 'queued' });
    expect(composeTemporary(merged(), b, 'hello', { status: 'skipped', reason: 'unknown_word' }).enrichment).toEqual({ status: 'skipped', reason: 'unknown_word' });
  });
});

describe('buildAttribution', () => {
  it('credits Wiktionary with its licence and source URL', () => {
    expect(buildAttribution(realFdEntry('hello'))).toEqual([
      { name: 'Wiktionary via Free Dictionary API', license: 'CC BY-SA 3.0', url: 'https://en.wiktionary.org/wiki/hello' },
    ]);
  });

  it('is an empty array without Free Dictionary data', () => {
    expect(buildAttribution(undefined)).toEqual([]);
  });

  it('falls back to the licence URL when there are no source URLs, and caps at 3 sources', () => {
    const e = realFdEntry('hello');
    expect(buildAttribution({ ...e, sourceUrls: [] })[0].url).toBe('https://creativecommons.org/licenses/by-sa/3.0');
    expect(buildAttribution({ ...e, sourceUrls: ['a', 'b', 'c', 'd'] })).toHaveLength(3);
  });
});
