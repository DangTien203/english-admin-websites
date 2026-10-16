import { combine, evaluateFast, reclassifyForSource, type FastObservation, type SourceHealth, UNEVALUABLE_LABEL } from '../../scripts/acceptance/evaluate';
import {
  breakerLikelyOpen,
  breakerWaitMs,
  classifyWordCheck,
  describeProbe,
  fdFailureEvidence,
  PROBE_ATTEMPTS,
  probeFreeDictionary,
  rerunCommand,
  sourceHealthFor,
} from '../../scripts/acceptance/source';

// ── sample answers ──────────────────────────────────────────────────────────────────────────────────────────────────

const ok = (data: object, ms = 400): FastObservation => ({ status: 200, ms, body: { success: true, data } });
const err = (status: number, code: string, ms = 300): FastObservation => ({ status, ms, body: { success: false, error: { code, message: 'x' } } });
const outage = () => err(503, 'TRANSLATION_UNAVAILABLE', 3050);
const notFound = () => err(404, 'ENTRY_NOT_FOUND');
const translation = (over: Record<string, any> = {}) =>
  ok({
    source: 'translation',
    temporary: true,
    translation_vi: 'nghĩa',
    meanings_vi: ['a', 'b', 'c'],
    senses: [
      { pos: 'noun', gloss_vi: 'một' },
      { pos: 'verb', gloss_vi: 'hai' },
    ],
    partial: false,
    missing: [],
    enrichment: { status: 'queued' },
    ...over,
  });
/** a lookup of a word Free Dictionary knows that came back without anything from it */
const noFreeDictionary = () => translation({ senses: [], partial: true, missing: ['pos', 'definition_en', 'ipa', 'audio_url'] });

const healthy: SourceHealth = { unhealthy: false, why: 'Free Dictionary khỏe' };
const unhealthy: SourceHealth = { unhealthy: true, why: 'lần thăm dò Free Dictionary trước đó không khỏe' };

// ── the probe ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('probeFreeDictionary', () => {
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  const noSleep = async () => undefined;

  it('is healthy when all three attempts get 200 with a list of entries; each attempt asks for a DIFFERENT ordinary word (a cached `hello` hid a dead service)', async () => {
    const fetchImpl = jest.fn(answer(200, [{ word: 'hello' }])) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const r = await probeFreeDictionary('https://fd.test/api/v2/entries/en/', 2500, { fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
    expect(r.healthy).toBe(true);
    expect(r.attempts).toHaveLength(PROBE_ATTEMPTS);
    expect(r.attempts.every((a) => a.ok && a.status === 200 && a.error === null)).toBe(true);
    expect((fetchImpl as unknown as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      'https://fd.test/api/v2/entries/en/house',
      'https://fd.test/api/v2/entries/en/water',
      'https://fd.test/api/v2/entries/en/tree',
    ]);
    expect(r.attempts.map((a) => a.word)).toEqual(['house', 'water', 'tree']);
    expect(r.words).toEqual(['house', 'water', 'tree']);
    expect(sleeps).toHaveLength(2); // a gap between attempts, not before the first
  });

  it('one failing attempt out of three is NOT healthy (a source that fails now and then will time out part of a 30-word run)', async () => {
    let n = 0;
    const fetchImpl = (async () => (++n === 2 ? new Response('upstream', { status: 503 }) : new Response(JSON.stringify([{ word: 'hello' }]), { status: 200 }))) as unknown as typeof fetch;
    const r = await probeFreeDictionary('https://fd.test/en', 2500, { fetchImpl, sleep: noSleep });
    expect(r.healthy).toBe(false);
    expect(r.attempts.map((a) => a.ok)).toEqual([true, false, true]);
    expect(r.attempts[1]).toMatchObject({ status: 503, error: 'http_503' });
  });

  it('a timeout is an attempt without a status, called "timeout"', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const r = await probeFreeDictionary('https://fd.test/en', 50, { fetchImpl, sleep: noSleep });
    expect(r.healthy).toBe(false);
    expect(r.attempts.every((a) => a.status === null && a.error === 'timeout')).toBe(true);
  });

  it('a network error is reported by its name, never by its message', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1:443');
    }) as unknown as typeof fetch;
    const r = await probeFreeDictionary('https://fd.test/en', 50, { fetchImpl, sleep: noSleep });
    expect(r.attempts[0]).toMatchObject({ ok: false, status: null, error: 'TypeError' });
    expect(JSON.stringify(r)).not.toContain('ECONNREFUSED');
  });

  it('200 with something that is not a list of entries (an HTML error page, an empty list) is not healthy', async () => {
    for (const body of [{ title: 'No Definitions Found' }, [], 'oops']) {
      const r = await probeFreeDictionary('https://fd.test/en', 2500, { fetchImpl: answer(200, body) as unknown as typeof fetch, sleep: noSleep });
      expect(r.healthy).toBe(false);
      expect(r.attempts[0].error).toBe('not_a_word_list');
    }
  });

  it('the one-line description names every attempt', () => {
    const text = describeProbe({
      words: ['house', 'water'],
      healthy: false,
      attempts: [
        { word: 'house', ok: true, status: 200, ms: 120, error: null },
        { word: 'water', ok: false, status: null, ms: 2500, error: 'timeout' },
      ],
    });
    expect(text).toBe('lần 1 (house): OK (HTTP 200) 120 ms; lần 2 (water): timeout 2500 ms');
  });
});

// ── what in a lookup shows Free Dictionary failing ──────────────────────────────────────────────────────────────────

describe('fdFailureEvidence', () => {
  it('a 503 TRANSLATION_UNAVAILABLE is evidence in every group (spec §6: only Free Dictionary erroring gives it)', () => {
    for (const g of ['C', 'D', 'E', 'F', 'H'] as const) expect(fdFailureEvidence(g, outage())).toBe(true);
  });

  it('a 404 for a proper noun or a garbage word is NOT evidence: Free Dictionary legitimately does not have those', () => {
    expect(fdFailureEvidence('E', notFound())).toBe(false);
    expect(fdFailureEvidence('F', notFound())).toBe(false);
  });

  it('in C, D and H a temporary answer with no part of speech is evidence (it gave nothing for a word it knows)', () => {
    for (const g of ['C', 'D', 'H'] as const) {
      expect(fdFailureEvidence(g, noFreeDictionary())).toBe(true);
      expect(fdFailureEvidence(g, translation())).toBe(false);
    }
  });

  it('in E and F a partial answer is not evidence either way', () => {
    expect(fdFailureEvidence('E', noFreeDictionary())).toBe(false);
  });

  it('other errors (429, 500) and dictionary answers are not evidence', () => {
    expect(fdFailureEvidence('H', err(429, 'LOOKUP_RATE_LIMITED'))).toBe(false);
    expect(fdFailureEvidence('H', err(500, 'INTERNAL'))).toBe(false);
    expect(fdFailureEvidence('C', ok({ source: 'dictionary' }))).toBe(false);
  });
});

describe('breakerLikelyOpen and breakerWaitMs', () => {
  it('opens after `threshold` failures IN A ROW at the end of the history', () => {
    expect(breakerLikelyOpen([true, true, true, true], 5)).toBe(false);
    expect(breakerLikelyOpen([true, true, true, true, true], 5)).toBe(true);
    expect(breakerLikelyOpen([false, true, true, true, true, true], 5)).toBe(true);
    expect(breakerLikelyOpen([true, true, true, true, true, false], 5)).toBe(false); // it answered again after that
    expect(breakerLikelyOpen([true, true, false, true, true], 5)).toBe(false);
    expect(breakerLikelyOpen([], 5)).toBe(false);
  });

  it('a nonsense threshold never says open', () => {
    expect(breakerLikelyOpen([true, true], 0)).toBe(false);
    expect(breakerLikelyOpen([true, true], Number.NaN)).toBe(false);
  });

  it('waits UPSTREAM_BREAKER_RESET_MS plus a margin after the LAST failure, and not at all once that time has passed', () => {
    expect(breakerWaitMs(1_000, 1_000, 30_000)).toBe(32_000);
    expect(breakerWaitMs(1_000, 11_000, 30_000)).toBe(22_000); // part of the time has gone by already
    expect(breakerWaitMs(1_000, 100_000, 30_000)).toBe(0);
    expect(breakerWaitMs(1_000, 1_000, 30_000, 0)).toBe(30_000);
  });
});

describe('sourceHealthFor and rerunCommand', () => {
  it('a breaker that is open beats everything, then an unhealthy probe before, then one after', () => {
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: true }, true)).toMatchObject({ unhealthy: true, why: expect.stringContaining('mạch ngắt') });
    expect(sourceHealthFor({ probeHealthy: false, breakerOpen: false }, true)).toMatchObject({ unhealthy: true, why: expect.stringContaining('trước đó') });
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: false }, false)).toMatchObject({ unhealthy: true, why: expect.stringContaining('sau lượt tra') });
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true).unhealthy).toBe(false);
    expect(sourceHealthFor({ probeHealthy: null, breakerOpen: false }, null).unhealthy).toBe(false); // nothing was probed: no claim
  });

  it('asked again about ONE word: "has" means the source failed when the server looked, "absent" means the word is simply not there', () => {
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, 'has')).toMatchObject({ unhealthy: true, why: expect.stringContaining('có dữ liệu') });
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, 'error')).toMatchObject({ unhealthy: true, why: expect.stringContaining('vẫn không trả lời') });
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, 'absent')).toMatchObject({ unhealthy: false, why: expect.stringContaining('404') });
    expect(sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, null).unhealthy).toBe(false);
    // the probes and the breaker still come first
    expect(sourceHealthFor({ probeHealthy: false, breakerOpen: false }, true, 'absent').unhealthy).toBe(true);
  });

  it('classifies the answer of the single-word look', () => {
    expect(classifyWordCheck({ word: 'w', ok: true, status: 200, ms: 90, error: null })).toBe('has');
    expect(classifyWordCheck({ word: 'w', ok: false, status: 404, ms: 90, error: 'http_404' })).toBe('absent');
    expect(classifyWordCheck({ word: 'w', ok: false, status: 503, ms: 90, error: 'http_503' })).toBe('error');
    expect(classifyWordCheck({ word: 'w', ok: false, status: null, ms: 2500, error: 'timeout' })).toBe('error');
    expect(classifyWordCheck(undefined)).toBe('error');
  });

  it('the rerun command lists only the groups that could not be judged, in the order they are run (H before E and F)', () => {
    expect(rerunCommand(new Set(['F', 'H', 'E'] as const), 'http://localhost:3000')).toBe('npm run acceptance:lookup -- --staging --only H,E,F --base-url http://localhost:3000');
    expect(rerunCommand(['E'], 'http://localhost:3000')).toBe('npm run acceptance:lookup -- --staging --only E --base-url http://localhost:3000');
  });
});

// ── "cannot be judged" instead of "failed" ──────────────────────────────────────────────────────────────────────────

describe('probeFreeDictionary for one word (the look after the fast path)', () => {
  it('asks for THAT word once, and a 404 is "absent", not a failure of the source', async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ title: 'No Definitions Found' }), { status: 404 })) as unknown as typeof fetch;
    const r = await probeFreeDictionary('https://fd.test/en', 2500, { fetchImpl, sleep: async () => undefined }, 'zzword', 1);
    expect((fetchImpl as unknown as jest.Mock).mock.calls).toHaveLength(1);
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0]).toBe('https://fd.test/en/zzword');
    expect(classifyWordCheck(r.attempts[0])).toBe('absent');
  });
});

describe('reclassifyForSource', () => {
  const judge = (group: 'E' | 'F' | 'H', word: string, obs: FastObservation, source: SourceHealth) => reclassifyForSource(group, obs, evaluateFast(group, word, obs), source);

  it('F: a 503 for a garbage word is the CORRECT answer of spec §6 when Free Dictionary hangs: not a failure, said so in the reasons', () => {
    const plain = evaluateFast('F', 'asdfghjk', outage());
    expect(plain.verdict).toBe('fail'); // the brief expects 404 …
    const v = judge('F', 'asdfghjk', outage(), healthy);
    expect(v.verdict).toBe('unevaluable'); // … but the 503 is what the matrix demands
    expect(v.reasons[0]).toContain('503');
    expect(v.reasons[0]).toContain('spec §6');
    expect(v.reasons[0]).toContain('đạt có ghi chú');
    expect(v.reasons.slice(1).join(' ')).toContain('mong đợi 404'); // what the plain verdict said is kept
  });

  it('E: a 503 is unevaluable too, whatever the probes said (the 503 itself is the proof that Free Dictionary errored)', () => {
    expect(judge('E', 'microsoft', outage(), healthy).verdict).toBe('unevaluable');
    expect(judge('E', 'microsoft', outage(), unhealthy).verdict).toBe('unevaluable');
  });

  it('a 404 for a garbage word still passes, and a wrong answer in E or F is still a failure', () => {
    expect(judge('F', 'asdfghjk', notFound(), unhealthy).verdict).toBe('pass');
    expect(judge('E', 'london', notFound(), unhealthy).verdict).toBe('fail'); // 404 where a translation was expected is not an outage
    expect(judge('F', 'asdfghjk', err(500, 'INTERNAL'), unhealthy).verdict).toBe('fail');
    expect(judge('F', 'asdfghjk', ok({ source: 'dictionary' }), unhealthy).verdict).toBe('fail');
  });

  it('H: a 503 is unevaluable', () => {
    expect(judge('H', 'batter', outage(), healthy).verdict).toBe('unevaluable');
  });

  it('H: no senses while Free Dictionary was unhealthy is unevaluable; with a healthy one it is a real failure', () => {
    expect(judge('H', 'batter', noFreeDictionary(), unhealthy).verdict).toBe('unevaluable');
    expect(judge('H', 'batter', noFreeDictionary(), unhealthy).reasons.join(' ')).toContain('thăm dò');
    expect(judge('H', 'batter', noFreeDictionary(), healthy).verdict).toBe('fail');
  });

  it('H: the same empty answer is unevaluable when Free Dictionary has the word now (it was failing), and a failure when it truly lacks it', () => {
    const gone = sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, 'has');
    const lacks = sourceHealthFor({ probeHealthy: true, breakerOpen: false }, true, 'absent');
    expect(judge('H', 'crane', noFreeDictionary(), gone).verdict).toBe('unevaluable');
    expect(judge('H', 'crane', noFreeDictionary(), lacks).verdict).toBe('fail');
  });

  it('H: a wrong status or source is a failure even while Free Dictionary is down', () => {
    expect(judge('H', 'batter', err(404, 'ENTRY_NOT_FOUND'), unhealthy).verdict).toBe('fail');
    expect(judge('H', 'batter', ok({ source: 'dictionary' }), unhealthy).verdict).toBe('fail');
  });

  it('a pass is never touched, and never becomes unevaluable', () => {
    expect(judge('H', 'batter', translation(), unhealthy)).toEqual({ verdict: 'pass', reasons: [] });
    expect(judge('F', 'asdfghjk', notFound(), unhealthy)).toEqual({ verdict: 'pass', reasons: [] });
  });

  it('groups outside H, E and F keep their verdict (a 503 in group C is not excused)', () => {
    const obs = outage();
    expect(reclassifyForSource('C', obs, evaluateFast('C', 'serendipity', obs), unhealthy).verdict).toBe('fail');
  });
});

describe('combine with an unevaluable part', () => {
  const pass = { verdict: 'pass' as const, reasons: [] };
  const unevaluable = { verdict: 'unevaluable' as const, reasons: ['nguồn lỗi'] };
  const fail = { verdict: 'fail' as const, reasons: ['sai'] };
  const skip = { verdict: 'skip' as const, reasons: ['tiền đề'] };

  it('unevaluable + pass is unevaluable: a run that could not judge a part is not a pass', () => {
    expect(combine(unevaluable, pass).verdict).toBe('unevaluable');
  });

  it('a real failure of another part is not hidden by it, and the reasons of both are kept', () => {
    const v = combine(unevaluable, fail);
    expect(v.verdict).toBe('fail');
    expect(v.reasons).toEqual(['nguồn lỗi', 'sai']);
  });

  it('skip still beats everything', () => {
    expect(combine(unevaluable, fail, skip).verdict).toBe('skip');
  });

  it('the label is the words of the brief', () => {
    expect(UNEVALUABLE_LABEL.toLowerCase()).toBe('không đánh giá được: nguồn ngoài lỗi');
  });
});
