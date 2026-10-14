import Anthropic from '@anthropic-ai/sdk';
import { AnthropicEnrichClient, CreateMessageFn } from '../../services/upstream/anthropicEnrichClient';
import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';
import { describeFailure, FALLBACK_RESERVE_MS, FallbackFastTranslator, FastTranslateResult, FastTranslator, GoogleFastTranslator } from '../../services/lookup/fastTranslator';
import { HaikuFastTranslator } from '../../services/lookup/haikuFastTranslator';

const haikuOk: FastTranslateResult = { engine: 'haiku', meanings_vi: ['ngân hàng', 'bờ sông'], pos: ['noun', 'noun'] };

function setup(primary: FastTranslator['translate'], googleHeadline: string | Error = 'ngân hàng', now: () => number = () => 0) {
  const googleTranslate = jest.fn(async (_texts: string[], _opts?: any) => {
    if (googleHeadline instanceof Error) throw googleHeadline;
    return [googleHeadline];
  });
  const onFallback = jest.fn();
  const translator = new FallbackFastTranslator({ translate: primary }, new GoogleFastTranslator({ translate: googleTranslate }), onFallback, { now });
  return { translator, googleTranslate, onFallback };
}

describe('GoogleFastTranslator (the unchanged P3 step 1)', () => {
  it('translates the bare word and returns it as the single headline meaning', async () => {
    const google = jest.fn(async (_t: string[], _o?: any) => ['  chạy  ']);
    const r = await new GoogleFastTranslator({ translate: google }).translate({ word: 'run', deadlineAt: 123 });
    expect(r).toEqual({ meanings_vi: ['chạy'], engine: 'google' });
    expect(google).toHaveBeenCalledWith(['run'], { deadlineAt: 123, signal: undefined });
  });

  it('an empty answer is "no meaning", not an error', async () => {
    const r = await new GoogleFastTranslator({ translate: async () => [''] }).translate({ word: 'zorp' });
    expect(r.meanings_vi).toEqual([]);
  });

  it('errors propagate untouched', async () => {
    const err = new UpstreamUnavailable('google_translate', 'http_5xx');
    await expect(new GoogleFastTranslator({ translate: async () => { throw err; } }).translate({ word: 'x' })).rejects.toBe(err);
  });
});

describe('FallbackFastTranslator', () => {
  it('Haiku succeeded → its answer is used and Google is never called', async () => {
    const { translator, googleTranslate, onFallback } = setup(async () => haikuOk);
    await expect(translator.translate({ word: 'bank' })).resolves.toEqual(haikuOk);
    expect(googleTranslate).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  // The three cases the task requires: Haiku error/timeout, spent budget, open breaker.
  it.each([
    ['timeout', new UpstreamUnavailable('anthropic', 'timeout'), 'timeout'],
    ['an API error (5xx)', new UpstreamUnavailable('anthropic', 'http_5xx', { status: 529 }), 'http_5xx'],
    ['a spent budget', new BudgetExceeded('anthropic', 'spend_limit'), 'budget'],
    ['an open circuit breaker', new UpstreamUnavailable('anthropic', 'breaker_open'), 'breaker_open'],
    ['rate limiting', new UpstreamUnavailable('anthropic', 'rate_limited', { retryAfterMs: 5000 }), 'rate_limited'],
    ['malformed output', new UpstreamUnavailable('anthropic', 'bad_response'), 'bad_response'],
    ['a configuration error (bad key / model)', new UpstreamConfigError('anthropic', 'HTTP 401', 401), 'config'],
    ['an unexpected bug', new TypeError('oops'), 'unexpected'],
  ])('Haiku fails with %s → Google answers (step 1 only) and the reason is recorded', async (_name, error, reason) => {
    const { translator, googleTranslate, onFallback } = setup(async () => {
      throw error;
    }, 'ngân hàng');
    const r = await translator.translate({ word: 'bank', deadlineAt: 5_000 });

    expect(r).toEqual({ meanings_vi: ['ngân hàng'], engine: 'google', fallback: { from: 'haiku', reason } });
    expect(googleTranslate).toHaveBeenCalledTimes(1);
    expect(googleTranslate).toHaveBeenCalledWith(['bank'], { deadlineAt: 5_000, signal: undefined }); // same word, same deadline
    expect(onFallback).toHaveBeenCalledWith(reason, error);
  });

  it('an EMPTY Haiku answer ("not a word") is a verdict, not a failure: no fallback', async () => {
    const empty: FastTranslateResult = { engine: 'haiku', meanings_vi: [] };
    const { translator, googleTranslate } = setup(async () => empty);
    await expect(translator.translate({ word: 'qwxz' })).resolves.toEqual(empty);
    expect(googleTranslate).not.toHaveBeenCalled();
  });

  it('if Google fails too, the Google error is what the caller sees', async () => {
    const googleDown = new UpstreamUnavailable('google_translate', 'http_5xx');
    const { translator } = setup(async () => { throw new UpstreamUnavailable('anthropic', 'timeout'); }, googleDown);
    await expect(translator.translate({ word: 'bank' })).rejects.toBe(googleDown);
  });

  it('does not start Google when the caller has already cancelled', async () => {
    const ac = new AbortController();
    const boom = new UpstreamUnavailable('anthropic', 'timeout');
    const { translator, googleTranslate } = setup(async () => { ac.abort(); throw boom; });
    await expect(translator.translate({ word: 'bank', signal: ac.signal })).rejects.toBe(boom);
    expect(googleTranslate).not.toHaveBeenCalled();
  });

  it('a throwing observer never breaks the fallback', async () => {
    const google = new GoogleFastTranslator({ translate: async () => ['ngân hàng'] });
    const t = new FallbackFastTranslator({ translate: async () => { throw new Error('x'); } }, google, () => { throw new Error('observer'); });
    await expect(t.translate({ word: 'bank' })).resolves.toMatchObject({ engine: 'google' });
  });
});

describe('FallbackFastTranslator — keeping time for the fallback', () => {
  it('the primary gets the lookup deadline MINUS the reserve; Google keeps the original deadline', async () => {
    const primary = jest.fn(async (_input: any) => haikuOk);
    const { translator } = setup(primary, 'x', () => 1_000);
    await translator.translate({ word: 'bank', deadlineAt: 4_000 });
    expect(primary.mock.calls[0][0].deadlineAt).toBe(4_000 - FALLBACK_RESERVE_MS);
    expect(FALLBACK_RESERVE_MS).toBeGreaterThanOrEqual(300);
  });

  it('a primary that runs out ITS share still leaves Google time: the fallback deadline is the original one', async () => {
    const primary = async () => { throw new UpstreamUnavailable('anthropic', 'timeout'); };
    const { translator, googleTranslate } = setup(primary, 'ngân hàng', () => 1_000);
    await translator.translate({ word: 'bank', deadlineAt: 4_000 });
    expect(googleTranslate).toHaveBeenCalledWith(['bank'], { deadlineAt: 4_000, signal: undefined });
  });

  it('when less than the reserve is left, Haiku is not even tried: Google answers straight away (reason no_time)', async () => {
    const primary = jest.fn(async () => haikuOk);
    const { translator, googleTranslate, onFallback } = setup(primary, 'ngân hàng', () => 3_600);
    const r = await translator.translate({ word: 'bank', deadlineAt: 4_000 }); // only 400 ms left < 500 reserve
    expect(primary).not.toHaveBeenCalled();
    expect(googleTranslate).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ meanings_vi: ['ngân hàng'], engine: 'google', fallback: { from: 'haiku', reason: 'no_time' } });
    expect(onFallback).toHaveBeenCalledWith('no_time', expect.anything());
  });

  it('without a deadline the primary gets the input untouched', async () => {
    const primary = jest.fn(async (_input: any) => haikuOk);
    const { translator } = setup(primary);
    await translator.translate({ word: 'bank' });
    expect(primary.mock.calls[0][0]).toEqual({ word: 'bank' });
  });
});

describe('describeFailure', () => {
  it.each([
    [new UpstreamUnavailable('anthropic', 'timeout'), 'timeout'],
    [new BudgetExceeded('anthropic', 'spend_limit'), 'budget'],
    [new UpstreamConfigError('anthropic', 'x'), 'config'],
    [new Error('x'), 'unexpected'],
    ['string', 'unexpected'],
  ])('%p → %s', (err, expected) => {
    expect(describeFailure(err)).toBe(expected);
  });
});

// ── the same three cases with the REAL Anthropic client (SDK errors, real breaker) ─────────────────────
describe('Haiku → Google fallback through the real AnthropicEnrichClient', () => {
  const CONFIG = { apiKey: 'sk-test', model: 'claude-haiku-5-5', maxOutputTokens: 300, timeoutMs: 2500 };
  const apiError = (status: number, body: object) => Anthropic.APIError.generate(status, body, undefined, new Headers());
  const okMessage = {
    data: {
      id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ meanings: [{ vi: 'ngân hàng', pos: 'noun' }, { vi: 'bờ sông', pos: 'noun' }] }), citations: null }],
      usage: { input_tokens: 466, output_tokens: 70 },
    } as any,
    request_id: 'req_ok',
  };

  function build(create: CreateMessageFn, threshold = 5) {
    const breaker = new CircuitBreaker('anthropic', { failureThreshold: threshold, resetMs: 30_000 });
    const client = new AnthropicEnrichClient(CONFIG, { breaker, createMessage: create });
    const google = jest.fn(async (_t: string[], _o?: any) => ['ngân hàng']);
    const usage = jest.fn();
    const translator = new FallbackFastTranslator(
      new HaikuFastTranslator({ client, maxMeanings: 4, recordUsage: usage }),
      new GoogleFastTranslator({ translate: google })
    );
    return { translator, google, usage, breaker };
  }

  it('works when Haiku answers', async () => {
    const { translator, google, usage } = build(async () => okMessage);
    const r = await translator.translate({ word: 'bank' });
    expect(r).toMatchObject({ engine: 'haiku', meanings_vi: ['ngân hàng', 'bờ sông'] });
    expect(google).not.toHaveBeenCalled();
    expect(usage).toHaveBeenCalledWith({ inputTokens: 466, outputTokens: 70 });
  });

  it('1) timeout: the SDK timeout error falls back to Google', async () => {
    const { translator, google } = build(async () => { throw new Anthropic.APIConnectionTimeoutError(); });
    const r = await translator.translate({ word: 'bank' });
    expect(r).toMatchObject({ engine: 'google', fallback: { from: 'haiku', reason: 'timeout' } });
    expect(google).toHaveBeenCalledTimes(1);
  });

  it('2) spent budget: enforced_spend_limit_reached falls back to Google and never retries Haiku', async () => {
    const create = jest.fn<ReturnType<CreateMessageFn>, Parameters<CreateMessageFn>>(async () => {
      throw apiError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x', details: { error_code: 'enforced_spend_limit_reached' } } });
    });
    const { translator, google } = build(create);
    const r = await translator.translate({ word: 'bank' });
    expect(r).toMatchObject({ engine: 'google', fallback: { reason: 'budget' } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(google).toHaveBeenCalledTimes(1);
  });

  it('3) open breaker: after repeated failures Haiku is not even called, Google answers at once', async () => {
    const create = jest.fn<ReturnType<CreateMessageFn>, Parameters<CreateMessageFn>>(async () => {
      throw apiError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    });
    const { translator, google, breaker } = build(create, 2);
    await translator.translate({ word: 'a' });
    await translator.translate({ word: 'b' });
    expect(breaker.currentState()).toBe('open');

    create.mockClear();
    const r = await translator.translate({ word: 'c' });
    expect(create).not.toHaveBeenCalled(); // fail fast: no wait for a dead service
    expect(r).toMatchObject({ engine: 'google', fallback: { reason: 'breaker_open' } });
    expect(google).toHaveBeenCalledTimes(3);
  });

  it('a Haiku answer with stop_reason max_tokens falls back too (never a half answer)', async () => {
    const cut = { ...okMessage, data: { ...okMessage.data, stop_reason: 'max_tokens' } };
    const { translator } = build(async () => cut);
    expect(await translator.translate({ word: 'bank' })).toMatchObject({ engine: 'google', fallback: { reason: 'bad_response' } });
  });
});
