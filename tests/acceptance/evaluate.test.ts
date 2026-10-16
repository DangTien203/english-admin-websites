import { PassThrough } from 'node:stream';
import {
  combine,
  evaluateFast,
  evaluateFormRow,
  evaluateGoogleChars,
  evaluateJob,
  evaluateLatency,
  hasDistinctSenses,
  meaningParts,
  percentile,
  summarizeFast,
  tierAMissing,
  type EntryObservation,
  type FastObservation,
  type JobObservation,
  type JobRowObservation,
} from '../../scripts/acceptance/evaluate';
import { confirmDatabaseName, describeDatabase, readCredentials } from '../../scripts/acceptance/db';
import {
  ALL_ACCEPTANCE_WORDS,
  checkPrecondition,
  FALLBACK_WORDS,
  GROUP_ORDER,
  GROUP_WORDS,
  jobExpectation,
  planWords,
  type Group,
  type WordFacts,
} from '../../scripts/acceptance/words';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── sample responses (shapes of docs/lookup-api.md) ─────────────────────────────────────────────────────────────────

const ok = (data: object, ms = 400): FastObservation => ({ status: 200, ms, body: { success: true, data } });
const err = (status: number, code: string, ms = 300): FastObservation => ({ status, ms, body: { success: false, error: { code, message: 'x' } } });

const dictionaryHit = (extra: object = {}) => ok({ source: 'dictionary', headword: 'run', ...extra });
const temporary = (over: Record<string, any> = {}) =>
  ok({
    source: 'translation',
    temporary: true,
    word: 'serendipity',
    translation_vi: 'sự tình cờ may mắn',
    meanings_vi: ['sự tình cờ may mắn'],
    senses: [{ pos: 'noun', definition_en: 'x', gloss_vi: 'may mắn', definition_vi: 'y', example_en: null }],
    partial: false,
    missing: [],
    enrichment: { status: 'queued' },
    ...over,
  });

const reasons = (v: { reasons: string[] }) => v.reasons.join(' | ');

describe('evaluateFast — group A (already in the dictionary)', () => {
  it('passes: 200, source=dictionary, no temporary', () => {
    expect(evaluateFast('A', 'run', dictionaryHit())).toEqual({ verdict: 'pass', reasons: [] });
  });
  it('fails when the answer is a temporary translation', () => {
    const v = evaluateFast('A', 'run', temporary());
    expect(v.verdict).toBe('fail');
    expect(reasons(v)).toContain('source=translation');
    expect(reasons(v)).toContain('temporary');
  });
  it('fails on a 404, naming the status and the code', () => {
    expect(reasons(evaluateFast('A', 'run', err(404, 'ENTRY_NOT_FOUND')))).toBe('HTTP 404 ENTRY_NOT_FOUND, mong đợi 200');
  });
  it('fails when a temporary field is present even if false', () => {
    expect(evaluateFast('A', 'run', dictionaryHit({ temporary: false })).verdict).toBe('fail');
  });
});

describe('evaluateFast — group B (inflected forms)', () => {
  it('passes when matched_form is the typed word', () => {
    expect(evaluateFast('B', 'ran', dictionaryHit({ matched_form: 'ran' })).verdict).toBe('pass');
  });
  it('fails when matched_form is missing or different', () => {
    expect(reasons(evaluateFast('B', 'ran', dictionaryHit()))).toContain('matched_form=null');
    expect(reasons(evaluateFast('B', 'ran', dictionaryHit({ matched_form: 'run' })))).toContain('mong đợi "ran"');
  });
});

describe('evaluateFast — group C (new common words)', () => {
  it('passes a full temporary translation that queued a job', () => {
    expect(evaluateFast('C', 'serendipity', temporary()).verdict).toBe('pass');
  });
  it.each([
    ['not temporary', { temporary: false }, 'temporary=false'],
    ['translation_vi null', { translation_vi: null }, 'translation_vi rỗng'],
    ['translation_vi equal to the word (case-insensitive)', { translation_vi: 'Serendipity' }, 'giống hệt từ gốc'],
    ['no job queued', { enrichment: { status: 'disabled' } }, 'enrichment.status=disabled'],
    ['already queued', { enrichment: { status: 'already_queued' } }, 'already_queued'],
    ['a dictionary hit', { source: 'dictionary' }, 'source=dictionary'],
  ])('fails: %s', (_name, over, text) => {
    const v = evaluateFast('C', 'serendipity', temporary(over as any));
    expect(v.verdict).toBe('fail');
    expect(reasons(v)).toContain(text);
  });
  it('fails on 503 and on 429', () => {
    expect(evaluateFast('C', 'x', err(503, 'TRANSLATION_UNAVAILABLE')).verdict).toBe('fail');
    const v = evaluateFast('C', 'x', { ...err(429, 'LOOKUP_RATE_LIMITED'), retriedAfter429: true });
    expect(v.verdict).toBe('fail');
    expect(reasons(v)).toContain('429');
  });
});

describe('evaluateFast — group D (loanwords)', () => {
  it('passes with a translation even when it equals the word (karaoke)', () => {
    expect(evaluateFast('D', 'karaoke', temporary({ translation_vi: 'karaoke', enrichment: { status: 'queued' } })).verdict).toBe('pass');
  });
  it('a 404 is called out, not just "wrong status"', () => {
    expect(reasons(evaluateFast('D', 'sushi', err(404, 'ENTRY_NOT_FOUND')))).toContain('không được bị coi là không có');
  });
  it('fails on translation_vi null', () => {
    expect(evaluateFast('D', 'sushi', temporary({ translation_vi: null })).verdict).toBe('fail');
  });
});

describe('evaluateFast — group E (proper nouns)', () => {
  it('passes any 200 translation, partial or not', () => {
    expect(evaluateFast('E', 'london', temporary({ partial: true, missing: ['pos'] })).verdict).toBe('pass');
  });
  it('fails on a 404', () => {
    expect(evaluateFast('E', 'london', err(404, 'ENTRY_NOT_FOUND')).verdict).toBe('fail');
  });
});

describe('evaluateFast — group F (not words)', () => {
  it('asdfghjk / xinchao must be 404 ENTRY_NOT_FOUND', () => {
    expect(evaluateFast('F', 'asdfghjk', err(404, 'ENTRY_NOT_FOUND')).verdict).toBe('pass');
    expect(reasons(evaluateFast('F', 'xinchao', err(503, 'TRANSLATION_UNAVAILABLE')))).toBe('HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 404 ENTRY_NOT_FOUND');
    expect(evaluateFast('F', 'asdfghjk', temporary()).verdict).toBe('fail');
  });
  it('recieve accepts 200 or 404, nothing else', () => {
    expect(evaluateFast('F', 'recieve', temporary()).verdict).toBe('pass');
    expect(evaluateFast('F', 'recieve', err(404, 'ENTRY_NOT_FOUND')).verdict).toBe('pass');
    expect(evaluateFast('F', 'recieve', err(503, 'TRANSLATION_UNAVAILABLE')).verdict).toBe('fail');
  });
});

describe('evaluateFast — group H (several meanings)', () => {
  const two = [
    { pos: 'noun', gloss_vi: 'bột nhão', definition_vi: 'a', definition_en: 'a' },
    { pos: 'noun', gloss_vi: 'người đánh bóng', definition_vi: 'b', definition_en: 'b' },
  ];
  it('passes with two distinct senses and three meanings', () => {
    expect(evaluateFast('H', 'batter', temporary({ senses: two, meanings_vi: ['a', 'b', 'c'] })).verdict).toBe('pass');
  });
  it('passes when only the part of speech differs', () => {
    const senses = [{ pos: 'noun', gloss_vi: 'x' }, { pos: 'verb', gloss_vi: 'x' }];
    expect(evaluateFast('H', 'tick', temporary({ senses, meanings_vi: ['a', 'b', 'c'] })).verdict).toBe('pass');
  });
  it('fails with one sense, identical senses, or fewer than three meanings', () => {
    expect(reasons(evaluateFast('H', 'mole', temporary({ senses: [two[0]], meanings_vi: ['a', 'b', 'c'] })))).toContain('senses=1');
    expect(evaluateFast('H', 'mole', temporary({ senses: [two[0], { ...two[0] }], meanings_vi: ['a', 'b', 'c'] })).verdict).toBe('fail');
    expect(reasons(evaluateFast('H', 'mole', temporary({ senses: two, meanings_vi: ['a', 'b'] })))).toContain('meanings_vi có 2 phần tử');
  });
  it('hasDistinctSenses', () => {
    expect(hasDistinctSenses(two)).toBe(true);
    expect(hasDistinctSenses([two[0]])).toBe(false);
    expect(hasDistinctSenses(undefined)).toBe(false);
  });
});

describe('summarizeFast', () => {
  it('extracts the columns of the report from a full response', () => {
    const s = summarizeFast(temporary({ partial: true, missing: ['translation_vi', 'ipa'], meanings_vi: ['a', 'b'], matched_form: undefined }));
    expect(s).toMatchObject({ status: 200, source: 'translation', temporary: true, matchedForm: null, partial: true, missing: ['translation_vi', 'ipa'], meaningsCount: 2, sensesCount: 1, enrichmentStatus: 'queued', errorCode: null });
  });
  it('copes with an error body and with no body at all', () => {
    expect(summarizeFast(err(404, 'ENTRY_NOT_FOUND'))).toMatchObject({ status: 404, source: null, errorCode: 'ENTRY_NOT_FOUND', meaningsCount: null });
    expect(summarizeFast({ status: 0, ms: 5, body: null })).toMatchObject({ status: 0, source: null, missing: [] });
  });
});

describe('evaluateFormRow and evaluateGoogleChars', () => {
  it('the form row must exist', () => {
    expect(evaluateFormRow('went', true).verdict).toBe('pass');
    expect(reasons(evaluateFormRow('went', false))).toContain('"went"');
  });
  it('Google characters must not move across groups A and B', () => {
    expect(evaluateGoogleChars(1000, 1000).verdict).toBe('pass');
    expect(reasons(evaluateGoogleChars(1000, 1042))).toContain('từ 1000 thành 1042 (+42)');
  });
});

// ── the job ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const row = (over: Partial<JobRowObservation> = {}): JobRowObservation => ({ id: 'j1', status: 'succeeded', reason: null, entryId: 'e1', attempts: 1, inputTokens: 9000, outputTokens: 900, ...over });
const entry = (over: Partial<EntryObservation> = {}): EntryObservation => ({
  id: 'e1',
  headword: 'serendipity',
  lemma: 'serendipity',
  published: false,
  pos: ['noun'],
  meaningVi: 'sự tình cờ may mắn; phát hiện tình cờ',
  adminNote: '[auto] …',
  senseCount: 2,
  completeSenseCount: 2,
  exampleCount: 3,
  ...over,
});
const job = (over: Partial<JobObservation> = {}): JobObservation => ({ rows: [row()], entry: entry(), headwordEntryExists: true, timedOut: false, ...over });

describe('evaluateJob — jobs that must succeed (C, D, H)', () => {
  it('passes a succeeded job with a complete tier A entry, unpublished under the review policy', () => {
    expect(evaluateJob('C', 'serendipity', job(), 'review')).toEqual({ verdict: 'pass', reasons: [] });
  });
  it('under the review policy a published entry is a failure', () => {
    expect(reasons(evaluateJob('C', 'serendipity', job({ entry: entry({ published: true }) }), 'review'))).toContain('published=true, mong đợi false');
  });
  it('under the auto policy a complete entry must be published, an incomplete one must not', () => {
    expect(evaluateJob('C', 'serendipity', job({ entry: entry({ published: true }) }), 'auto').verdict).toBe('pass');
    expect(reasons(evaluateJob('C', 'serendipity', job({ entry: entry({ published: false }) }), 'auto'))).toContain('published=false, mong đợi true');
    expect(evaluateJob('C', 'serendipity', job({ entry: entry({ published: false, exampleCount: 0 }) }), 'auto').reasons.join()).toContain('thiếu tầng A: ví dụ');
  });
  it('lists every missing tier A field', () => {
    const v = evaluateJob('C', 'x', job({ entry: entry({ pos: [], meaningVi: '  ', completeSenseCount: 0, exampleCount: 0 }) }), 'review');
    expect(v.verdict).toBe('fail');
    expect(reasons(v)).toContain('thiếu tầng A: pos, meaning_vi, sense có definition_en và definition_vi, ví dụ có example_en và example_vi');
  });
  it.each([
    ['no job at all', { rows: [] }, 'không có job nào'],
    ['still running when the wait ended', { rows: [row({ status: 'running' })], timedOut: true }, 'chưa xong'],
    ['failed', { rows: [row({ status: 'failed', reason: 'invalid_output' })] }, 'failed / invalid_output'],
    ['skipped as already existing', { rows: [row({ status: 'skipped', reason: 'exists' })] }, 'skipped / exists'],
    ['succeeded but no entry written', { entry: null }, 'không có mục từ [auto]'],
    ['entry id differs from the job', { rows: [row({ entryId: 'other' })] }, 'entry_id của job khác'],
  ])('fails: %s', (_name, over, text) => {
    const v = evaluateJob('D', 'sushi', job(over as any), 'review');
    expect(v.verdict).toBe('fail');
    expect(reasons(v)).toContain(text);
  });
  it('group H needs two senses and two Vietnamese meanings', () => {
    expect(evaluateJob('H', 'batter', job({ entry: entry({ senseCount: 2 }) }), 'review').verdict).toBe('pass');
    const v = evaluateJob('H', 'batter', job({ entry: entry({ senseCount: 1, meaningVi: 'bột nhão' }) }), 'review');
    expect(reasons(v)).toContain('1 sense');
    expect(reasons(v)).toContain('meaning_vi có 1 nghĩa');
  });
  it('the same entry with one sense is fine outside group H', () => {
    expect(evaluateJob('C', 'x', job({ entry: entry({ senseCount: 1, meaningVi: 'một' }) }), 'review').verdict).toBe('pass');
  });
});

describe('evaluateJob — proper nouns (E)', () => {
  it('passes rejected / proper_noun with no entry', () => {
    expect(evaluateJob('E', 'london', job({ rows: [row({ status: 'rejected', reason: 'proper_noun', entryId: null })], entry: null, headwordEntryExists: false }), 'review').verdict).toBe('pass');
  });
  it('fails on another reason, and when an entry exists', () => {
    expect(reasons(evaluateJob('E', 'microsoft', job({ rows: [row({ status: 'rejected', reason: 'unknown_word' })], entry: null, headwordEntryExists: false }), 'review'))).toContain('mong đợi rejected / proper_noun');
    expect(reasons(evaluateJob('E', 'london', job({ rows: [row({ status: 'rejected', reason: 'proper_noun' })], entry: null, headwordEntryExists: true }), 'review'))).toContain('không được tạo');
  });
  it('fails when no job was sent', () => {
    expect(reasons(evaluateJob('E', 'microsoft', job({ rows: [], entry: null, headwordEntryExists: false }), 'review'))).toContain('không có job nào');
  });
});

describe('evaluateJob — "no job" words (A, B and the nonsense words of F)', () => {
  it('passes without rows and fails with any', () => {
    expect(evaluateJob('A', 'run', job({ rows: [], entry: null }), 'review').verdict).toBe('pass');
    expect(reasons(evaluateJob('B', 'ran', job({ rows: [row({ status: 'skipped', reason: 'exists' })], entry: null }), 'review'))).toContain('không được có job nhưng có 1');
    expect(evaluateJob('F', 'asdfghjk', job({ rows: [row({ status: 'queued' })], entry: null }), 'review').verdict).toBe('fail');
  });
});

describe('evaluateJob — recieve (variant_form if there is a job)', () => {
  it('no job is accepted; a job must be skipped / variant_form; an entry named recieve is never accepted', () => {
    expect(evaluateJob('F', 'recieve', job({ rows: [], entry: null, headwordEntryExists: false }), 'review').verdict).toBe('pass');
    expect(evaluateJob('F', 'recieve', job({ rows: [row({ status: 'skipped', reason: 'variant_form' })], entry: null, headwordEntryExists: false }), 'review').verdict).toBe('pass');
    expect(reasons(evaluateJob('F', 'recieve', job({ rows: [row({ status: 'succeeded' })], entry: null, headwordEntryExists: false }), 'review'))).toContain('mong đợi skipped / variant_form');
    expect(reasons(evaluateJob('F', 'recieve', job({ rows: [], entry: null, headwordEntryExists: true }), 'review'))).toContain('headword "recieve"');
  });
});

describe('jobExpectation and tier A helpers', () => {
  it('maps every group', () => {
    expect(GROUP_ORDER.map((g) => jobExpectation(g, g === 'F' ? 'asdfghjk' : 'w'))).toEqual(['none', 'none', 'succeeded', 'succeeded', 'rejected_proper_noun', 'none', 'succeeded']);
    expect(jobExpectation('F', 'recieve')).toBe('variant_if_any');
  });
  it('tierAMissing / meaningParts', () => {
    expect(tierAMissing(entry())).toEqual([]);
    expect(meaningParts('a; b ;; c')).toEqual(['a', 'b', 'c']);
    expect(meaningParts(null)).toEqual([]);
  });
});

// ── latency and combine ─────────────────────────────────────────────────────────────────────────────────────────────

describe('percentile and evaluateLatency', () => {
  it('nearest-rank percentile', () => {
    const v = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(v, 50)).toBe(500);
    expect(percentile(v, 95)).toBe(1000);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });

  const samples = (group: Group, ms: number[]) => ms.map((m) => ({ group, ms: m }));

  it('p95 of C, D, E, H within LOOKUP_TOTAL_DEADLINE_MS + 500 passes', () => {
    const r = evaluateLatency([...samples('C', [900, 1200, 3400]), ...samples('H', [1500])], 3000);
    expect(r).toMatchObject({ verdict: 'pass', limitMs: 3500, samples: 4, p95: 3400 });
  });
  it('fails above the limit and says by how much', () => {
    const r = evaluateLatency(samples('D', [500, 600, 4100]), 3000);
    expect(r.verdict).toBe('fail');
    expect(r.reasons.join()).toContain('p95 = 4100 ms > 3500 ms');
  });
  it('groups A, B and F are not timed', () => {
    const r = evaluateLatency([...samples('A', [9000]), ...samples('F', [9000]), ...samples('C', [800])], 3000);
    expect(r).toMatchObject({ verdict: 'pass', samples: 1 });
  });
  it('is skipped when there is nothing to time', () => {
    expect(evaluateLatency(samples('A', [100]), 3000).verdict).toBe('skip');
  });
});

describe('combine', () => {
  it('skip beats fail beats pass, and reasons add up', () => {
    expect(combine({ verdict: 'pass', reasons: [] }, { verdict: 'pass', reasons: [] }).verdict).toBe('pass');
    expect(combine({ verdict: 'pass', reasons: [] }, { verdict: 'fail', reasons: ['a'] }, { verdict: 'fail', reasons: ['b'] })).toEqual({ verdict: 'fail', reasons: ['a', 'b'] });
    expect(combine({ verdict: 'fail', reasons: ['a'] }, { verdict: 'skip', reasons: ['s'] }).verdict).toBe('skip');
  });
});

// ── words, preconditions and the plan ───────────────────────────────────────────────────────────────────────────────

describe('the 30 words', () => {
  it('are the 30 words of the brief, in 7 groups', () => {
    expect(GROUP_ORDER.flatMap((g) => GROUP_WORDS[g])).toHaveLength(30);
    expect(GROUP_WORDS.A).toEqual(['run', 'bank', 'light']);
    expect(GROUP_WORDS.B).toEqual(['ran', 'running', 'went', 'children', 'banks', 'lights']);
    expect(GROUP_WORDS.H).toEqual(['batter', 'mole', 'sage', 'tick', 'bass', 'fawn']);
    expect(FALLBACK_WORDS).toEqual({ C: ['nostalgia', 'gregarious', 'lucid'], H: ['trunk', 'rack', 'pawn'] });
    expect(ALL_ACCEPTANCE_WORDS).toHaveLength(36);
  });
});

const facts = (over: Partial<WordFacts> = {}): WordFacts => ({ entryExists: false, entryPublished: false, headwordExists: false, ...over });

describe('checkPrecondition', () => {
  it('A needs a published entry', () => {
    expect(checkPrecondition('A', 'run', facts({ entryExists: true, entryPublished: true })).ok).toBe(true);
    expect(checkPrecondition('A', 'run', facts({ entryExists: true })).reason).toContain('published=false');
    expect(checkPrecondition('A', 'run', facts()).reason).toBe('chưa có mục từ');
  });
  it('B needs a published entry to reach the form through', () => {
    expect(checkPrecondition('B', 'ran', facts({ formTarget: { lemma: 'run', published: true } })).ok).toBe(true);
    expect(checkPrecondition('B', 'ran', facts({ formTarget: { lemma: 'run', published: false } })).reason).toContain('published=false');
    expect(checkPrecondition('B', 'went', facts({ formTarget: null })).reason).toContain('(go)');
  });
  it('C, D, H need NO entry, published or not (the job would stop at S0 with skipped / exists)', () => {
    expect(checkPrecondition('C', 'serendipity', facts()).ok).toBe(true);
    expect(checkPrecondition('C', 'serendipity', facts({ entryExists: true, entryPublished: false })).reason).toContain('published=false, ví dụ do P6b');
    expect(checkPrecondition('H', 'tick', facts({ entryExists: true, entryPublished: true })).ok).toBe(false);
  });
  it('E and F need no entry with that headword', () => {
    expect(checkPrecondition('E', 'london', facts()).ok).toBe(true);
    expect(checkPrecondition('F', 'recieve', facts({ headwordExists: true })).ok).toBe(false);
  });
});

describe('planWords', () => {
  const allOk = () => ({ ok: true, reason: 'ok' });

  it('runs all 30 words when every precondition holds', () => {
    const p = planWords(GROUP_ORDER, allOk);
    expect(p.run).toHaveLength(30);
    expect(p.skipped).toEqual([]);
    expect(p.run.every((w) => !w.standsInFor)).toBe(true);
  });

  it('replaces a wrong C word by the next stand-in, in order, and skips the one it replaces', () => {
    const bad = new Set(['serendipity', 'ephemeral']);
    const p = planWords(['C'], (_g, w) => (bad.has(w) ? { ok: false, reason: 'đã có' } : { ok: true, reason: 'ok' }));
    // a stand-in takes the slot of the word it replaces
    expect(p.run.map((w) => w.word)).toEqual(['nostalgia', 'ubiquitous', 'gregarious', 'podcast', 'quarantine', 'procrastinate']);
    expect(p.run.filter((w) => w.standsInFor).map((w) => [w.word, w.standsInFor])).toEqual([['nostalgia', 'serendipity'], ['gregarious', 'ephemeral']]);
    expect(p.skipped.map((s) => s.word)).toEqual(['serendipity', 'ephemeral']);
  });

  it('runs out of stand-ins: the extra wrong words are only skipped (the brief has 4 wrong in C and 3 stand-ins)', () => {
    const bad = new Set(['serendipity', 'ephemeral', 'podcast', 'quarantine']);
    const p = planWords(['C'], (_g, w) => (bad.has(w) ? { ok: false, reason: 'đã có' } : { ok: true, reason: 'ok' }));
    expect(p.run.map((w) => w.word)).toEqual(['nostalgia', 'ubiquitous', 'gregarious', 'lucid', 'procrastinate']);
    expect(p.skipped.map((s) => s.word)).toEqual(['serendipity', 'ephemeral', 'podcast', 'quarantine']);
  });

  it('a stand-in whose own precondition is wrong is skipped and the next one is tried', () => {
    const bad = new Set(['trunk', 'batter']);
    const p = planWords(['H'], (_g, w) => (bad.has(w) ? { ok: false, reason: 'đã có' } : { ok: true, reason: 'ok' }));
    expect(p.run.map((w) => w.word)).toEqual(['rack', 'mole', 'sage', 'tick', 'bass', 'fawn']);
    expect(p.skipped.map((s) => s.word)).toEqual(['batter', 'trunk']);
    expect(p.skipped[1].reason).toContain('dự phòng cho "batter"');
  });

  it('groups without stand-ins (D) just skip', () => {
    const p = planWords(['D'], (_g, w) => (w === 'karaoke' ? { ok: false, reason: 'đã có' } : { ok: true, reason: 'ok' }));
    expect(p.run.map((w) => w.word)).toEqual(['sushi', 'tsunami']);
    expect(p.skipped).toHaveLength(1);
  });

  it('only the selected groups, in canonical order', () => {
    expect(planWords(['H', 'A'], allOk).run.map((w) => w.group)).toEqual(['A', 'A', 'A', 'H', 'H', 'H', 'H', 'H', 'H']);
  });
});

// ── database helpers ────────────────────────────────────────────────────────────────────────────────────────────────

describe('describeDatabase', () => {
  it('reads host, database and user from a connection string and never exposes the password', () => {
    const pool: any = { options: { connectionString: 'postgresql://neon_user:s3cr3t-pass@ep-example-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require' } };
    const id = describeDatabase(pool);
    expect(id).toEqual({ host: 'ep-example-123.ap-southeast-1.aws.neon.tech', database: 'neondb', user: 'neon_user' });
    expect(JSON.stringify(id)).not.toContain('s3cr3t');
  });
  it('falls back to the discrete options', () => {
    expect(describeDatabase({ options: { host: 'localhost', database: 'english', user: 'postgres', password: 'x' } } as any)).toEqual({ host: 'localhost', database: 'english', user: 'postgres' });
  });
});

describe('confirmDatabaseName (the typed confirmation of --cleanup)', () => {
  const identity = { host: 'h', database: 'neondb', user: 'u' };
  const answer = async (typed: string | null) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const result = confirmDatabaseName(identity, input, output);
    if (typed === null) input.end();
    else input.end(typed + '\n');
    return { ok: await result, printed: output.read()?.toString() ?? '' };
  };

  it('accepts the exact name and shows the database it asks about', async () => {
    const r = await answer('neondb');
    expect(r.ok).toBe(true);
    expect(r.printed).toContain('h / neondb');
  });
  it('tolerates surrounding spaces', async () => {
    expect((await answer('  neondb  ')).ok).toBe(true);
  });
  it.each(['neon', 'NEONDB', '', 'neondb2', 'y', 'yes'])('refuses %j', async (typed) => {
    expect((await answer(typed)).ok).toBe(false);
  });
  it('refuses when stdin closes without an answer', async () => {
    expect((await answer(null)).ok).toBe(false);
  });
});

describe('readCredentials', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'accept-')), 'creds.json');
  it('explains how to create the file when it is missing', () => {
    expect(() => readCredentials(tmp())).toThrow(/seed:lookup-test/);
  });
  it('rejects a file with a missing field, naming the field', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ email: 'a@b.c', password: 'x', ebook_id: 'e' }));
    expect(() => readCredentials(f)).toThrow(/paragraph_id/);
  });
  it('reads a complete file', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ email: 'a@b.c', password: 'x', ebook_id: 'e', paragraph_id: 'p', database: 'neondb' }));
    expect(readCredentials(f)).toMatchObject({ email: 'a@b.c', ebook_id: 'e', paragraph_id: 'p', database: 'neondb' });
  });
});

describe('.gitignore', () => {
  it('keeps the credentials file and the run state out of git', () => {
    const lines = fs.readFileSync(path.resolve(__dirname, '..', '..', '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain('.acceptance.local.json');
    expect(lines).toContain('.acceptance.state.json');
  });
});
