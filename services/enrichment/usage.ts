import { errMessage, logEvent } from '../queue/log';
import { ApiUsage, currentPeriod, type UsageDb } from '../upstream/apiUsage';
import type { HaikuCaller } from './haiku/client';

/**
 * Token usage of the enrichment job → api_usage_counters (spec §9.3, §11): provider 'anthropic', units input_tokens and
 * output_tokens, period YYYY-MM in UTC. (The lookup fast path books its own calls under 'anthropic_fast'.)
 *
 * input_tokens counts every prompt token the call was billed for: fresh input + cache writes + cache reads. The system prompt
 * (about 7.9K tokens) is nearly always a cache read, so counting only the fresh input would hide most of the volume.
 */
export const ANTHROPIC_USAGE_PROVIDER = 'anthropic';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const promptTokens = (u: TokenUsage): number => u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;

export async function recordHaikuUsage(db: UsageDb, usage: TokenUsage, now: Date = new Date()): Promise<void> {
  const ledger = new ApiUsage(db);
  const period = currentPeriod('month', now);
  await ledger.add(ANTHROPIC_USAGE_PROVIDER, 'input_tokens', period, promptTokens(usage));
  await ledger.add(ANTHROPIC_USAGE_PROVIDER, 'output_tokens', period, usage.outputTokens);
}

/**
 * Books the tokens of every answered Haiku request right after it comes back, so a later failure of the same job (database, a
 * second call) never loses what was already spent. A failure to book is logged and ignored: it must not fail the job.
 */
export function withUsageRecording(haiku: HaikuCaller, db: UsageDb): HaikuCaller {
  return async (request) => {
    const response = await haiku(request);
    try {
      await recordHaikuUsage(db, response.usage);
    } catch (err) {
      logEvent('warn', 'usage_record_failed', { provider: ANTHROPIC_USAGE_PROVIDER, error: errMessage(err) });
    }
    return response;
  };
}
