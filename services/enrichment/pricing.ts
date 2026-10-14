/**
 * Hand-maintained price list used ONLY to ESTIMATE the cost of an enrichment draft (CLI output, logs).
 * It is not billing data: the invoice is the source of truth.
 *
 * VERIFY BEFORE RELYING ON IT. Prices change and this table does not update itself.
 *   Last checked: 2026-10-14 against https://platform.claude.com/docs/en/about-claude/pricing
 *   (Claude Haiku 5.5: $0.10 input / $0.50 output per MTok for prompts up to 100K tokens;
 *    $0.50 / $2.50 above; 5-minute cache write $0.125, cache read $0.01).
 */
export interface ModelPrice {
  /** USD per million tokens, for prompts up to `longPromptThreshold` tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheReadPerMTok: number;
  /** Prompts longer than this pay the "long" rates. */
  longPromptThreshold?: number;
  long?: { inputPerMTok: number; outputPerMTok: number; cacheWrite5mPerMTok: number; cacheReadPerMTok: number };
}

export const PRICING_CHECKED_ON = '2026-10-14';

/** Keyed by model id. Unknown models get no estimate (never a guess). */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheWrite5mPerMTok: 0.125,
    cacheReadPerMTok: 0.01,
    longPromptThreshold: 100_000,
    long: { inputPerMTok: 0.5, outputPerMTok: 2.5, cacheWrite5mPerMTok: 0.625, cacheReadPerMTok: 0.05 },
  },
};

export interface UsageForPricing {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Estimated USD for ONE API call. Returns null when the model is not in the table.
 * `input_tokens` from the API excludes cached tokens; the prompt length for the long-prompt rate
 * counts them too (cache reads and writes included), as the pricing page says.
 */
export function estimateCallCostUsd(model: string, usage: UsageForPricing): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  const write = usage.cacheCreationInputTokens ?? 0;
  const read = usage.cacheReadInputTokens ?? 0;
  const promptTokens = usage.inputTokens + write + read;
  const rates = price.long && price.longPromptThreshold !== undefined && promptTokens > price.longPromptThreshold ? price.long : price;
  return (
    (usage.inputTokens * rates.inputPerMTok + usage.outputTokens * rates.outputPerMTok + write * rates.cacheWrite5mPerMTok + read * rates.cacheReadPerMTok) /
    1_000_000
  );
}
