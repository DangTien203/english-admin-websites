import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicEnrichClient,
  AnthropicEnrichConfig,
  classifyAnthropicError,
  CreateMessageFn,
} from '../../services/upstream/anthropicEnrichClient';
import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';

const CONFIG: AnthropicEnrichConfig = { apiKey: 'sk-ant-test', model: 'model-from-config', maxOutputTokens: 4000, timeoutMs: 60_000 };

function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'model-from-config',
    content: [{ type: 'text', text: '{"a":', citations: null } as any, { type: 'text', text: '1}', citations: null } as any],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 45, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } as any,
    ...overrides,
  } as Anthropic.Message;
}

function apiError(status: number, body: object, headers: Record<string, string> = {}) {
  return Anthropic.APIError.generate(status, body, undefined, new Headers({ 'request-id': 'req_123', ...headers }));
}

function setup(create: CreateMessageFn, config: Partial<AnthropicEnrichConfig> = {}, threshold = 5) {
  const breaker = new CircuitBreaker('anthropic', { failureThreshold: threshold, resetMs: 30_000 });
  return { client: new AnthropicEnrichClient({ ...CONFIG, ...config }, { breaker, createMessage: create }), breaker };
}

const PARAMS = { system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('AnthropicEnrichClient.call', () => {
  it('uses model, max_tokens and timeout from configuration and returns usage + request id', async () => {
    const create = jest.fn<ReturnType<CreateMessageFn>, Parameters<CreateMessageFn>>(async () => ({ data: message(), request_id: 'req_abc' }));
    const { client } = setup(create);

    const result = await client.call(PARAMS);

    const [params, opts] = create.mock.calls[0];
    expect(params.model).toBe('model-from-config');
    expect(params.max_tokens).toBe(4000);
    expect(opts.timeout).toBe(60_000);
    expect(result.text).toBe('{"a":1}');
    expect(result.stopReason).toBe('end_turn');
    expect(result.requestId).toBe('req_abc');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 45, cacheCreationInputTokens: 10, cacheReadInputTokens: 5 });
  });

  it('lets the caller override model and max_tokens, and passes output_config through untouched', async () => {
    const create = jest.fn<ReturnType<CreateMessageFn>, Parameters<CreateMessageFn>>(async () => ({ data: message() }));
    const { client } = setup(create);
    const output_config = { format: { type: 'json_schema' as const, schema: { type: 'object' } } };
    await client.call({ ...PARAMS, model: 'other', max_tokens: 99, output_config });
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'other', max_tokens: 99, output_config });
  });

  it('reports a null request id and zero cache tokens when the API omits them', async () => {
    const { client } = setup(async () => ({ data: message({ usage: { input_tokens: 1, output_tokens: 2 } as any }) }));
    const r = await client.call(PARAMS);
    expect(r.requestId).toBeNull();
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
  });

  it('surfaces max_tokens / refusal as a stopReason for the caller to judge', async () => {
    const { client } = setup(async () => ({ data: message({ stop_reason: 'max_tokens' }) }));
    await expect(client.call(PARAMS)).resolves.toMatchObject({ stopReason: 'max_tokens' });
  });

  it('throws UpstreamConfigError without calling the network when the key is empty', async () => {
    const create = jest.fn<ReturnType<CreateMessageFn>, Parameters<CreateMessageFn>>();
    const { client } = setup(create, { apiKey: '' });
    expect(client.enabled).toBe(false);
    await expect(client.call(PARAMS)).rejects.toBeInstanceOf(UpstreamConfigError);
    expect(create).not.toHaveBeenCalled();
  });

  it('never retries by itself (pg-boss owns retries)', async () => {
    const create = jest.fn<ReturnType<CreateMessageFn>, Parameters<CreateMessageFn>>(async () => {
      throw apiError(500, { type: 'error', error: { type: 'api_error', message: 'boom' } });
    });
    const { client } = setup(create);
    await expect(client.call(PARAMS)).rejects.toMatchObject({ reason: 'http_5xx' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('the circuit opens after repeated 5xx and stops calling the API', async () => {
    const create = jest.fn<ReturnType<CreateMessageFn>, Parameters<CreateMessageFn>>(async () => {
      throw apiError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    });
    const { client, breaker } = setup(create, {}, 2);
    await client.call(PARAMS).catch(() => undefined);
    await client.call(PARAMS).catch(() => undefined);
    expect(breaker.currentState()).toBe('open');
    await expect(client.call(PARAMS)).rejects.toMatchObject({ reason: 'breaker_open' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('a spent budget does not count towards opening the circuit', async () => {
    const create: CreateMessageFn = async () => {
      throw apiError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'limit', details: { error_code: 'enforced_spend_limit_reached' } } });
    };
    const { client, breaker } = setup(create, {}, 1);
    for (let i = 0; i < 3; i++) await expect(client.call(PARAMS)).rejects.toBeInstanceOf(BudgetExceeded);
    expect(breaker.currentState()).toBe('closed');
  });
});

describe('classifyAnthropicError (spec §11.3 / §11.4)', () => {
  it('429 with retry-after → rate_limited carrying the delay', () => {
    const e: any = classifyAnthropicError(apiError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }, { 'retry-after': '17' }));
    expect(e).toBeInstanceOf(UpstreamUnavailable);
    expect(e).toMatchObject({ reason: 'rate_limited', status: 429, retryAfterMs: 17_000 });
    expect(e.message).toContain('req_123');
  });

  it('429 without retry-after → rate_limited with no delay', () => {
    const e: any = classifyAnthropicError(apiError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }));
    expect(e).toMatchObject({ reason: 'rate_limited' });
    expect(e.retryAfterMs).toBeUndefined();
  });

  it('429 with error.details.error_code = enforced_spend_limit_reached → BudgetExceeded', () => {
    const e = classifyAnthropicError(
      apiError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x', details: { error_code: 'enforced_spend_limit_reached' } } })
    );
    expect(e).toBeInstanceOf(BudgetExceeded);
    expect(e).toMatchObject({ reason: 'spend_limit', provider: 'anthropic' });
  });

  it('HTTP 400 "You have reached your specified API usage limits…" → BudgetExceeded', () => {
    const e = classifyAnthropicError(
      apiError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' } })
    );
    expect(e).toBeInstanceOf(BudgetExceeded);
  });

  it('any other 400 / 401 / 403 / 404 → UpstreamConfigError', () => {
    for (const status of [400, 401, 403, 404]) {
      const e = classifyAnthropicError(apiError(status, { type: 'error', error: { type: 'x', message: 'nope' } }));
      expect(e).toBeInstanceOf(UpstreamConfigError);
      expect(e).toMatchObject({ status });
    }
  });

  it('5xx and 529 (overloaded) → http_5xx', () => {
    for (const status of [500, 503, 529]) {
      expect(classifyAnthropicError(apiError(status, { type: 'error', error: { type: 'x', message: 'x' } }))).toMatchObject({ reason: 'http_5xx', status });
    }
  });

  it('timeouts and connection errors → timeout / network', () => {
    expect(classifyAnthropicError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ reason: 'timeout' });
    expect(classifyAnthropicError(new Anthropic.APIConnectionError({ message: 'down' }))).toMatchObject({ reason: 'network' });
  });

  it('a caller-initiated abort and unknown errors pass through unchanged', () => {
    const abort = new Anthropic.APIUserAbortError();
    expect(classifyAnthropicError(abort)).toBe(abort);
    const bug = new TypeError('bug');
    expect(classifyAnthropicError(bug)).toBe(bug);
  });
});
