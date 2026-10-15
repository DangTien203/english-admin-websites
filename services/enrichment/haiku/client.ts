import type Anthropic from '@anthropic-ai/sdk';
import { isOutputConfigRejection, type AnthropicEnrichClient, type EnrichUsage } from '../../upstream/anthropicEnrichClient';
import { UpstreamConfigError } from '../../upstream/errors';
import { DRAFT_JSON_SCHEMA } from './schema';
import { SYSTEM_PROMPT } from './system-prompt';

/**
 * Calls Claude Haiku for the enrichment draft (docs/lookup-spec.md §9.1–9.3).
 *
 * The model, max_tokens and timeout come from AnthropicEnrichClient (ANTHROPIC_MODEL_ENRICH,
 * ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH, ANTHROPIC_TIMEOUT_MS_ENRICH): no model name appears in this file.
 *
 * Request shape, verified against Claude Haiku 5.5 (docs/lookup-enrichment.md §4):
 *   - output_config.format = json_schema → the reply is one JSON document in the text block
 *   - thinking disabled + effort low: the whole max_tokens budget goes to the JSON, and the cost is predictable.
 *     (Adaptive thinking is on by default for this model and its tokens count toward max_tokens.)
 *   - no temperature / top_p / top_k: this model answers 400 to any value but the default.
 *   - the system prompt is one cache-controlled block (prompt caching)
 * If the model ever rejects output_config, the call is repeated ONCE with a forced tool whose input schema is the
 * same JSON Schema (spec §9.2 fallback); zod and the validators check the result either way.
 */

export const HAIKU_EFFORT = 'low' as const;
export const FALLBACK_TOOL_NAME = 'submit_entry';

export interface HaikuResponse {
  /** The JSON document as text (from the text block, or the serialized tool input in fallback mode). */
  text: string;
  stopReason: string | null;
  /** stop_details.category of a refusal, when present. */
  refusalCategory: string | null;
  usage: EnrichUsage;
  requestId: string | null;
  model: string;
}

export interface HaikuRequest {
  messages: Anthropic.MessageParam[];
  signal?: AbortSignal;
}

export type HaikuCaller = (request: HaikuRequest) => Promise<HaikuResponse>;

export interface HaikuCallerOptions {
  /** Sent only when set. Claude Haiku 5.5 rejects values other than its default (docs/lookup-enrichment.md §4). */
  temperature?: number;
}

export function createHaikuCaller(client: Pick<AnthropicEnrichClient, 'call'>, options: HaikuCallerOptions = {}): HaikuCaller {
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  const temperature = options.temperature !== undefined ? { temperature: options.temperature } : {};

  const toResponse = (r: Awaited<ReturnType<AnthropicEnrichClient['call']>>, text: string): HaikuResponse => ({
    text,
    stopReason: r.stopReason,
    refusalCategory: ((r.message as any)?.stop_details?.category as string | null | undefined) ?? null,
    usage: r.usage,
    requestId: r.requestId,
    model: r.model,
  });

  return async ({ messages, signal }) => {
    try {
      const r = await client.call(
        {
          system,
          messages,
          thinking: { type: 'disabled' },
          output_config: { effort: HAIKU_EFFORT, format: { type: 'json_schema', schema: DRAFT_JSON_SCHEMA } },
          ...temperature,
        },
        { signal }
      );
      return toResponse(r, r.text);
    } catch (err) {
      if (!(err instanceof UpstreamConfigError) || !isOutputConfigRejection(err.message)) throw err;
    }

    // Fallback: forced tool use with the same schema.
    const r = await client.call(
      {
        system,
        messages,
        thinking: { type: 'disabled' },
        output_config: { effort: HAIKU_EFFORT },
        tools: [{ name: FALLBACK_TOOL_NAME, description: 'Submit the dictionary entry draft.', input_schema: DRAFT_JSON_SCHEMA as Anthropic.Tool.InputSchema }],
        tool_choice: { type: 'tool', name: FALLBACK_TOOL_NAME },
        ...temperature,
      },
      { signal }
    );
    const block = r.message.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === FALLBACK_TOOL_NAME);
    return toResponse(r, block ? JSON.stringify(block.input) : '');
  };
}
