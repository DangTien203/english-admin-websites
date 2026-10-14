import { buildRepairMessage, generateDraft, type DraftFailure, type DraftResult } from '../../services/enrichment/draft';
import { createHaikuCaller, FALLBACK_TOOL_NAME, type HaikuCaller, type HaikuResponse } from '../../services/enrichment/haiku/client';
import { DRAFT_JSON_SCHEMA } from '../../services/enrichment/haiku/schema';
import { SYSTEM_PROMPT } from '../../services/enrichment/haiku/system-prompt';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';
import { makeBundle, makeDraft, makeSense } from './fixtures';

const usage = (inputTokens: number, outputTokens: number, cacheCreationInputTokens = 0, cacheReadInputTokens = 0) => ({ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens });

function reply(body: unknown, over: Partial<HaikuResponse> = {}): HaikuResponse {
  return {
    text: typeof body === 'string' ? body : JSON.stringify(body),
    stopReason: 'end_turn',
    refusalCategory: null,
    usage: usage(1000, 500),
    requestId: 'req_1',
    model: 'test-model',
    ...over,
  };
}

// strictNullChecks is off in this project, so `if (r.ok)` does not narrow the union: assert the failure explicitly.
function asFailure(r: DraftResult): DraftFailure {
  if (r.ok) throw new Error('expected a failed draft');
  return r as DraftFailure;
}

const good = () => makeDraft();
const badMeaning = () => makeDraft({ senses: [makeSense({ meanings_vi: ['ngân hàng (tổ chức)'] })] });

/** A HaikuCaller that returns the given replies in order and records the requests. */
function sequence(...replies: Array<HaikuResponse | Error>) {
  const requests: Array<Parameters<HaikuCaller>[0]> = [];
  const caller: HaikuCaller = async (req) => {
    requests.push({ messages: JSON.parse(JSON.stringify(req.messages)) });
    const next = replies[requests.length - 1];
    if (!next) throw new Error('no more replies');
    if (next instanceof Error) throw next;
    return next;
  };
  return { caller, requests };
}

describe('generateDraft', () => {
  it('success on the first answer: one call, not repaired', async () => {
    const { caller, requests } = sequence(reply(good()));
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(false);
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, calls: 1 });
    expect(r.model).toBe('test-model');
    expect(r.draft.headword).toBe('bank');
    expect(requests).toHaveLength(1);
  });

  it('sends the sources in one <data> block as the only user message', async () => {
    const { caller, requests } = sequence(reply(good()));
    await generateDraft(makeBundle(), { haiku: caller });
    expect(requests[0].messages).toHaveLength(1);
    expect(requests[0].messages[0].role).toBe('user');
    expect(String(requests[0].messages[0].content)).toMatch(/^<data>\n\{.*"word":"bank".*\}\n<\/data>/s);
  });

  it('a wrong answer followed by a correct one is repaired: the repair quotes the error paths and the previous JSON', async () => {
    const { caller, requests } = sequence(reply(badMeaning(), { usage: usage(1000, 500, 1200, 0) }), reply(good(), { usage: usage(300, 450, 0, 1200) }));
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(true);
    expect(r.firstIssues.map((i) => i.path)).toEqual(['senses[0].meanings_vi[0]']);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(requests[1].messages[1].content).toBe(JSON.stringify(badMeaning()));
    const repair = String(requests[1].messages[2].content);
    expect(repair).toContain('senses[0].meanings_vi[0]');
    expect(repair).toContain('TOÀN BỘ');
  });

  it('adds up the usage of both calls, cache fields included', async () => {
    const { caller } = sequence(reply(badMeaning(), { usage: usage(1000, 500, 1200, 0) }), reply(good(), { usage: usage(300, 450, 0, 1200) }));
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.usage).toEqual({ inputTokens: 1300, outputTokens: 950, cacheCreationInputTokens: 1200, cacheReadInputTokens: 1200, calls: 2 });
  });

  it('still wrong after the repair → invalid_output with the details of the LAST answer, and no third call', async () => {
    const { caller, requests } = sequence(reply(badMeaning()), reply(badMeaning()), reply(good()));
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.ok).toBe(false);
    const f = asFailure(r);
    expect(f.reason).toBe('invalid_output');
    expect(f.details.map((d) => d.path)).toEqual(['senses[0].meanings_vi[0]']);
    expect(r.usage.calls).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it('broken JSON is a problem to repair, then invalid_output', async () => {
    const { caller } = sequence(reply('{"is_english_word": tr'), reply('not json at all'));
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.ok).toBe(false);
    const f = asFailure(r);
    expect(f.details[0]).toMatchObject({ path: '$', code: 'json' });
  });

  it('broken JSON first, valid JSON second → repaired', async () => {
    const { caller, requests } = sequence(reply('{"oops'), reply(good()));
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.ok && r.repaired).toBe(true);
    expect(String(requests[1].messages[2].content)).toContain('$: the reply is not valid JSON');
  });

  it('a schema violation (unknown key, wrong enum) is reported with its path', async () => {
    const wrong = { ...good(), senses: [{ ...makeSense(), register: 'vulgar' }] };
    const { caller } = sequence(reply(wrong), reply(wrong));
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.ok).toBe(false);
    const f = asFailure(r);
    expect(f.details.map((d) => d.path)).toContain('senses[0].register');
  });

  it('max_tokens: the repair asks for a shorter answer; the cut-off text is sent back as the assistant turn', async () => {
    const { caller, requests } = sequence(reply('{"is_english_word": true, "senses": [', { stopReason: 'max_tokens', usage: usage(1000, 4000) }), reply(good()));
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.ok && r.repaired).toBe(true);
    expect(String(requests[1].messages[2].content)).toMatch(/cắt cụt.*gọn hơn/s);
  });

  it('max_tokens twice → invalid_output', async () => {
    const cut = reply('{"x', { stopReason: 'max_tokens' });
    const { caller } = sequence(cut, cut);
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.ok).toBe(false);
    const f = asFailure(r);
    expect(f.details[0].code).toBe('max_tokens');
  });

  it('max_tokens with an EMPTY text does not send an empty assistant message', async () => {
    const { caller, requests } = sequence(reply('', { stopReason: 'max_tokens' }), reply(good()));
    await generateDraft(makeBundle(), { haiku: caller });
    expect(requests[1].messages.map((m) => m.role)).toEqual(['user', 'user']);
  });

  it('a refusal is final: invalid_output at once, no repair, and its category is reported', async () => {
    const { caller, requests } = sequence(reply('', { stopReason: 'refusal', refusalCategory: 'general_harms' }), reply(good()));
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.ok).toBe(false);
    const f = asFailure(r);
    expect(f.details[0]).toMatchObject({ code: 'refusal' });
    expect(f.details[0].message).toContain('general_harms');
    expect(requests).toHaveLength(1);
  });

  it('a cross-field rule uses the sources: the lemma must be the one Wiktionary names', async () => {
    const bundle = makeBundle({ word: 'ran', expectedLemma: 'run' });
    const wrongLemma = makeDraft({ headword: 'ran', lemma: 'ran' });
    const rightLemma = makeDraft({ headword: 'run', lemma: 'run' });
    const { caller } = sequence(reply(wrongLemma), reply(rightLemma));
    const r = await generateDraft(bundle, { haiku: caller });
    expect(r.ok && r.repaired).toBe(true);
    expect(r.ok && r.draft.lemma).toBe('run');
  });

  it('a draft that comes back cleaned (unknown topic dropped) is returned cleaned', async () => {
    const { caller } = sequence(reply(makeDraft({ topics: ['IELTS', 'business_economy'] })));
    const r = await generateDraft(makeBundle(), { haiku: caller });
    expect(r.ok && r.draft.topics).toEqual(['business_economy']);
  });

  describe('infrastructure errors propagate (the queue worker decides)', () => {
    it.each([
      ['UpstreamUnavailable', new UpstreamUnavailable('anthropic', 'http_5xx', { status: 503 })],
      ['UpstreamConfigError', new UpstreamConfigError('anthropic', 'invalid x-api-key', 401)],
      ['BudgetExceeded', new BudgetExceeded('anthropic', 'spend_limit')],
    ])('%s on the first call', async (_n, error) => {
      const { caller } = sequence(error);
      await expect(generateDraft(makeBundle(), { haiku: caller })).rejects.toBe(error);
    });

    it('also when it happens on the repair call', async () => {
      const error = new BudgetExceeded('anthropic', 'spend_limit');
      const { caller } = sequence(reply(badMeaning()), error);
      await expect(generateDraft(makeBundle(), { haiku: caller })).rejects.toBe(error);
    });
  });
});

describe('buildRepairMessage', () => {
  it('lists the errors with their paths and asks for the complete JSON', () => {
    const m = buildRepairMessage([{ path: 'senses[2].meanings_vi[1]', code: 'duplicate', message: 'repeats meanings_vi[0]' }], false);
    expect(m).toContain('- senses[2].meanings_vi[1]: repeats meanings_vi[0]');
    expect(m).toContain('TOÀN BỘ');
  });

  it('caps the list at 30 errors', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ path: `p${i}`, code: 'x', message: 'm' }));
    expect(buildRepairMessage(many, false).split('\n').filter((l) => l.startsWith('- '))).toHaveLength(30);
  });
});

describe('createHaikuCaller (the request sent to the API)', () => {
  function fakeClient(result: Partial<Awaited<ReturnType<any>>> = {}, failFirst?: Error) {
    const call = jest.fn(async (params: any, _opts?: any) => {
      if (failFirst && call.mock.calls.length === 1) throw failFirst;
      return {
        message: { model: 'test-model', content: result.content ?? [], stop_details: result.stop_details },
        text: result.text ?? JSON.stringify(makeDraft()),
        stopReason: result.stopReason ?? 'end_turn',
        usage: usage(10, 20),
        requestId: 'req_x',
        model: 'test-model',
      };
    });
    return call;
  }

  it('sends json_schema output, thinking disabled, effort low, the cached static system prompt, and NO sampling parameter', async () => {
    const call = fakeClient();
    await createHaikuCaller({ call } as any)({ messages: [{ role: 'user', content: 'hi' }] });
    const params = call.mock.calls[0][0];
    expect(params.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: DRAFT_JSON_SCHEMA } });
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'model', 'max_tokens', 'tools', 'tool_choice']) expect(params).not.toHaveProperty(forbidden);
  });

  it('sends temperature only when asked for', async () => {
    const call = fakeClient();
    await createHaikuCaller({ call } as any, { temperature: 0.2 })({ messages: [{ role: 'user', content: 'hi' }] });
    expect(call.mock.calls[0][0].temperature).toBe(0.2);
  });

  it('returns text, stop reason, usage and request id; reads the refusal category', async () => {
    const call = fakeClient({ text: 'abc', stopReason: 'refusal', stop_details: { type: 'refusal', category: 'bio' } });
    const r = await createHaikuCaller({ call } as any)({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r).toMatchObject({ text: 'abc', stopReason: 'refusal', refusalCategory: 'bio', requestId: 'req_x', model: 'test-model', usage: usage(10, 20) });
  });

  it('falls back to a forced tool with the same schema when the model rejects output_config', async () => {
    const call = fakeClient(
      { content: [{ type: 'tool_use', name: FALLBACK_TOOL_NAME, input: { ok: true } }] },
      new UpstreamConfigError('anthropic', 'HTTP 400: output_config.format is not supported for this model', 400)
    );
    const r = await createHaikuCaller({ call } as any)({ messages: [{ role: 'user', content: 'hi' }] });
    expect(call).toHaveBeenCalledTimes(2);
    const second = call.mock.calls[1][0];
    expect(second.tool_choice).toEqual({ type: 'tool', name: FALLBACK_TOOL_NAME });
    expect(second.tools[0].input_schema).toBe(DRAFT_JSON_SCHEMA);
    expect(second.output_config.format).toBeUndefined();
    expect(r.text).toBe(JSON.stringify({ ok: true }));
  });

  it('does NOT fall back for other configuration errors (bad key) or other failures', async () => {
    const call = fakeClient({}, new UpstreamConfigError('anthropic', 'HTTP 401: invalid x-api-key', 401));
    await expect(createHaikuCaller({ call } as any)({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/invalid x-api-key/);
    expect(call).toHaveBeenCalledTimes(1);
    const call2 = fakeClient({}, new UpstreamUnavailable('anthropic', 'timeout'));
    await expect(createHaikuCaller({ call: call2 } as any)({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(call2).toHaveBeenCalledTimes(1);
  });
});
