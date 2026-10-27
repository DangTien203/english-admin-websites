/**
 * The parts of the Oxford seeding that need no database: the file reader (merging, lowest level, what is kept and what never is), the
 * choice of words (order, filters, stratified sample), the command-line parsers, the estimates, the worker-log reader.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseApplyCefrArgs, parsePublishArgs, parseSeedArgs, selectionFromArgs } from '../../services/enrichment/oxford/args';
import { readOxfordFile, parseOxford, coverageOf, cefrRank, type OxfordWord } from '../../services/enrichment/oxford/list';
import { estimateRun, isFinalOutcome, endedInLiveEntry, DEFAULT_COST_PER_WORD_USD, MAX_INVALID_OUTPUT_RUNS, costFromTotals, formatDuration } from '../../services/enrichment/oxford/plan';
import { parseInvalidOutputs, parseWorkerLog, percentile } from '../../services/enrichment/oxford/report';
import { bySendOrder, fnv1a, parseCefrList, selectWords, stratifiedSample, type SeedWord } from '../../services/enrichment/oxford/selection';
import { parseAutoNote, OXFORD_CEFR_MARK } from '../../utils/autoEntryNote';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'oxford', 'oxford_small.json');

describe('reading the Oxford file', () => {
  const parsed = readOxfordFile(FIXTURE);
  const byWord = new Map(parsed.words.map((w) => [w.word, w]));

  it('merges the rows of one word (case-insensitive) into ONE word, with all its parts of speech and its LOWEST level', () => {
    expect(parsed.rows).toBe(16);
    const apple = byWord.get('apple')!;
    expect(apple).toMatchObject({ pos: ['noun'], cefr: 'A1', levels: ['A1', 'B1'], rows: 2 });
    const run = byWord.get('run')!;
    expect(run).toMatchObject({ pos: ['verb', 'noun'], cefr: 'A1', levels: ['A1', 'B1', 'C1'], rows: 3, primaryPos: 'verb' });
    expect(parsed.mergedWords).toBe(3); // apple, run, major
    expect(parsed.mergedExtraRows).toBe(1 + 2 + 1);
    expect(parsed.multiLevelWords).toBe(2); // apple, run
  });

  it('a blank level is not a level: the other rows of the word decide, and a word with no level at all has null', () => {
    expect(byWord.get('major')).toMatchObject({ cefr: 'B2', pos: ['noun', 'adjective'], primaryPos: 'adjective' });
    expect(byWord.get('accounting')!.cefr).toBeNull();
    expect(parsed.rowsWithoutLevel).toBe(2); // the blank rows of major and accounting; the nameless row is counted apart
    expect(parsed.rowsWithoutWord).toBe(1);
  });

  it('accepts a lower-case level and normalises it', () => {
    expect(byWord.get('dog')!.cefr).toBe('A1');
    expect(byWord.get('zebra')!.cefr).toBe('C2');
  });

  it('runs the lookup cleaner: several words and odd characters go to the skip list with their kind, hyphen and apostrophe words pass', () => {
    expect(parsed.invalid.map((w) => [w.word, w.category])).toEqual([
      ['ice cream', 'multi_word'],
      ['x1y', 'other'],
    ]);
    expect(byWord.has('well-being')).toBe(true);
    expect(byWord.has("o'clock")).toBe(true);
    expect(byWord.has('Well-Being')).toBe(false); // lower-cased
  });

  it('keeps ONLY word, parts of speech, level and "has IPA / audio": no definition, example or link survives', () => {
    const json = JSON.stringify(parsed);
    expect(json).not.toContain('FIXTURE-EXAMPLE-NOT-FOR-USE');
    expect(json).not.toContain('FIXTURE-DEFINITION-NOT-FOR-USE');
    expect(json).not.toContain('example.invalid');
    for (const w of parsed.words) expect(Object.keys(w).sort()).toEqual(['cefr', 'hasAudioUk', 'hasAudioUs', 'hasIpa', 'levels', 'pos', 'primaryPos', 'rows', 'word']);
  });

  it('counts IPA and audio without keeping them', () => {
    expect(byWord.get('apple')).toMatchObject({ hasIpa: true, hasAudioUs: true, hasAudioUk: true });
    expect(byWord.get('run')).toMatchObject({ hasIpa: true, hasAudioUs: true, hasAudioUk: true });
    expect(byWord.get('zebra')).toMatchObject({ hasIpa: false, hasAudioUs: false, hasAudioUk: false });
    const cov = coverageOf(parsed.words);
    expect(cov.words).toBe(parsed.words.length);
    expect(cov.audioUs).toBe(parsed.words.filter((w) => w.hasAudioUs).length);
  });

  it('also reads the flat shape of docs/reference/import-oxford.mjs (word, type, cefr, phon_br, phon_n_am, uk, us)', () => {
    const flat = parseOxford([
      { word: 'Table', type: 'noun', cefr: 'a2', phon_br: '/t/', phon_n_am: '', uk: 'table_uk.mp3', us: '', definition: 'DEFINITION-NOT-FOR-USE', example: 'EXAMPLE-NOT-FOR-USE' },
      { word: 'table', type: 'verb', cefr: 'B2' },
    ]);
    expect(flat.words).toHaveLength(1);
    expect(flat.words[0]).toMatchObject({ word: 'table', pos: ['noun', 'verb'], cefr: 'A2', hasIpa: true, hasAudioUk: true, hasAudioUs: false });
    expect(JSON.stringify(flat)).not.toMatch(/NOT-FOR-USE/);
  });

  it('refuses a file that is not an array, and says so for a file that does not exist or is not JSON', () => {
    expect(() => parseOxford({ words: [] })).toThrow(/JSON array/);
    expect(() => readOxfordFile(path.join(__dirname, 'no-such-file.json'))).toThrow(/Cannot read/);
    const bad = path.join(require('node:os').tmpdir(), `oxford-bad-${Date.now()}.json`);
    fs.writeFileSync(bad, '{ not json');
    try {
      expect(() => readOxfordFile(bad)).toThrow(/not valid JSON/);
    } finally {
      fs.unlinkSync(bad);
    }
  });

  it('sorts levels A1 < … < C2 < none', () => {
    expect(['C1', 'A2', null, 'A1', 'B2'].sort((a, b) => cefrRank(a) - cefrRank(b))).toEqual(['A1', 'A2', 'B2', 'C1', null]);
  });
});

// ── selection ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const seed = (word: string, cefr: SeedWord['cefr'], primaryPos: string | null = 'noun', rank: number | null = null): SeedWord => ({
  word,
  pos: primaryPos ? [primaryPos] : [],
  primaryPos,
  cefr,
  levels: cefr ? [cefr] : [],
  rows: 1,
  hasIpa: true,
  hasAudioUs: true,
  hasAudioUk: true,
  rank,
});

describe('which words are sent, and in which order', () => {
  const pool = [seed('zeta', 'B1', 'noun', 5), seed('alpha', 'A1', 'noun', 900), seed('beta', 'A1', 'verb', 10), seed('gamma', 'A1', 'noun', null), seed('delta', 'A2', 'noun', 1), seed('omega', null, 'noun', 2)];

  it('CEFR ascending, then frequency (rank 1 first, no rank last), then alphabetical; words with no level last', () => {
    expect([...pool].sort(bySendOrder).map((w) => w.word)).toEqual(['beta', 'alpha', 'gamma', 'delta', 'zeta', 'omega']);
  });

  it('--only-cefr keeps the levels asked for; --offset and --limit cut the ordered list', () => {
    expect(selectWords(pool, { onlyCefr: ['A1'] }).map((w) => w.word)).toEqual(['beta', 'alpha', 'gamma']);
    expect(selectWords(pool, { onlyCefr: ['A1', 'B1'] }).map((w) => w.word)).toEqual(['beta', 'alpha', 'gamma', 'zeta']);
    expect(selectWords(pool, { offset: 1, limit: 2 }).map((w) => w.word)).toEqual(['alpha', 'gamma']);
    expect(selectWords(pool, { offset: 10 })).toEqual([]);
  });

  it('refuses nonsense: --sample with --limit or --offset, a negative offset, a zero limit', () => {
    expect(() => selectWords(pool, { sample: 3, limit: 2 })).toThrow(/cannot be combined/);
    expect(() => selectWords(pool, { sample: 3, offset: 1 })).toThrow(/cannot be combined/);
    expect(() => selectWords(pool, { offset: -1 })).toThrow(/non-negative/);
    expect(() => selectWords(pool, { limit: 0 })).toThrow(/positive/);
  });

  it('parses the level list, case-insensitively, and refuses a value that is not a level', () => {
    expect(parseCefrList('a1, B2,A1')).toEqual(['A1', 'B2']);
    expect(() => parseCefrList('A1,D9')).toThrow(/D9/);
    expect(() => parseCefrList(' , ')).toThrow(/at least one/);
  });

  describe('the stratified sample', () => {
    const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'] as const;
    const POS = ['noun', 'verb', 'adjective', 'adverb', 'preposition'];
    const big: SeedWord[] = [];
    for (const level of LEVELS) for (let i = 0; i < 40; i++) big.push(seed(`${level.toLowerCase()}w${i}`, level, POS[i % POS.length], i + 1));

    it('takes the same number from every level, with the parts of speech mixed inside each', () => {
      const picked = stratifiedSample(big, 50);
      expect(picked).toHaveLength(50);
      for (const level of LEVELS) {
        const inLevel = picked.filter((w) => w.cefr === level);
        expect(inLevel).toHaveLength(10);
        expect(new Set(inLevel.map((w) => w.primaryPos)).size).toBe(POS.length); // all five parts of speech are there
      }
    });

    it('is the same on every run (hash, not Math.random) and does not depend on the input order', () => {
      const a = stratifiedSample(big, 50).map((w) => w.word).sort();
      const b = stratifiedSample([...big].reverse(), 50).map((w) => w.word).sort();
      expect(a).toEqual(b);
      expect(fnv1a('x')).toBe(fnv1a('x'));
      expect(fnv1a('x')).not.toBe(fnv1a('y'));
    });

    it('gives the remainder to the lowest levels, and the share of a thin level to the others', () => {
      expect(stratifiedSample(big, 52).filter((w) => w.cefr === 'A1')).toHaveLength(11);
      const thin = [...big.filter((w) => w.cefr !== 'C1'), ...big.filter((w) => w.cefr === 'C1').slice(0, 3)];
      const picked = stratifiedSample(thin, 50);
      expect(picked).toHaveLength(50);
      expect(picked.filter((w) => w.cefr === 'C1')).toHaveLength(3);
      expect(picked.filter((w) => w.cefr === 'A1')).toHaveLength(12); // (50 - 3) / 4 = 11.75 → the remainder goes to the lowest levels
    });

    it('never returns more than exist, never a word with no level, and nothing for an empty pool', () => {
      expect(stratifiedSample(big.slice(0, 7), 50)).toHaveLength(7);
      expect(stratifiedSample([seed('nolevel', null)], 5)).toEqual([]);
      expect(stratifiedSample([], 5)).toEqual([]);
      expect(() => stratifiedSample(big, 0)).toThrow(/positive/);
    });

    it('selectWords sorts the sample into sending order and honours --only-cefr', () => {
      const out = selectWords(big, { sample: 10, onlyCefr: ['B1', 'B2'] });
      expect(out).toHaveLength(10);
      expect(out.every((w) => w.cefr === 'B1' || w.cefr === 'B2')).toBe(true);
      expect(out).toEqual([...out].sort(bySendOrder));
    });
  });
});

// ── arguments ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('command-line parsing', () => {
  it('reads every option of enrich:seed-oxford', () => {
    const a = parseSeedArgs(['--file', 'x.json', '--limit', '10', '--offset', '5', '--only-cefr', 'A1,A2', '--confirm', '--allow-auto']);
    expect(a).toMatchObject({ file: 'x.json', limit: 10, offset: 5, onlyCefr: 'A1,A2', confirm: true, allowAuto: true, dryRun: false, report: false });
    expect(parseSeedArgs(['--sample', '50']).sample).toBe(50);
    expect(parseSeedArgs(['--report', '--worker-log', 'w.log'])).toMatchObject({ report: true, workerLog: 'w.log' });
  });

  it('is a dry run unless --confirm: nothing in the arguments says "send" by default', () => {
    expect(parseSeedArgs(['--file', 'x.json'])).toMatchObject({ confirm: false });
  });

  it.each([['--confirmed'], ['--yes'], ['-y'], ['--force'], ['confirm'], ['--CONFIRM'], ['--confirm=true']])('refuses an option it does not know: %s', (flag) => {
    expect(() => parseSeedArgs([flag])).toThrow(/Unknown option/);
    expect(() => parsePublishArgs([flag])).toThrow(/Unknown option/);
    expect(() => parseApplyCefrArgs([flag])).toThrow(/Unknown option/);
  });

  it('refuses contradictions and bad values', () => {
    expect(() => parseSeedArgs(['--dry-run', '--confirm'])).toThrow(/cannot be used together/);
    expect(() => parseSeedArgs(['--sample', '5', '--limit', '3'])).toThrow(/cannot be combined/);
    expect(() => parseSeedArgs(['--report', '--confirm'])).toThrow(/--report/);
    expect(() => parseSeedArgs(['--limit', 'ten'])).toThrow(/whole number/);
    expect(() => parseSeedArgs(['--limit', '-3'])).toThrow(/whole number|needs/);
    expect(() => parseSeedArgs(['--file'])).toThrow(/needs a value/);
    expect(() => parseSeedArgs(['--file', '--confirm'])).toThrow(/needs a value/);
    expect(() => parseSeedArgs(['--only-cefr', 'Z9'])).toThrow(/Z9/);
    expect(() => parseSeedArgs(['--limit', '0'])).toThrow(/positive/);
  });

  it('describes the selection in words', () => {
    expect(selectionFromArgs(parseSeedArgs(['--sample', '50'])).text).toBe('mẫu phân tầng 50 từ');
    expect(selectionFromArgs(parseSeedArgs(['--only-cefr', 'A1', '--offset', '10', '--limit', '20'])).text).toBe('chỉ mức A1, bỏ 10 từ đầu, tối đa 20 từ');
    expect(selectionFromArgs(parseSeedArgs([])).text).toBe('toàn bộ phần còn lại');
  });

  it('enrich:publish defaults to 500 and a dry run; oxford:apply-cefr reads --file and --dry-run', () => {
    expect(parsePublishArgs([])).toMatchObject({ limit: 500, confirm: false, dryRun: false });
    expect(parsePublishArgs(['--cefr', 'A1,A2', '--limit', '100', '--confirm'])).toMatchObject({ cefr: 'A1,A2', limit: 100, confirm: true });
    expect(() => parsePublishArgs(['--dry-run', '--confirm'])).toThrow(/cannot be used together/);
    expect(() => parsePublishArgs(['--cefr', 'Q'])).toThrow(/not a CEFR level/);
    expect(parseApplyCefrArgs(['--file', 'x.json', '--dry-run'])).toEqual({ file: 'x.json', dryRun: true });
    expect(parseApplyCefrArgs(['--file', 'x.json']).dryRun).toBe(false);
  });
});

// ── estimates ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('estimates', () => {
  const noHistory = { jobsWithTokens: 0, inputTokens: 0, outputTokens: 0, wallSecondsPerWord: null, avgAttempts: null };

  it('without history it says so and uses 0.00085 USD a word and 10 seconds a word', () => {
    const e = estimateRun({ words: 1000, model: 'claude-haiku-5-5', history: noHistory, concurrency: 4, dailyCap: 500, usedToday: 0 });
    expect(e).toMatchObject({ costSource: 'default', timeSource: 'default', costPerWordUsd: DEFAULT_COST_PER_WORD_USD, secondsPerWord: 2.5 });
    expect(e.costUsd).toBeCloseTo(0.85, 6);
    expect(e.workerSeconds).toBe(2500); // 1000 words × 10 s of work shared by 4 workers
  });

  it('with enough history it uses the real average: input minus the cached prompt at the cache-read rate', () => {
    // 10 jobs, each 9000 input tokens (7859 cached) and 1000 output tokens
    const history = { jobsWithTokens: 10, inputTokens: 90_000, outputTokens: 10_000, wallSecondsPerWord: 4.5, avgAttempts: 1.1 };
    const e = estimateRun({ words: 100, model: 'claude-haiku-5-5', history, concurrency: 2, dailyCap: 500, usedToday: 0 });
    const perJob = ((9000 - 7859) * 0.1 + 1000 * 0.5 + 7859 * 0.01) / 1_000_000;
    expect(e.costSource).toBe('history');
    expect(e.costPerWordUsd).toBeCloseTo(perJob, 9);
    expect(e.secondsPerWord).toBe(4.5); // wall clock, as measured: it is NOT divided by the concurrency again
    expect(e.workerSeconds).toBe(450);
  });

  it('too little history (under 5 jobs) or an unknown model falls back to the default', () => {
    expect(estimateRun({ words: 10, model: 'claude-haiku-5-5', history: { ...noHistory, jobsWithTokens: 4, inputTokens: 40_000, outputTokens: 4_000 }, concurrency: 2, dailyCap: 500, usedToday: 0 }).costSource).toBe('default');
    expect(estimateRun({ words: 10, model: 'some-other-model', history: { ...noHistory, jobsWithTokens: 50, inputTokens: 500_000, outputTokens: 50_000 }, concurrency: 2, dailyCap: 500, usedToday: 0 }).costSource).toBe('default');
    expect(costFromTotals('some-other-model', 5, 1, 1)).toBeNull();
  });

  it('counts the days against the daily cap, taking what today already used into account', () => {
    const base = { model: 'claude-haiku-5-5', history: noHistory, concurrency: 2, dailyCap: 500 };
    expect(estimateRun({ ...base, words: 500, usedToday: 0 }).days).toBe(1);
    expect(estimateRun({ ...base, words: 501, usedToday: 0 }).days).toBe(2);
    expect(estimateRun({ ...base, words: 100, usedToday: 450 }).days).toBe(2); // 50 left today, 50 tomorrow
    expect(estimateRun({ ...base, words: 4100, usedToday: 0 }).days).toBe(9);
    expect(estimateRun({ ...base, words: 0, usedToday: 0 }).days).toBe(0);
    expect(estimateRun({ ...base, dailyCap: 0, words: 5, usedToday: 0 }).days).toBe(Infinity);
  });

  it('formats a duration for people', () => {
    expect(formatDuration(45)).toBe('45 giây');
    expect(formatDuration(600)).toBe('10 phút');
    expect(formatDuration(7200)).toBe('2.0 giờ');
  });
});

describe('which earlier outcomes close a word', () => {
  it.each([
    ['rejected', 'proper_noun', true],
    ['rejected', 'unknown_word', true],
    ['skipped', 'variant_form', true],
    ['skipped', 'lemma_mismatch', true],
    ['failed', 'invalid_output', false], // the first invalid_output is tried once more
    ['succeeded', null, false], // not by its status alone: endedInLiveEntry looks at the entry itself
    ['skipped', 'exists', false],
    ['skipped', 'budget', false],
    ['skipped', 'duplicate', false],
    ['failed', 'upstream_error', false],
    ['failed', 'config_error', false],
    ['failed', 'dead_letter', false],
    ['failed', 'stale', false],
    ['queued', null, false],
  ])('%s / %s → %s', (status, reason, final) => {
    expect(isFinalOutcome(status as string, reason as string | null)).toBe(final);
  });
});

// ── the worker log and numbers ─────────────────────────────────────────────────────────────────────────────────────────

describe('a job that ended in an entry that still exists', () => {
  it.each([
    ['succeeded', null, true, true],
    ['skipped', 'exists', true, true],
    ['succeeded', null, false, false], // the entry was deleted since: the word is eligible again
    ['skipped', 'exists', false, false],
    ['failed', 'upstream_error', true, false], // an entry_id on a job that did not succeed closes nothing
    ['failed', 'invalid_output', true, false],
    ['skipped', 'budget', true, false],
  ])('%s / %s, entry alive %s → %s', (status, reason, alive, closes) => {
    expect(endedInLiveEntry(status as string, reason as string | null, alive as boolean)).toBe(closes);
  });
});

describe('invalid_output is final after two runs', () => {
  it('one run → not final, two or more → final; the other failures never depend on the count', () => {
    expect(isFinalOutcome('failed', 'invalid_output', 1)).toBe(false);
    expect(isFinalOutcome('failed', 'invalid_output', 2)).toBe(true);
    expect(isFinalOutcome('failed', 'invalid_output', 5)).toBe(true);
    expect(isFinalOutcome('failed', 'upstream_error', 9)).toBe(false);
    expect(isFinalOutcome('rejected', 'proper_noun', 1)).toBe(true);
    expect(MAX_INVALID_OUTPUT_RUNS).toBe(2);
  });
});

describe('--retry-last-run and --from-run', () => {
  it('--retry-last-run is its own mode: it sends the words of the latest run and takes no selection option', () => {
    expect(parseSeedArgs(['--file', 'x.json', '--retry-last-run', '--confirm'])).toMatchObject({ retryLastRun: true, confirm: true });
    expect(parseSeedArgs(['--file', 'x.json']).retryLastRun).toBe(false);
    for (const extra of [['--limit', '5'], ['--offset', '2'], ['--sample', '5'], ['--only-cefr', 'A1']]) {
      expect(() => parseSeedArgs(['--retry-last-run', ...extra])).toThrow(/--retry-last-run cannot be combined/);
    }
    expect(() => parseSeedArgs(['--retry-last-run', '--report'])).toThrow(/cannot be combined with --report/);
    expect(selectionFromArgs(parseSeedArgs(['--retry-last-run'])).text).toContain('gửi lại');
  });

  it('--from-run goes with --report only, and needs a positive number', () => {
    expect(parseSeedArgs(['--report', '--from-run', '2']).fromRun).toBe(2);
    expect(() => parseSeedArgs(['--from-run', '2'])).toThrow(/only goes with --report/);
    expect(() => parseSeedArgs(['--report', '--from-run', '0'])).toThrow(/positive/);
    expect(() => parseSeedArgs(['--report', '--from-run', 'x'])).toThrow(/whole number/);
  });
});

describe('invalid_output lines of the worker log', () => {
  const log = [
    JSON.stringify({ evt: 'enrich', word: 'a', job_id: 'job-a', output_tokens: 4300, status: 'failed', reason: 'invalid_output', issues: [{ path: 'senses[0].meanings_vi[2]', code: 'parenthesis' }], first_issues: [{ path: 'senses[3].definition_en', code: 'too_long' }] }),
    JSON.stringify({ evt: 'enrich', word: 'b', status: 'failed', reason: 'invalid_output' }), // an older worker: no detail
    JSON.stringify({ evt: 'enrich', word: 'c', status: 'failed', reason: 'config_error' }),
    JSON.stringify({ evt: 'enrich', word: 'd', status: 'succeeded' }),
    '{ not json',
  ].join('\n');

  it('keeps only the invalid_output lines, with the rules and the field paths with their indexes taken out', () => {
    expect(parseInvalidOutputs(log)).toEqual([
      { word: 'a', jobId: 'job-a', outputTokens: 4300, issues: [{ code: 'parenthesis', path: 'senses[].meanings_vi[]' }], firstIssues: [{ code: 'too_long', path: 'senses[].definition_en' }] },
      { word: 'b', jobId: null, outputTokens: null, issues: [], firstIssues: [] },
    ]);
  });
});

describe('the worker log reader', () => {
  const log = [
    'Enrichment worker running',
    JSON.stringify({ evt: 'enrich', word: 'a', status: 'succeeded', attempt: 1, duration_ms: 8000, stages_ms: { s3_haiku: 5000 } }),
    JSON.stringify({ evt: 'enrich', word: 'b', status: 'succeeded', attempt: 1, duration_ms: 12000, stages_ms: { s3_haiku: 7000 } }),
    JSON.stringify({ evt: 'enrich_retry', word: 'c', attempt: 1 }),
    JSON.stringify({ evt: 'enrich', word: 'c', status: 'succeeded', attempt: 2, duration_ms: 20000, stages_ms: { s3_haiku: 9000 } }),
    '2026-10-20T10:00:00 {"evt":"breaker","provider":"x"}',
    '{ not json',
    JSON.stringify({ evt: 'enrich', word: 'd', status: 'failed', reason: 'config_error' }), // no duration: ignored
  ].join('\n');

  it('collects durations, Haiku time, attempts and retries; ignores everything else', () => {
    const s = parseWorkerLog(log);
    expect(s).toMatchObject({ jobs: 3, medianMs: 12000, maxMs: 20000, retries: 1, attempts: { '1': 2, '2': 1 } });
    expect(s.meanHaikuMs).toBeCloseTo(7000);
    expect(s.p95Ms).toBeCloseTo(19200);
  });

  it('an empty log gives nulls, not NaN', () => {
    expect(parseWorkerLog('')).toMatchObject({ jobs: 0, medianMs: null, p95Ms: null, maxMs: null, meanHaikuMs: null });
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
  });
});

describe('the note of an entry that carries the Oxford mark', () => {
  const base = '[auto] nguồn: wiktionary, haiku · model: claude-haiku-5-5 · job: j1 · published=false: chờ duyệt (x) · ước tính: cefr_level=B2 · ghi chú của Haiku: nghĩa A hiếm | nghĩa B';

  it('the mark after the notes of Haiku is its own part: it does not become a review note (which could change who may be published)', () => {
    const parsed = parseAutoNote(`${base} · ${OXFORD_CEFR_MARK}`);
    expect(parsed.review_notes).toEqual(['nghĩa A hiếm', 'nghĩa B']);
    expect(parsed.other).toEqual([OXFORD_CEFR_MARK]);
  });

  it('a note without the mark parses as before', () => {
    expect(parseAutoNote(base).review_notes).toEqual(['nghĩa A hiếm', 'nghĩa B']);
    expect(parseAutoNote(base).other).toEqual([]);
  });
});

describe('word type used in tests', () => {
  it('OxfordWord has no field that could carry Oxford content', () => {
    const w: OxfordWord = { word: 'x', pos: [], primaryPos: null, cefr: null, levels: [], rows: 1, hasIpa: false, hasAudioUs: false, hasAudioUk: false };
    expect(Object.keys(w)).not.toEqual(expect.arrayContaining(['definition', 'example', 'examples']));
  });
});
