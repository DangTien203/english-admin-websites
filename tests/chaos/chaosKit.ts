/**
 * Shared pieces of the chaos tests that run the REAL queue code (pg-boss in its own schema, the real worker, the real
 * Anthropic client, circuit breaker and draft code) against a FAKE Anthropic SDK. Nothing leaves the machine.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { PgBoss } from 'pg-boss';
import pool from '../../config/db';
import { generateDraft } from '../../services/enrichment/draft';
import { createHaikuCaller } from '../../services/enrichment/haiku/client';
import { createPipeline, type PipelineDeps, type RunEnrichment } from '../../services/enrichment/pipeline';
import { createStartedBoss, type QueueSettings } from '../../services/queue/boss';
import { AnthropicEnrichClient, type CreateMessageFn } from '../../services/upstream/anthropicEnrichClient';
import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { makeBundle, makeDraft, wrow } from '../enrichment/fixtures';

export const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
export const word = (tag: string) => `qzq${RUN}${tag}`;

export function silence(): void {
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
}

export async function waitFor<T>(fn: () => Promise<T | false | null | undefined> | T | false | null | undefined, what: string, timeoutMs = 60_000, everyMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Queue settings for a throwaway schema: fast retries, short expiry. */
export const queueSettings = (tag: string, over: Partial<QueueSettings> = {}): QueueSettings => ({
  schema: `pgboss_test_${tag}_${RUN}`,
  poolMax: 4,
  retryLimit: 2,
  retryDelaySeconds: 1,
  retryDelayMaxSeconds: 2,
  expireSeconds: 60,
  ...over,
});

export const startBoss = (settings: QueueSettings): Promise<PgBoss> => createStartedBoss(settings, 'worker');

export async function dropSchema(schema: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

export async function cleanFixtures(): Promise<void> {
  await pool.query(`DELETE FROM word_enrichment_jobs WHERE word LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM api_usage_counters WHERE provider LIKE $1`, [`enrichment_%${RUN}%`]);
}

export const rowsOf = async (w: string) =>
  (await pool.query(`SELECT id, status, reason, attempts FROM word_enrichment_jobs WHERE word = $1 ORDER BY created_at`, [w])).rows as Array<{ id: string; status: string; reason: string | null; attempts: number }>;

// ── fake Anthropic SDK ───────────────────────────────────────────────────────

/** A real SDK error object (the right subclass, status, headers and body), as the SDK itself would throw it. */
export function sdkError(status: number, body: object, headers: Record<string, string> = {}): Error {
  return Anthropic.APIError.generate(status, body, undefined, new Headers({ 'request-id': 'req_chaos', ...headers })) as unknown as Error;
}

export const rateLimit429 = (retryAfterSeconds?: number) =>
  sdkError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }, retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) });
export const spendLimit429 = () =>
  sdkError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'limit', details: { error_code: 'enforced_spend_limit_reached' } } });
export const usageLimit400 = () =>
  sdkError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' } });
export const overloaded529 = () => sdkError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
export const unauthorized401 = () => sdkError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });

export function messageWith(draft: unknown): Anthropic.Message {
  return {
    id: 'msg_chaos',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text: JSON.stringify(draft), citations: null } as any],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 700, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 7800 } as any,
  } as Anthropic.Message;
}

/** One scripted step of the fake SDK: an error to throw, or a function to run (it may throw or return the message). */
export type SdkStep = Error | ((word: string, callNumber: number) => Promise<Anthropic.Message> | Anthropic.Message);

/**
 * The word the request is about, read back out of the <data> block of the user message.
 * (The fake needs it to return a draft whose lemma equals the word.)
 */
function wordOf(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const first: any = params.messages[0];
  const text = typeof first.content === 'string' ? first.content : first.content.map((b: any) => b.text ?? '').join('');
  const m = /"word":"([a-z]+)"/.exec(text);
  return m ? m[1] : 'unknown';
}

export interface FakeSdk {
  create: CreateMessageFn;
  calls: Array<{ word: string; at: number }>;
}

/**
 * Builds the SDK double. `script(word, n)` decides each call (n = how many calls this word has had, from 1); the default is a
 * valid draft. Every call is recorded with its time.
 */
export function fakeSdk(script: (word: string, n: number) => SdkStep | undefined = () => undefined): FakeSdk {
  const calls: FakeSdk['calls'] = [];
  const perWord = new Map<string, number>();
  const create: CreateMessageFn = async (params) => {
    const w = wordOf(params);
    const n = (perWord.get(w) ?? 0) + 1;
    perWord.set(w, n);
    calls.push({ word: w, at: Date.now() });
    const step = script(w, n);
    if (step instanceof Error) throw step;
    const message = typeof step === 'function' ? await step(w, n) : messageWith(makeDraft({ headword: w, lemma: w }));
    return { data: message, request_id: 'req_chaos' };
  };
  return { create, calls };
}

/**
 * The REAL pipeline logic (S0–S5 and the Haiku draft with its validation and repair) over:
 *   - the real AnthropicEnrichClient + CircuitBreaker + Haiku caller, with the fake SDK underneath,
 *   - fake sources (a Wiktionary row for the word) and a fake write (so no dictionary entry is created).
 */
export function pipelineOverFakeSdk(sdk: FakeSdk, opts: { breaker?: CircuitBreaker; failureThreshold?: number; resetMs?: number } = {}) {
  const breaker = opts.breaker ?? new CircuitBreaker('anthropic', { failureThreshold: opts.failureThreshold ?? 5, resetMs: opts.resetMs ?? 30_000 });
  const client = new AnthropicEnrichClient({ apiKey: 'sk-ant-test', model: 'test-model', maxOutputTokens: 4000, timeoutMs: 60_000 }, { breaker, createMessage: sdk.create });
  const haiku = createHaikuCaller(client);
  const deps: PipelineDeps = {
    ensureTopics: async () => new Map([['business_economy', 'tag-business']]),
    publishPolicy: () => 'review',
    findExisting: async () => null,
    collectSources: async (w) => makeBundle({ word: w, expectedLemma: w, wiktionaryRows: [wrow({ word: w, pos: 'noun', senses: [{ glosses: ['A thing.'], tags: ['countable'] }] })] }),
    generateDraft: (bundle, { signal }) => generateDraft(bundle, { haiku, signal }),
    persist: async () => ({ status: 'created', entryId: null, rows: {} }) as any,
    linkForm: async () => ({ linked: true }),
  };
  const run: RunEnrichment = createPipeline(deps);
  return { run, client, breaker };
}
