import { generateDraft } from '../../services/enrichment/draft';
import type { HaikuCaller, HaikuResponse } from '../../services/enrichment/haiku/client';
import { describeDraftCost, estimateCallCostUsd, estimateDraftCostUsd, MODEL_PRICES, PRICING_CHECKED_ON } from '../../services/enrichment/pricing';
import { makeBundle, makeDraft, makeSense } from './fixtures';

const M = 1_000_000;
const MODEL = 'claude-haiku-5-5';

describe('price table (checked against https://platform.claude.com/docs/en/about-claude/pricing)', () => {
  it('Claude Haiku 5.5: $0.10 in, $0.50 out, 5-minute cache write $0.125, cache read $0.01 per million tokens (prompts up to 100K)', () => {
    expect(MODEL_PRICES[MODEL]).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5, cacheWrite5mPerMTok: 0.125, cacheReadPerMTok: 0.01, longPromptThreshold: 100_000 });
  });

  it('…and $0.50 / $2.50 / $0.625 / $0.05 for a request whose prompt is longer than 100K tokens', () => {
    expect(MODEL_PRICES[MODEL].long).toEqual({ inputPerMTok: 0.5, outputPerMTok: 2.5, cacheWrite5mPerMTok: 0.625, cacheReadPerMTok: 0.05 });
  });

  it('records the day it was checked', () => {
    expect(PRICING_CHECKED_ON).toBe('2026-10-15');
  });
});

describe('estimateCallCostUsd (one request)', () => {
  it('prices each token class at its own rate', () => {
    const cost = estimateCallCostUsd(MODEL, { inputTokens: 1000, outputTokens: 2000, cacheCreationInputTokens: 8000, cacheReadInputTokens: 4000 });
    expect(cost).toBeCloseTo((1000 * 0.1 + 2000 * 0.5 + 8000 * 0.125 + 4000 * 0.01) / M, 12);
  });

  it('the prompt length for the long rate counts cache writes and reads too', () => {
    // 20K fresh + 90K cached = 110K prompt tokens → long rates for everything in this request
    const cost = estimateCallCostUsd(MODEL, { inputTokens: 20_000, outputTokens: 1000, cacheReadInputTokens: 90_000 });
    expect(cost).toBeCloseTo((20_000 * 0.5 + 1000 * 2.5 + 90_000 * 0.05) / M, 12);
  });

  it('exactly 100K is still the standard rate', () => {
    expect(estimateCallCostUsd(MODEL, { inputTokens: 100_000, outputTokens: 0 })).toBeCloseTo((100_000 * 0.1) / M, 12);
  });

  it('an unknown model gets no estimate, never a guess', () => {
    expect(estimateCallCostUsd('some-other-model', { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});

describe('estimateDraftCostUsd (a draft is one or two requests, each priced on its own)', () => {
  // podcast: the first answer needed a repair, so two requests. The first one wrote the prompt cache, the second read it.
  const first = { inputTokens: 1100, outputTokens: 1009, cacheCreationInputTokens: 7859, cacheReadInputTokens: 0 };
  const second = { inputTokens: 2300, outputTokens: 980, cacheCreationInputTokens: 0, cacheReadInputTokens: 7859 };

  it('podcast with 2 calls: the sum of the two per-call costs', () => {
    const c1 = (1100 * 0.1 + 1009 * 0.5 + 7859 * 0.125) / M;
    const c2 = (2300 * 0.1 + 980 * 0.5 + 7859 * 0.01) / M;
    expect(estimateCallCostUsd(MODEL, first)).toBeCloseTo(c1, 12);
    expect(estimateCallCostUsd(MODEL, second)).toBeCloseTo(c2, 12);
    expect(estimateDraftCostUsd(MODEL, [first, second])).toBeCloseTo(c1 + c2, 12);
    expect(c1 + c2).toBeCloseTo(0.002395465, 9);
  });

  it('one call: the same as estimateCallCostUsd', () => {
    expect(estimateDraftCostUsd(MODEL, [first])).toBe(estimateCallCostUsd(MODEL, first));
  });

  it('no calls cost nothing', () => {
    expect(estimateDraftCostUsd(MODEL, [])).toBe(0);
  });

  it('adding the tokens of two requests first would price them wrongly once the sum passes 100K (the bug this replaces)', () => {
    const call = { inputTokens: 60_000, outputTokens: 1000 }; // each request alone is well under 100K
    const perCall = (60_000 * 0.1 + 1000 * 0.5) / M;
    expect(estimateDraftCostUsd(MODEL, [call, call])).toBeCloseTo(2 * perCall, 12);

    const summed = estimateCallCostUsd(MODEL, { inputTokens: 120_000, outputTokens: 2000 }); // 120K > 100K → long rates
    expect(summed).toBeCloseTo((120_000 * 0.5 + 2000 * 2.5) / M, 12);
    expect(summed!).toBeGreaterThan(4 * estimateDraftCostUsd(MODEL, [call, call])!);
  });

  it('a request over the threshold alone is priced at the long rates', () => {
    expect(estimateDraftCostUsd(MODEL, [{ inputTokens: 150_000, outputTokens: 1000 }])).toBeCloseTo((150_000 * 0.5 + 1000 * 2.5) / M, 12);
  });

  it('null when the model is unknown', () => {
    expect(estimateDraftCostUsd('some-other-model', [first, second])).toBeNull();
  });
});

describe('describeDraftCost', () => {
  const usage = { inputTokens: 3400, outputTokens: 1989, cacheCreationInputTokens: 7859, cacheReadInputTokens: 7859 };

  it('uses the per-request usage when the result has it', () => {
    const callUsage = [
      { inputTokens: 1100, outputTokens: 1009, cacheCreationInputTokens: 7859, cacheReadInputTokens: 0 },
      { inputTokens: 2300, outputTokens: 980, cacheCreationInputTokens: 0, cacheReadInputTokens: 7859 },
    ];
    const d = describeDraftCost(MODEL, { usage, callUsage });
    expect(d.perCall).toHaveLength(2);
    expect(d.total).toBeCloseTo(d.perCall[0]! + d.perCall[1]!, 12);
  });

  it('a result built without per-request usage is priced as one request', () => {
    const d = describeDraftCost(MODEL, { usage });
    expect(d.perCall).toHaveLength(1);
    expect(d.total).toBe(estimateCallCostUsd(MODEL, usage));
  });

  it('no model, no estimate', () => {
    expect(describeDraftCost(null, { usage })).toEqual({ total: null, perCall: [] });
  });
});

describe('generateDraft keeps the usage of every request', () => {
  const reply = (body: unknown, usage: HaikuResponse['usage']): HaikuResponse => ({ text: JSON.stringify(body), stopReason: 'end_turn', refusalCategory: null, usage, requestId: 'r', model: MODEL });
  const bad = makeDraft({ senses: [makeSense({ meanings_vi: ['ngân hàng (tổ chức)'] })] });

  it('two requests (a repair) → callUsage has two entries, in order, and they add up to usage', async () => {
    const u1 = { inputTokens: 1100, outputTokens: 1009, cacheCreationInputTokens: 7859, cacheReadInputTokens: 0 };
    const u2 = { inputTokens: 2300, outputTokens: 980, cacheCreationInputTokens: 0, cacheReadInputTokens: 7859 };
    const replies = [reply(bad, u1), reply(makeDraft(), u2)];
    let n = 0;
    const haiku: HaikuCaller = async () => replies[n++];
    const r = await generateDraft(makeBundle(), { haiku });
    expect(r.ok).toBe(true);
    expect(r.callUsage).toEqual([u1, u2]);
    expect(r.usage).toMatchObject({ inputTokens: 3400, outputTokens: 1989, cacheCreationInputTokens: 7859, cacheReadInputTokens: 7859, calls: 2 });
    expect(estimateDraftCostUsd(MODEL, r.callUsage!)).toBeCloseTo(0.002395465, 9);
  });

  it('a failed draft keeps them too', async () => {
    const u = { inputTokens: 500, outputTokens: 400, cacheCreationInputTokens: 0, cacheReadInputTokens: 7859 };
    const haiku: HaikuCaller = async () => reply(bad, u);
    const r = await generateDraft(makeBundle(), { haiku });
    expect(r.ok).toBe(false);
    expect(r.callUsage).toEqual([u, u]);
  });

  it('one request → one entry', async () => {
    const u = { inputTokens: 500, outputTokens: 400, cacheCreationInputTokens: 0, cacheReadInputTokens: 7859 };
    const haiku: HaikuCaller = async () => reply(makeDraft(), u);
    const r = await generateDraft(makeBundle(), { haiku });
    expect(r.callUsage).toEqual([u]);
  });
});
