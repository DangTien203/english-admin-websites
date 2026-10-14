import { FallbackFastTranslator, FastTranslator, GoogleFastTranslator } from '../../services/lookup/fastTranslator';
import { HaikuFastTranslator } from '../../services/lookup/haikuFastTranslator';
import { UpstreamUnavailable } from '../../services/upstream/errors';
import { defaultGoogle, downErr, FD_404, fdFound, flush, input, makeHarness, realFdEntry } from './serviceHarness';

const BANK = JSON.stringify({
  meanings: [
    { vi: 'ngân hàng', pos: 'noun' },
    { vi: 'bờ sông', pos: 'noun' },
    { vi: 'gửi tiền', pos: 'verb' },
  ],
});

type HaikuBehaviour = (params: any, opts: any) => Promise<{ text: string; stopReason?: string }>;

/** Builds the production composition (Haiku → Google fallback) over a fake Anthropic client and the harness's Google mock. */
function haikuTranslator(behaviour: HaikuBehaviour, extra: { maxMeanings?: number; recordUsage?: jest.Mock; now?: () => number } = {}) {
  const call = jest.fn(async (params: any, opts: any) => {
    const r = await behaviour(params, opts);
    return { text: r.text, stopReason: r.stopReason ?? 'end_turn', usage: { inputTokens: 466, outputTokens: 90, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, requestId: 'req', model: 'm', message: {} as any };
  });
  const factory = (google: any): FastTranslator =>
    new FallbackFastTranslator(
      new HaikuFastTranslator({ client: { call: call as any }, maxMeanings: extra.maxMeanings ?? 4, recordUsage: extra.recordUsage }),
      new GoogleFastTranslator({ translate: google }),
      undefined,
      { now: extra.now }
    );
  return { call, factory };
}

describe('LOOKUP_FAST_TRANSLATOR=haiku — meanings and definitions', () => {
  it('meanings_vi come from Haiku; Google is called ONCE, only for the definitions (step 2)', async () => {
    const { factory } = haikuTranslator(async () => ({ text: BANK }));
    const h = makeHarness({ translator: factory, fd: async () => fdFound(realFdEntry('hello')) });
    const r: any = await h.service.lookup(input('bank'));

    expect(r.kind).toBe('temporary');
    expect(r.body.meanings_vi).toEqual(['ngân hàng', 'bờ sông', 'gửi tiền']);
    expect(r.body.translation_vi).toBe('ngân hàng; bờ sông; gửi tiền');
    expect(r.body).toMatchObject({ partial: false, missing: [] });
    expect(h.google).toHaveBeenCalledTimes(1);
    const queries = h.google.mock.calls[0][0] as string[];
    expect(queries.every((q) => q.includes(': '))).toBe(true); // "<word>: <definition>" strings, not the bare word
  });

  it('senses[].definition_vi and gloss_vi are still filled by step 2, but the glosses do NOT leak into meanings_vi', async () => {
    const { factory } = haikuTranslator(async () => ({ text: BANK }));
    const h = makeHarness({ translator: factory });
    const r: any = await h.service.lookup(input('bank'));
    expect(r.body.senses[0]).toMatchObject({ gloss_vi: 'nghĩa 1', definition_vi: 'Định nghĩa 1' });
    expect(r.body.meanings_vi).not.toContain('nghĩa 1');
  });

  it('LOOKUP_TRANSLATE_DEFINITIONS=false: Google is never called in haiku mode', async () => {
    const { factory } = haikuTranslator(async () => ({ text: BANK }));
    const h = makeHarness({ translator: factory, config: { translateDefinitions: false } });
    const r: any = await h.service.lookup(input('bank'));
    expect(h.google).not.toHaveBeenCalled();
    expect(r.body.meanings_vi).toHaveLength(3);
    expect(r.body.senses.every((s: any) => s.definition_vi === null)).toBe(true);
  });

  it('LOOKUP_MAX_MEANINGS cuts the Haiku list', async () => {
    const { factory } = haikuTranslator(async () => ({ text: BANK }), { maxMeanings: 2 });
    const h = makeHarness({ translator: factory, config: { maxMeanings: 2 } });
    expect(((await h.service.lookup(input('bank'))) as any).body.meanings_vi).toEqual(['ngân hàng', 'bờ sông']);
  });

  it('providers show who really worked', async () => {
    const { factory } = haikuTranslator(async () => ({ text: BANK }));
    const h = makeHarness({ translator: factory });
    expect(((await h.service.lookup(input('bank'))) as any).body.providers).toEqual(['claude_haiku', 'google_translate', 'free_dictionary_api']);
  });

  it('the response contract is unchanged: same fields as in google mode', async () => {
    const { factory } = haikuTranslator(async () => ({ text: BANK }));
    const viaHaiku: any = await makeHarness({ translator: factory }).service.lookup(input('bank'));
    const viaGoogle: any = await makeHarness().service.lookup(input('bank'));
    expect(Object.keys(viaHaiku.body).sort()).toEqual(Object.keys(viaGoogle.body).sort());
    expect(typeof viaHaiku.body.pos).toBe('string');
    expect(Array.isArray(viaHaiku.body.meanings_vi)).toBe(true);
  });
});

describe('haiku mode — runs in parallel with Free Dictionary', () => {
  it('both calls are started before either has answered', async () => {
    const started: string[] = [];
    let releaseBoth!: () => void;
    const gate = new Promise<void>((r) => (releaseBoth = r));
    const { factory } = haikuTranslator(async () => {
      started.push('haiku');
      await gate;
      return { text: BANK };
    });
    const h = makeHarness({
      translator: factory,
      fd: async () => {
        started.push('fd');
        await gate;
        return fdFound(realFdEntry('hello'));
      },
    });

    const pending = h.service.lookup(input('bank'));
    await flush();
    expect(started.sort()).toEqual(['fd', 'haiku']); // neither waited for the other
    releaseBoth();
    expect((await pending).kind).toBe('temporary');
  });

  it('50 simultaneous lookups of one word make ONE Haiku call', async () => {
    const { call, factory } = haikuTranslator(async () => ({ text: BANK }));
    const h = makeHarness({ translator: factory, config: { translateDefinitions: false } });
    await Promise.all(Array.from({ length: 50 }, (_, i) => h.service.lookup(input('bank', `u${i}`))));
    expect(call).toHaveBeenCalledTimes(1);
    expect(h.fd).toHaveBeenCalledTimes(1);
  });
});

describe('haiku mode — fallback to Google', () => {
  const failures: Array<[string, HaikuBehaviour, string]> = [
    ['an error', async () => { throw new UpstreamUnavailable('anthropic', 'http_5xx', { status: 529 }); }, 'http_5xx'],
    ['a timeout', async () => { throw new UpstreamUnavailable('anthropic', 'timeout'); }, 'timeout'],
    ['an open breaker', async () => { throw new UpstreamUnavailable('anthropic', 'breaker_open'); }, 'breaker_open'],
    ['malformed output', async () => ({ text: 'not json' }), 'bad_response'],
  ];

  it.each(failures)('%s → Google supplies the meanings (headline + glosses, like google mode)', async (_name, behaviour, reason) => {
    const { factory } = haikuTranslator(behaviour);
    const h = makeHarness({ translator: factory });
    const r: any = await h.service.lookup(input('hello'));

    expect(r.kind).toBe('temporary');
    expect(r.body.meanings_vi).toEqual(['chào', 'nghĩa 1', 'nghĩa 2', 'nghĩa 3'].slice(0, 4));
    expect(r.body.partial).toBe(false);
    expect(h.google).toHaveBeenCalledTimes(2); // step 1 (bare word, the fallback) + step 2 (definitions)
    expect(h.google.mock.calls[0][0]).toEqual(['hello']);
    expect(h.logs[0]).toMatchObject({ translator: 'google_fallback', fallback_reason: reason });
    expect(r.body.providers).toEqual(['google_translate', 'free_dictionary_api']);
  });

  it('Haiku spent the whole budget AND Google is down → unavailable/partial exactly like google mode', async () => {
    const { factory } = haikuTranslator(async () => { throw new UpstreamUnavailable('anthropic', 'timeout'); });
    const h = makeHarness({
      translator: factory,
      fd: async () => { throw downErr(); },
      google: async () => { throw downErr('google_translate'); },
    });
    await expect(h.service.lookup(input('bank'))).resolves.toEqual({ kind: 'unavailable' });
  });

  it('the fallback is bounded by the same deadline: Google gets the lookup deadline', async () => {
    const { factory } = haikuTranslator(async () => { throw new UpstreamUnavailable('anthropic', 'timeout'); }, { now: () => 5_000 });
    const h = makeHarness({ translator: factory, now: () => 5_000 });
    await h.service.lookup(input('hello'));
    expect(h.google.mock.calls[0][1]).toMatchObject({ deadlineAt: 8_000 });
    expect(h.logs[0]).toMatchObject({ translator: 'google_fallback', fallback_reason: 'timeout' }); // Haiku WAS tried (3000 ms left > 500 reserve)
  });

  it('a cold start that already used most of the deadline: Haiku is skipped, Google answers (reason no_time)', async () => {
    let t = 0;
    const { call, factory } = haikuTranslator(async () => ({ text: BANK }), { now: () => t });
    const h = makeHarness({
      translator: factory,
      now: () => t,
      db: { local: () => { t += 2_700; return undefined; } }, // slow first database connection: 300 ms left of 3000
    });
    const r: any = await h.service.lookup(input('hello'));
    expect(call).not.toHaveBeenCalled(); // no time for a ~1.7 s Haiku call
    expect(r.kind).toBe('temporary');
    expect(r.body.translation_vi.startsWith('chào')).toBe(true); // the lookup still gets a translation instead of none
    expect(h.logs[0]).toMatchObject({ translator: 'google_fallback', fallback_reason: 'no_time' });
  });
});

describe('haiku mode — the merge matrix still holds', () => {
  it('Haiku says "not a word" (empty list) and Free Dictionary agrees → not_found, and Google is never asked', async () => {
    const { factory } = haikuTranslator(async () => ({ text: JSON.stringify({ meanings: [] }) }));
    const h = makeHarness({ translator: factory, fd: async () => FD_404 });
    await expect(h.service.lookup(input('qwxz'))).resolves.toEqual({ kind: 'not_found' });
    expect(h.google).not.toHaveBeenCalled();
  });

  it('Haiku answers, Free Dictionary is down → partial with the documented missing list', async () => {
    const { factory } = haikuTranslator(async () => ({ text: BANK }));
    const h = makeHarness({ translator: factory, fd: async () => { throw downErr(); } });
    const r: any = await h.service.lookup(input('bank'));
    expect(r.body).toMatchObject({ partial: true, missing: ['pos', 'definition_en', 'ipa', 'audio_url'], translation_vi: 'ngân hàng; bờ sông; gửi tiền' });
    expect(h.google).not.toHaveBeenCalled(); // no senses → nothing to translate
  });

  it('Haiku answers but the definitions step fails → meanings stay, definition_vi is reported missing', async () => {
    const { factory } = haikuTranslator(async () => ({ text: BANK }));
    const h = makeHarness({ translator: factory, google: async () => { throw downErr('google_translate'); } });
    const r: any = await h.service.lookup(input('bank'));
    expect(r.body.meanings_vi).toHaveLength(3);
    expect(r.body).toMatchObject({ partial: true });
    expect(r.body.missing).toContain('definition_vi');
  });

  it('Haiku answers, Free Dictionary says 404 → partial; the word is not rejected', async () => {
    const { factory } = haikuTranslator(async () => ({ text: BANK }));
    const h = makeHarness({ translator: factory, fd: async () => FD_404 });
    const r: any = await h.service.lookup(input('bank'));
    expect(r.body).toMatchObject({ partial: true, translation_vi: 'ngân hàng; bờ sông; gửi tiền' });
  });

  it('never repeats the looked-up word as a meaning unless Free Dictionary confirms it', async () => {
    const { factory } = haikuTranslator(async () => ({ text: JSON.stringify({ meanings: [{ vi: 'zorp', pos: 'noun' }] }) }));
    const h = makeHarness({ translator: factory, fd: async () => FD_404 });
    await expect(h.service.lookup(input('zorp'))).resolves.toEqual({ kind: 'not_found' });
  });
});

describe('haiku mode — logging and usage', () => {
  it('logs the translator, its time and the tokens spent', async () => {
    const { factory } = haikuTranslator(async () => ({ text: BANK }));
    const h = makeHarness({ translator: factory });
    await h.service.lookup(input('bank'));
    expect(h.logs[0]).toMatchObject({ evt: 'lookup', translator: 'haiku', fallback_reason: null, haiku_tokens_in: 466, haiku_tokens_out: 90, google_ms: null });
    expect(h.logs[0]).toHaveProperty('translation_ms');
  });

  it('google mode logs translator=google and keeps google_ms', async () => {
    const h = makeHarness();
    await h.service.lookup(input('hello'));
    expect(h.logs[0]).toMatchObject({ translator: 'google', fallback_reason: null, haiku_tokens_in: null });
    expect(h.logs[0].google_ms).not.toBeNull();
  });
});

// keep the unused import honest: defaultGoogle documents what step 2 receives in these tests
export const _ = defaultGoogle;
