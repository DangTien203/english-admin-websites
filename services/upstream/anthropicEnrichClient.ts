import Anthropic from '@anthropic-ai/sdk';
import { CircuitBreaker } from './circuitBreaker';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from './errors';
import { parseRetryAfter } from './http';

/**
 * Thin Anthropic client for the background enrichment job — docs/lookup-spec.md §9.1–9.3, §11.4.
 *
 * Scope of this file (P2): SDK construction, timeout, error classification, usage + request id.
 * It knows NOTHING about the content schema or prompts (P6 adds them) and it NEVER retries on its
 * own (SDK maxRetries is 0): pg-boss owns retries, so a retry is one job attempt with its own
 * accounting.
 */

export const ANTHROPIC_PROVIDER = 'anthropic' as const;

export interface AnthropicEnrichConfig {
  /** Empty = the client throws UpstreamConfigError without calling the network. */
  apiKey?: string;
  /** Default model (ANTHROPIC_MODEL_ENRICH). Never hard-code a model name in code. */
  model: string;
  /** Default max_tokens (ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH). */
  maxOutputTokens: number;
  /** Per-call timeout (ANTHROPIC_TIMEOUT_MS_ENRICH). */
  timeoutMs: number;
}

export type EnrichCallParams = Omit<Anthropic.MessageCreateParamsNonStreaming, 'model' | 'max_tokens' | 'stream'> & {
  model?: string;
  max_tokens?: number;
};

export interface EnrichUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface EnrichCallResult {
  message: Anthropic.Message;
  /** All text blocks joined. With output_config.format this is the JSON document (parsed by P6). */
  text: string;
  /** end_turn, max_tokens, refusal, … The caller decides what is an error (spec §9.3: max_tokens and refusal are). */
  stopReason: string | null;
  usage: EnrichUsage;
  /** Anthropic request id, for support tickets and logs. */
  requestId: string | null;
  model: string;
}

export interface CreateMessageResult {
  data: Anthropic.Message;
  request_id?: string | null;
}

export type CreateMessageFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts: { timeout: number; signal?: AbortSignal }
) => Promise<CreateMessageResult>;

export interface AnthropicEnrichDeps {
  breaker: CircuitBreaker;
  /** Test seam. Defaults to the real SDK (maxRetries 0). */
  createMessage?: CreateMessageFn;
}

export class AnthropicEnrichClient {
  private sdk?: Anthropic;

  constructor(
    private readonly config: AnthropicEnrichConfig,
    private readonly deps: AnthropicEnrichDeps
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.apiKey);
  }

  async call(params: EnrichCallParams, opts: { signal?: AbortSignal } = {}): Promise<EnrichCallResult> {
    if (!this.config.apiKey) {
      throw new UpstreamConfigError(ANTHROPIC_PROVIDER, 'ANTHROPIC_API_KEY is empty');
    }

    const request: Anthropic.MessageCreateParamsNonStreaming = {
      ...params,
      model: params.model ?? this.config.model,
      max_tokens: params.max_tokens ?? this.config.maxOutputTokens,
    };
    const create = this.deps.createMessage ?? this.defaultCreate();

    return this.deps.breaker.exec(async () => {
      try {
        const { data, request_id } = await create(request, { timeout: this.config.timeoutMs, signal: opts.signal });
        return toResult(data, request_id ?? null);
      } catch (err) {
        throw classifyAnthropicError(err);
      }
    });
  }

  private defaultCreate(): CreateMessageFn {
    return async (params, opts) => {
      if (!this.sdk) {
        // maxRetries: 0 → the SDK never retries behind our back.
        this.sdk = new Anthropic({ apiKey: this.config.apiKey, maxRetries: 0, timeout: this.config.timeoutMs });
      }
      const { data, request_id } = await this.sdk.messages.create(params, { timeout: opts.timeout, signal: opts.signal }).withResponse();
      return { data, request_id };
    };
  }
}

function toResult(message: Anthropic.Message, requestId: string | null): EnrichCallResult {
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const u: any = message.usage ?? {};
  return {
    message,
    text,
    stopReason: message.stop_reason ?? null,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    },
    requestId,
    model: message.model,
  };
}

const USAGE_LIMIT_PREFIX = 'you have reached your specified api usage limits';

const OUTPUT_CONFIG_REJECTED = /output_config|output_format|structured output|json_schema/i;

/** True when an API error message says the model refuses output_config / a JSON schema (docs/lookup-spec.md §9.2 fallback). */
export const isOutputConfigRejection = (message: string): boolean => OUTPUT_CONFIG_REJECTED.test(message);

/** Maps SDK errors to the shared taxonomy (spec §11.3 / §11.4). Anything unknown is returned unchanged. */
export function classifyAnthropicError(err: unknown): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return err; // caller cancelled: not an upstream problem
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new UpstreamUnavailable(ANTHROPIC_PROVIDER, 'timeout', { message: 'request timed out', cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new UpstreamUnavailable(ANTHROPIC_PROVIDER, 'network', { message: 'connection error', cause: err });
  }
  if (!(err instanceof Anthropic.APIError)) return err;

  const status = err.status;
  const body: any = err.error;
  const apiMessage: string = String(body?.error?.message ?? body?.message ?? err.message ?? '');
  const errorCode: unknown = body?.error?.details?.error_code ?? body?.details?.error_code;
  const retryAfterMs = parseRetryAfter(err.headers?.get?.('retry-after'));
  const requestSuffix = err.requestID ? ` (request ${err.requestID})` : '';

  // Spend limit reached → never retry (spec §11.4). Two shapes are documented.
  if (errorCode === 'enforced_spend_limit_reached' || apiMessage.toLowerCase().startsWith(USAGE_LIMIT_PREFIX)) {
    return new BudgetExceeded(ANTHROPIC_PROVIDER, 'spend_limit', { status, retryAfterMs, message: `API spend limit reached${requestSuffix}` });
  }
  if (status === 429) {
    return new UpstreamUnavailable(ANTHROPIC_PROVIDER, 'rate_limited', { status, retryAfterMs, message: `HTTP 429${requestSuffix}` });
  }
  if (status === 408) {
    return new UpstreamUnavailable(ANTHROPIC_PROVIDER, 'timeout', { status, message: `HTTP 408${requestSuffix}` });
  }
  if (typeof status === 'number' && status >= 500) {
    // includes 529 "overloaded"
    return new UpstreamUnavailable(ANTHROPIC_PROVIDER, 'http_5xx', { status, retryAfterMs, message: `HTTP ${status}${requestSuffix}` });
  }
  if (typeof status === 'number' && status >= 400) {
    // 400 / 401 / 403 / 404 (unknown model) / 413 / 422: fix the request or the configuration.
    // A 400 that only says "this model does not take output_config / a JSON schema" is about the shape of ONE request,
    // and the enrichment caller answers it with a forced-tool retry: it must not open the breaker that retry goes through.
    const requestShapeOnly = status === 400 && isOutputConfigRejection(apiMessage);
    return new UpstreamConfigError(ANTHROPIC_PROVIDER, `HTTP ${status}: ${apiMessage.slice(0, 200)}${requestSuffix}`, status, { affectsBreaker: !requestShapeOnly });
  }
  return err;
}
