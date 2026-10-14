import type Anthropic from '@anthropic-ai/sdk';
import type { EnrichUsage } from '../upstream/anthropicEnrichClient';
import type { HaikuCaller } from './haiku/client';
import { DraftSchema, type Draft } from './haiku/schema';
import { buildUserMessage } from './haiku/user-message';
import { validateDraft, zodIssuesToValidation, type ValidationIssue } from './haiku/validators';
import type { SourceBundle } from './types';

/**
 * S3 + S4: ask Claude Haiku for the entry draft and check what comes back (docs/lookup-spec.md §8, §9.7).
 *
 * One request; if the answer is unusable (JSON that does not parse, schema violation, a failed validator rule, or
 * a reply cut off by max_tokens) ONE repair request follows with the conversation so far plus the list of errors
 * with their paths. Still unusable → { ok: false, reason: 'invalid_output' }, no third attempt. A refusal is final
 * at once.
 *
 * Infrastructure failures (UpstreamUnavailable, UpstreamConfigError, BudgetExceeded) are NOT caught here: they
 * propagate to the queue worker, which retries or closes the job (services/queue/enrichmentWorker.ts).
 */

export interface DraftUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Haiku requests made for this draft (1, or 2 after a repair). */
  calls: number;
}

export const emptyUsage = (): DraftUsage => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, calls: 0 });

export function addUsage(total: DraftUsage, u: EnrichUsage): void {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheCreationInputTokens += u.cacheCreationInputTokens;
  total.cacheReadInputTokens += u.cacheReadInputTokens;
  total.calls += 1;
}

export interface DraftSuccess {
  ok: true;
  draft: Draft;
  usage: DraftUsage;
  /** true when the first answer was invalid and the second one was accepted */
  repaired: boolean;
  /** Problems of the first answer (empty unless repaired). */
  firstIssues: ValidationIssue[];
  model: string;
  requestIds: string[];
  /** Milliseconds per Haiku request. */
  callMs: number[];
}

export interface DraftFailure {
  ok: false;
  reason: 'invalid_output';
  /** Problems of the LAST answer. */
  details: ValidationIssue[];
  firstIssues: ValidationIssue[];
  usage: DraftUsage;
  model: string | null;
  requestIds: string[];
  callMs: number[];
}

export type DraftResult = DraftSuccess | DraftFailure;

interface Evaluated {
  issues: ValidationIssue[];
  draft?: Draft;
  /** The reply was cut off: the repair must ask for a shorter answer. */
  truncated?: boolean;
  refused?: boolean;
}

function evaluate(text: string, stopReason: string | null, refusalCategory: string | null, bundle: SourceBundle): Evaluated {
  if (stopReason === 'refusal') {
    return { refused: true, issues: [{ path: '$', code: 'refusal', message: `the model declined the request${refusalCategory ? ` (${refusalCategory})` : ''}` }] };
  }
  if (stopReason === 'max_tokens') {
    return { truncated: true, issues: [{ path: '$', code: 'max_tokens', message: 'the reply was cut off at the output token limit' }] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { issues: [{ path: '$', code: 'json', message: `the reply is not valid JSON (${String((err as Error).message).slice(0, 80)})` }] };
  }

  const shape = DraftSchema.safeParse(parsed);
  if (!shape.success) return { issues: zodIssuesToValidation(shape.error) };

  const { issues, draft } = validateDraft(shape.data, { word: bundle.word, expectedLemma: bundle.expectedLemma });
  return { issues, draft };
}

export function buildRepairMessage(issues: ValidationIssue[], truncated: boolean): string {
  if (truncated) {
    return 'Bản trước bị cắt cụt vì quá dài. Hãy trả lại TOÀN BỘ đối tượng JSON, gọn hơn: mỗi sense chỉ 1 ví dụ, bỏ idioms, phrasal_verbs và collocations nếu cần, vẫn đủ 2 đến 4 nghĩa ngắn cho mỗi sense.';
  }
  const list = issues
    .slice(0, 30)
    .map((i) => `- ${i.path}: ${i.message}`)
    .join('\n');
  return `Bản trước có lỗi:\n${list}\n\nHãy trả lại TOÀN BỘ đối tượng JSON đã sửa (không chỉ phần lỗi), đúng schema, giữ nguyên những phần đã đúng.`;
}

export async function generateDraft(bundle: SourceBundle, deps: { haiku: HaikuCaller; signal?: AbortSignal }): Promise<DraftResult> {
  const usage = emptyUsage();
  const requestIds: string[] = [];
  const callMs: number[] = [];
  let model: string | null = null;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: buildUserMessage(bundle) }];

  const attempt = async () => {
    const t = Date.now();
    const response = await deps.haiku({ messages, signal: deps.signal });
    callMs.push(Date.now() - t);
    addUsage(usage, response.usage);
    if (response.requestId) requestIds.push(response.requestId);
    model = response.model;
    return { response, evaluated: evaluate(response.text, response.stopReason, response.refusalCategory, bundle) };
  };

  const first = await attempt();
  if (first.evaluated.issues.length === 0) {
    return { ok: true, draft: first.evaluated.draft!, usage, repaired: false, firstIssues: [], model: model!, requestIds, callMs };
  }
  if (first.evaluated.refused) {
    return { ok: false, reason: 'invalid_output', details: first.evaluated.issues, firstIssues: first.evaluated.issues, usage, model, requestIds, callMs };
  }

  // One repair: the conversation so far, the previous JSON, the list of errors.
  if (first.response.text.trim()) messages.push({ role: 'assistant', content: first.response.text });
  messages.push({ role: 'user', content: buildRepairMessage(first.evaluated.issues, Boolean(first.evaluated.truncated)) });

  const second = await attempt();
  if (second.evaluated.issues.length === 0) {
    return { ok: true, draft: second.evaluated.draft!, usage, repaired: true, firstIssues: first.evaluated.issues, model: model!, requestIds, callMs };
  }
  return { ok: false, reason: 'invalid_output', details: second.evaluated.issues, firstIssues: first.evaluated.issues, usage, model, requestIds, callMs };
}
