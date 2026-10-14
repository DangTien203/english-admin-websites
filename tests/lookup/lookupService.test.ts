import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { UpstreamUnavailable } from '../../services/upstream/errors';
import { FreeDictionaryClient } from '../../services/upstream/freeDictionaryClient';
import { GoogleTranslateClient } from '../../services/upstream/googleTranslateClient';
import { TokenBucket } from '../../services/upstream/tokenBucket';
import { UserRateLimiter } from '../../services/lookup/rateLimiter';
import { OUTAGE_JOB_DELAY_SECONDS, REF_PROBE_TTL_MS, WordLookupService } from '../../services/lookup/lookupService';
import { SingleFlight } from '../../services/lookup/singleFlight';
import type { UpstreamBundle } from '../../services/lookup/types';
import { GoogleFastTranslator } from '../../services/lookup/fastTranslator';
import { hangingFetch } from './helpers';
import { defaultGoogle, downErr, FD_404, fdFound, flush, input, makeHarness, realFdEntry } from './serviceHarness';

const ENTRY = { id: 'entry-1', headword: 'run', lemma: 'run', word_forms: [{ form_value: 'running' }], senses: [] };

/** No lookup may ever read or write the deprecated cache table. */
function expectNoWordTranslationCache(sqls: string[]) {
  expect(sqls.filter((q) => q.includes('word_translation_cache'))).toEqual([]);
}

describe('F4 — local dictionary', () => {
  it('a dictionary hit never calls an external service and logs a dictionary lookup', async () => {
    const h = makeHarness({ db: { local: () => ENTRY } });
    const result = await h.service.lookup(input('run'));
    await flush();

    expect(result).toEqual({ kind: 'dictionary', entry: ENTRY, matchedForm: undefined });
    expect(h.google).not.toHaveBeenCalled();
    expect(h.fd).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.db.lookups).toEqual([['user-1', 'entry-1', 'run', 'dictionary', 'ebook-1', null]]);
    expectNoWordTranslationCache(h.db.sqls);
  });

  it('a match through word_forms reports matched_form', async () => {
    const h = makeHarness({ db: { local: (w) => (w === 'running' ? ENTRY : undefined) } });
    const result = await h.service.lookup(input('running'));
    expect(result).toMatchObject({ kind: 'dictionary', matchedForm: 'running' });
    expect(h.google).not.toHaveBeenCalled();
  });

  it('headword/lemma matches carry no matched_form', async () => {
    const h = makeHarness({ db: { local: () => ENTRY } });
    expect(await h.service.lookup(input('run'))).toMatchObject({ kind: 'dictionary', matchedForm: undefined });
  });

  it('a failure while recording the lookup never breaks the response', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = makeHarness({ db: { local: () => ENTRY, failInserts: true } });
    await expect(h.service.lookup(input('run'))).resolves.toMatchObject({ kind: 'dictionary' });
    await flush();
    spy.mockRestore();
  });
});

describe('F4b — local inflections through ref_wiktionary_en', () => {
  const lemmaEntry = { id: 'entry-run', headword: 'run', lemma: 'run', word_forms: [] };
  const refRow = (tags: string[]) => ({ lemma_of: 'run', data: { tags } });

  it('returns the lemma entry with matched_form and records the form (idempotent insert, not awaited)', async () => {
    const h = makeHarness({
      db: { local: (w) => (w === 'run' ? lemmaEntry : undefined), refWiktionary: (w) => (w === 'ran' ? [refRow(['past'])] : []) },
    });
    const result = await h.service.lookup(input('ran'));
    await flush();

    expect(result).toMatchObject({ kind: 'dictionary', matchedForm: 'ran', entry: { id: 'entry-run' } });
    expect(h.db.forms).toEqual([['entry-run', 'past_simple', 'ran']]);
    expect(h.db.sqls.find((q) => q.includes('INSERT INTO word_forms'))).toContain('ON CONFLICT DO NOTHING');
    expect(h.google).not.toHaveBeenCalled();
    expect(h.fd).not.toHaveBeenCalled();
    expect(h.db.lookups[0].slice(1, 4)).toEqual(['entry-run', 'ran', 'dictionary']);
  });

  it('answers without remembering the form when its type cannot be told (nothing is guessed)', async () => {
    const h = makeHarness({
      db: { local: (w) => (w === 'run' ? lemmaEntry : undefined), refWiktionary: () => [refRow(['dialectal'])] },
    });
    await expect(h.service.lookup(input('rann'))).resolves.toMatchObject({ kind: 'dictionary', matchedForm: 'rann' });
    await flush();
    expect(h.db.forms).toEqual([]);
  });

  it('falls through to the fast path when the lemma has no published entry', async () => {
    const h = makeHarness({ db: { local: () => undefined, refWiktionary: () => [refRow(['past'])] } });
    await expect(h.service.lookup(input('ran'))).resolves.toMatchObject({ kind: 'temporary' });
  });

  it('an empty ref table is skipped silently', async () => {
    const h = makeHarness({ db: { local: () => undefined, refWiktionary: () => [] } });
    await expect(h.service.lookup(input('zzword'))).resolves.toMatchObject({ kind: 'temporary' });
    expect(h.db.forms).toEqual([]);
  });

  it('a broken or missing ref table never breaks the lookup', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = makeHarness({
      db: {
        local: () => undefined,
        refWiktionary: () => {
          throw new Error('relation "ref_wiktionary_en" does not exist');
        },
      },
    });
    await expect(h.service.lookup(input('zzword'))).resolves.toMatchObject({ kind: 'temporary' });
    spy.mockRestore();
  });
});

describe('F4b — the ref table is probed once, not on every miss', () => {
  it('an EMPTY ref table is probed once and then skipped until the probe expires', async () => {
    let t = 1_000_000;
    const h = makeHarness({ now: () => t, db: { local: () => undefined, refPopulated: false } });
    await h.service.lookup(input('aaa', 'u1'));
    await h.service.lookup(input('bbb', 'u2'));
    await h.service.lookup(input('ccc', 'u3'));
    expect(h.db.probes).toHaveLength(1);
    expect(h.db.sqls.filter((q) => q.includes('lemma_of IS NOT NULL'))).toHaveLength(0); // the per-word ref query never ran

    t += REF_PROBE_TTL_MS + 1;
    await h.service.lookup(input('ddd', 'u4'));
    expect(h.db.probes).toHaveLength(2);
  });

  it('a populated table is used as soon as the probe says so', async () => {
    const lemmaEntry = { id: 'entry-run', headword: 'run', lemma: 'run', word_forms: [] };
    const h = makeHarness({
      db: { local: (w) => (w === 'run' ? lemmaEntry : undefined), refPopulated: true, refWiktionary: () => [{ lemma_of: 'run', data: { tags: ['past'] } }] },
    });
    await expect(h.service.lookup(input('ran'))).resolves.toMatchObject({ kind: 'dictionary', matchedForm: 'ran' });
  });

  it('a failing probe (table missing) is logged, treated as empty, and does not break the lookup', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = makeHarness({ db: { local: () => undefined, refProbeThrows: true } });
    await expect(h.service.lookup(input('zorp'))).resolves.toMatchObject({ kind: 'temporary' });
    await h.service.lookup(input('zorp2', 'u2'));
    expect(h.db.probes).toHaveLength(1); // not retried on every request
    spy.mockRestore();
  });
});

describe('F5 — TRANSLATION_FALLBACK_ENABLED', () => {
  it('false: 404 path, no external call, no rate-limit use, but the miss is logged', async () => {
    const limiter = { check: jest.fn(() => ({ allowed: true })) };
    const h = makeHarness({ config: { translationFallbackEnabled: false }, limiter });
    await expect(h.service.lookup(input('zzword'))).resolves.toEqual({ kind: 'not_found' });
    await flush();

    expect(h.google).not.toHaveBeenCalled();
    expect(h.fd).not.toHaveBeenCalled();
    expect(limiter.check).not.toHaveBeenCalled();
    expect(h.db.lookups[0].slice(1, 4)).toEqual([null, 'zzword', 'not_found']);
  });

  it('false still serves dictionary hits', async () => {
    const h = makeHarness({ config: { translationFallbackEnabled: false }, db: { local: () => ENTRY } });
    await expect(h.service.lookup(input('run'))).resolves.toMatchObject({ kind: 'dictionary' });
  });
});

describe('F6 — per-user limit on dictionary misses', () => {
  it('allows N misses per minute, then answers rate_limited with Retry-After seconds and calls nothing', async () => {
    let t = 1_000_000;
    const h = makeHarness({ limiter: new UserRateLimiter(2, 60_000, () => t) });
    expect((await h.service.lookup(input('aaa'))).kind).toBe('temporary');
    t += 10_000;
    expect((await h.service.lookup(input('bbb'))).kind).toBe('temporary');
    h.google.mockClear();
    h.fd.mockClear();

    t += 10_000;
    const limited = await h.service.lookup(input('ccc'));
    expect(limited).toEqual({ kind: 'rate_limited', retryAfterSeconds: 40 }); // oldest attempt leaves the window in 40 s
    expect(h.google).not.toHaveBeenCalled();
    expect(h.fd).not.toHaveBeenCalled();
  });

  it('the limit is per user and recovers as the window slides', async () => {
    let t = 1_000_000;
    const h = makeHarness({ limiter: new UserRateLimiter(1, 60_000, () => t) });
    expect((await h.service.lookup(input('aaa', 'u1'))).kind).toBe('temporary');
    expect((await h.service.lookup(input('bbb', 'u1'))).kind).toBe('rate_limited');
    expect((await h.service.lookup(input('bbb', 'u2'))).kind).toBe('temporary');
    t += 60_001;
    expect((await h.service.lookup(input('bbb', 'u1'))).kind).toBe('temporary');
  });

  it('dictionary hits never consume the limit', async () => {
    const limiter = new UserRateLimiter(1);
    const h = makeHarness({ limiter, db: { local: (w) => (w === 'run' ? ENTRY : undefined) } });
    for (let i = 0; i < 10; i++) await h.service.lookup(input('run'));
    expect((await h.service.lookup(input('miss1'))).kind).toBe('temporary'); // the single allowed miss is still available
  });
});

describe('F7 — single-flight', () => {
  it('50 simultaneous lookups of one word make ONE Google call and ONE Free Dictionary call (headline only)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = makeHarness({
      config: { translateDefinitions: false },
      google: async (t) => {
        await gate;
        return defaultGoogle(t);
      },
    });

    const calls = Array.from({ length: 50 }, (_, i) => h.service.lookup(input('Zorp', `user-${i}`)));
    await flush();
    release();
    const results = await Promise.all(calls);

    expect(h.google).toHaveBeenCalledTimes(1);
    expect(h.fd).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.kind === 'temporary')).toBe(true);
    expect(new Set(results.map((r: any) => r.body.translation_vi)).size).toBe(1);
  });

  it('with definition translation on, the shared flight costs exactly two Google calls (headline + definitions)', async () => {
    const h = makeHarness();
    await Promise.all(Array.from({ length: 50 }, (_, i) => h.service.lookup(input('zorp', `user-${i}`))));
    expect(h.google).toHaveBeenCalledTimes(2);
    expect(h.fd).toHaveBeenCalledTimes(1);
  });

  it('every waiter still counts against its own rate limit', async () => {
    const limiter = new UserRateLimiter(1000);
    const spy = jest.spyOn(limiter, 'check');
    const h = makeHarness({ limiter });
    await Promise.all(Array.from({ length: 5 }, (_, i) => h.service.lookup(input('zorp', `user-${i}`))));
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('nothing is cached: a later lookup of the same word calls the upstream again', async () => {
    const h = makeHarness({ config: { translateDefinitions: false } });
    await h.service.lookup(input('zorp'));
    await h.service.lookup(input('zorp'));
    expect(h.google).toHaveBeenCalledTimes(2);
    expect(h.fd).toHaveBeenCalledTimes(2);
  });

  it('a failing flight is shared by its waiters, and the key is released afterwards', async () => {
    const flights = new SingleFlight<number>();
    const boom = new Error('boom');
    const attempts = [flights.run('k', async () => { await flush(); throw boom; }), flights.run('k', async () => 1)];
    await expect(Promise.all(attempts)).rejects.toBe(boom);
    expect(flights.size).toBe(0);
    await expect(flights.run('k', async () => 2)).resolves.toEqual({ value: 2, shared: false });
  });
});

describe('F8–F10 — merge matrix end to end (§6)', () => {
  const spyErr = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);

  it('F and G → 200 full, with several Vietnamese meanings', async () => {
    const h = makeHarness({ fd: async () => fdFound(realFdEntry('hello')) });
    const r: any = await h.service.lookup(input('hello'));
    expect(r.kind).toBe('temporary');
    expect(r.body).toMatchObject({ partial: false, missing: [], temporary: true });
    expect(r.body.meanings_vi.length).toBeGreaterThanOrEqual(2);
    expect(r.body.translation_vi).toBe(r.body.meanings_vi.join('; '));
    expect(r.body.senses.length).toBeGreaterThan(0);
    expect(r.body.attribution[0]).toMatchObject({ license: 'CC BY-SA 3.0' });
  });

  it('F, not G (Google down) → partial with translation_vi null — the OLD BUG: it must not echo the word', async () => {
    const h = makeHarness({
      google: async () => {
        throw downErr('google_translate');
      },
    });
    const r: any = await h.service.lookup(input('hello'));
    expect(r.kind).toBe('temporary');
    expect(r.body.translation_vi).toBeNull();
    expect(r.body.translation_vi).not.toBe('hello');
    expect(r.body).toMatchObject({ partial: true, missing: ['translation_vi'], meanings_vi: [] });
    expect(r.body.senses.length).toBeGreaterThan(0); // English side is still useful
    expect(h.google).toHaveBeenCalledTimes(1); // no pointless second request while Google is failing
  });

  it('Google echoes the word and Free Dictionary CONFIRMS it → a loanword (taxi), the echo is kept', async () => {
    const h = makeHarness({ google: async (t) => t.map((x) => (x.includes(': ') ? 'hello: Lời chào' : 'hello')) });
    const r: any = await h.service.lookup(input('hello'));
    expect(r.body.translation_vi).toBe('hello');
    expect(r.body.partial).toBe(false);
  });

  it('Google echoes the word and Free Dictionary does NOT confirm it → not a translation: not_found, never an echo', async () => {
    const h = makeHarness({ google: async (t) => t.map(() => 'zorp'), fd: async () => FD_404 });
    await expect(h.service.lookup(input('zorp'))).resolves.toEqual({ kind: 'not_found' });
  });

  it('Google echoes the word and Free Dictionary is down → unavailable, never an echo', async () => {
    const h = makeHarness({
      google: async (t) => t.map(() => 'zorp'),
      fd: async () => {
        throw downErr();
      },
    });
    await expect(h.service.lookup(input('zorp'))).resolves.toEqual({ kind: 'unavailable' });
  });

  it('G, FD404 → partial, missing pos/definition_en/ipa/audio_url', async () => {
    const h = makeHarness({ fd: async () => FD_404 });
    const r: any = await h.service.lookup(input('zorp'));
    expect(r.body).toMatchObject({ partial: true, missing: ['pos', 'definition_en', 'ipa', 'audio_url'], translation_vi: 'chào' });
    expect(r.body.senses).toEqual([]);
    expect(h.google).toHaveBeenCalledTimes(1); // no definitions to translate
  });

  it('G, FDerr → same partial answer', async () => {
    const h = makeHarness({
      fd: async () => {
        throw downErr();
      },
    });
    const r: any = await h.service.lookup(input('zorp'));
    expect(r.body).toMatchObject({ partial: true, missing: ['pos', 'definition_en', 'ipa', 'audio_url'], translation_vi: 'chào' });
  });

  it('not G, FD404 → not_found, logged as not_found, and NO enrichment job', async () => {
    const h = makeHarness({
      config: { enrichmentEnabled: true },
      db: { refKnown: () => true },
      fd: async () => FD_404,
      google: async () => {
        throw downErr('google_translate');
      },
    });
    await expect(h.service.lookup(input('qwxz'))).resolves.toEqual({ kind: 'not_found' });
    await flush();
    expect(h.db.lookups[0].slice(1, 4)).toEqual([null, 'qwxz', 'not_found']);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('not G, FDerr → unavailable, logged as not_found; a trusted word gets a delayed job when enrichment is on', async () => {
    const h = makeHarness({
      config: { enrichmentEnabled: true },
      db: { refKnown: () => true },
      fd: async () => {
        throw downErr();
      },
      google: async () => {
        throw downErr('google_translate');
      },
    });
    await expect(h.service.lookup(input('serendipity'))).resolves.toEqual({ kind: 'unavailable' });
    await flush();
    expect(h.db.lookups[0].slice(1, 4)).toEqual([null, 'serendipity', 'not_found']);
    expect(h.enqueue).toHaveBeenCalledWith({ word: 'serendipity', requestedBy: 'user-1', ebookId: 'ebook-1', startAfterSeconds: OUTAGE_JOB_DELAY_SECONDS });
    expect(OUTAGE_JOB_DELAY_SECONDS).toBe(60);
  });

  it('not G, FDerr with enrichment off → unavailable and nothing is enqueued', async () => {
    const h = makeHarness({
      fd: async () => {
        throw downErr();
      },
      google: async () => {
        throw downErr('google_translate');
      },
    });
    await expect(h.service.lookup(input('serendipity'))).resolves.toEqual({ kind: 'unavailable' });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('word_lookups: translation for a temporary answer', async () => {
    const h = makeHarness();
    await h.service.lookup(input('Zorp'));
    await flush();
    expect(h.db.lookups).toEqual([['user-1', null, 'Zorp', 'translation', 'ebook-1', null]]);
    spyErr().mockRestore();
  });

  it('never queries word_translation_cache on any path', async () => {
    const all: string[] = [];
    for (const opts of [
      {},
      { fd: async () => FD_404 },
      { config: { translationFallbackEnabled: false } },
      { db: { local: () => ENTRY } },
      { google: async () => { throw downErr('google_translate'); } },
    ] as any[]) {
      const h = makeHarness(opts);
      await h.service.lookup(input('zorp')).catch(() => undefined);
      await flush();
      all.push(...h.db.sqls);
    }
    expectNoWordTranslationCache(all);
  });
});

describe('F9 — second step (definitions)', () => {
  it('sends ONE request of "<headword>: <definition>" strings, at most LOOKUP_MAX_MEANINGS, truncated', async () => {
    const h = makeHarness({ config: { maxMeanings: 2, maxDefinitionChars: 20 } });
    await h.service.lookup(input('hello'));
    expect(h.google).toHaveBeenCalledTimes(2);
    const [definitionRequest] = h.google.mock.calls[1];
    expect(definitionRequest).toHaveLength(2);
    for (const q of definitionRequest as string[]) {
      expect(q.startsWith('hello: ')).toBe(true);
      expect(q.length).toBeLessThanOrEqual('hello: '.length + 20);
    }
  });

  it('LOOKUP_TRANSLATE_DEFINITIONS=false skips it, leaving English senses without Vietnamese', async () => {
    const h = makeHarness({ config: { translateDefinitions: false } });
    const r: any = await h.service.lookup(input('hello'));
    expect(h.google).toHaveBeenCalledTimes(1);
    expect(r.body.senses.every((s: any) => s.definition_vi === null && s.gloss_vi === null)).toBe(true);
    expect(r.body.partial).toBe(false); // switched off on purpose is not a degradation
  });

  it('a failing second request keeps the headline and marks definition_vi as missing', async () => {
    let n = 0;
    const h = makeHarness({
      google: async (t) => {
        if (++n === 2) throw downErr('google_translate');
        return defaultGoogle(t);
      },
    });
    const r: any = await h.service.lookup(input('hello'));
    expect(r.body).toMatchObject({ partial: true, translation_vi: 'chào' });
    expect(r.body.missing).toContain('definition_vi');
  });

  it('fills gloss_vi and definition_vi per sense, and merges glosses into translation_vi', async () => {
    const h = makeHarness();
    const r: any = await h.service.lookup(input('hello'));
    expect(r.body.senses[0]).toMatchObject({ gloss_vi: 'nghĩa 1', definition_vi: 'Định nghĩa 1' });
    expect(r.body.translation_vi.startsWith('chào; nghĩa 1')).toBe(true);
  });
});

describe('F11 — enrichment hook', () => {
  it('disabled → status disabled, queue never touched', async () => {
    const h = makeHarness({ config: { enrichmentEnabled: false } });
    const r: any = await h.service.lookup(input('hello'));
    expect(r.body.enrichment).toEqual({ status: 'disabled' });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('enabled and Free Dictionary knows the word → enqueue with the user and ebook', async () => {
    const h = makeHarness({ config: { enrichmentEnabled: true }, enqueueResult: { status: 'queued' } });
    const r: any = await h.service.lookup(input('hello'));
    expect(r.body.enrichment).toEqual({ status: 'queued' });
    expect(h.enqueue).toHaveBeenCalledWith({ word: 'hello', requestedBy: 'user-1', ebookId: 'ebook-1', startAfterSeconds: undefined });
  });

  it('enabled but the word is not trusted → skipped/unknown_word, no job', async () => {
    const h = makeHarness({ config: { enrichmentEnabled: true }, fd: async () => FD_404, db: { refKnown: () => false } });
    const r: any = await h.service.lookup(input('zorp'));
    expect(r.body.enrichment).toEqual({ status: 'skipped', reason: 'unknown_word' });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('a word known only to the local reference data is trusted', async () => {
    const h = makeHarness({ config: { enrichmentEnabled: true }, fd: async () => FD_404, db: { refKnown: () => true } });
    const r: any = await h.service.lookup(input('zorp'));
    expect(h.enqueue).toHaveBeenCalled();
    expect(r.body.enrichment.status).toBe('queued');
  });

  it('a queue failure is logged and reported, but never breaks the response', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = makeHarness({ config: { enrichmentEnabled: true }, enqueueThrows: true });
    const r: any = await h.service.lookup(input('hello'));
    expect(r.kind).toBe('temporary');
    expect(r.body.enrichment).toEqual({ status: 'skipped', reason: 'queue_error' });
    spy.mockRestore();
  });

  it('passes already_queued through', async () => {
    const h = makeHarness({ config: { enrichmentEnabled: true }, enqueueResult: { status: 'already_queued' } });
    const r: any = await h.service.lookup(input('hello'));
    expect(r.body.enrichment.status).toBe('already_queued');
  });
});

describe('structured logging (§12.1)', () => {
  it('logs one lookup record with outcome, timings and no response content', async () => {
    const h = makeHarness();
    await h.service.lookup(input('hello'));
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ evt: 'lookup', word: 'hello', outcome: 'temporary', source: 'translation', partial: false, shared: false, enrichment_status: 'disabled' });
    expect(h.logs[0]).toHaveProperty('latency_ms');
    expect(h.logs[0]).toHaveProperty('google_ms');
    expect(h.logs[0]).toHaveProperty('fd_ms');
    expect(JSON.stringify(h.logs[0])).not.toMatch(/Định nghĩa|greeting/i);
  });

  it('a throwing log sink does not break the lookup', async () => {
    const service = new WordLookupService({ ...(makeHarness() as any).service.deps, log: () => { throw new Error('sink'); } });
    await expect(service.lookup(input('hello'))).resolves.toMatchObject({ kind: 'temporary' });
  });
});

// ── timeouts and the overall deadline, with the REAL clients over a fetch that never answers ──────────
describe('timeouts and the total deadline', () => {
  function realClientsOver(fetchImpl: any, cfg: { timeoutMs: number; totalDeadlineMs: number }) {
    const breaker = (p: any) => new CircuitBreaker(p, { failureThreshold: 100, resetMs: 1000 });
    const google = new GoogleTranslateClient(
      { apiKey: 'k', baseUrl: 'https://g.test/', monthlyCharLimit: 1e9, timeoutMs: cfg.timeoutMs, maxAttempts: 2 },
      { usage: { reserve: async () => true, release: async () => undefined }, breaker: breaker('google_translate'), fetchImpl, sleep: async () => undefined, random: () => 0 }
    );
    const freeDictionary = new FreeDictionaryClient(
      { baseUrl: 'https://fd.test/en', timeoutMs: cfg.timeoutMs, maxAttempts: 2 },
      { breaker: breaker('free_dictionary'), bucket: new TokenBucket({ capacity: 100, windowMs: 1000 }), fetchImpl, sleep: async () => undefined, random: () => 0 }
    );
    return new WordLookupService({
      ...(makeHarness() as any).service.deps,
      translator: new GoogleFastTranslator(google),
      google,
      freeDictionary,
      config: { totalDeadlineMs: cfg.totalDeadlineMs, maxMeanings: 4, translateDefinitions: true, maxDefinitionChars: 160, translationFallbackEnabled: true, enrichmentEnabled: false },
    });
  }

  it('both sources hang → unavailable, and it returns around the deadline, not much later', async () => {
    const service = realClientsOver(hangingFetch, { timeoutMs: 60, totalDeadlineMs: 150 });
    const started = Date.now();
    await expect(service.lookup(input('zorp'))).resolves.toEqual({ kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(600);
  });

  it('when a client hangs past its timeout the other source still answers (partial)', async () => {
    const fetchImpl = (url: string, init?: RequestInit) =>
      url.startsWith('https://fd.test')
        ? hangingFetch(url, init)
        : Promise.resolve(new Response(JSON.stringify({ data: { translations: [{ translatedText: 'chào' }] } }), { status: 200 }));
    const service = realClientsOver(fetchImpl, { timeoutMs: 60, totalDeadlineMs: 2000 });
    const started = Date.now();
    const r: any = await service.lookup(input('zorp'));
    expect(r.kind).toBe('temporary');
    expect(r.body).toMatchObject({ partial: true, translation_vi: 'chào', missing: ['pos', 'definition_en', 'ipa', 'audio_url'] });
    expect(Date.now() - started).toBeLessThan(700);
  });

  it('not enough deadline left for the second request → it is skipped and the result is marked partial', async () => {
    let t = 0;
    const h = makeHarness({
      now: () => t,
      google: async (texts) => {
        t += 2800; // the headline "takes" 2.8 s of a 3 s budget
        return defaultGoogle(texts);
      },
    });
    const r: any = await h.service.lookup(input('hello'));
    expect(h.google).toHaveBeenCalledTimes(1);
    expect(r.body).toMatchObject({ partial: true, translation_vi: 'chào' });
    expect(r.body.missing).toContain('definition_vi');
  });

  it('the deadline counts from the START of the lookup: slow local queries use up part of the budget', async () => {
    let t = 5_000;
    const h = makeHarness({
      now: () => t,
      db: {
        local: () => {
          t += 1_500; // a slow database
          return undefined;
        },
      },
    });
    await h.service.lookup(input('hello'));
    expect(h.google.mock.calls[0][1]).toEqual({ deadlineAt: 8_000 }); // 5000 + 3000, NOT 6500 + 3000
    expect(h.fd.mock.calls[0][1]).toEqual({ deadlineAt: 8_000 });
  });

  it('logs how long the local part took', async () => {
    let t = 0;
    const h = makeHarness({ now: () => t, db: { local: () => { t += 250; return undefined; } } });
    await h.service.lookup(input('hello'));
    expect(h.logs[0]).toMatchObject({ local_ms: 250 });
  });

  it('passes one absolute deadline to every upstream call', async () => {
    const h = makeHarness({ now: () => 5_000 });
    await h.service.lookup(input('hello'));
    expect(h.google.mock.calls[0][1]).toEqual({ deadlineAt: 8_000 });
    expect(h.fd.mock.calls[0][1]).toEqual({ deadlineAt: 8_000 });
  });
});

describe('UpstreamUnavailable import sanity', () => {
  it('is the class the clients throw', () => {
    expect(new UpstreamUnavailable('google_translate', 'timeout')).toBeInstanceOf(Error);
  });
});

// keep the type import used (UpstreamBundle documents the single-flight payload)
export type _Payload = UpstreamBundle;
