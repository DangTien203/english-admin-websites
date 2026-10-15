/**
 * Regression tests for the defects found in the P6a review and fixed in P6b:
 *   1. the forced-tool fallback never ran (the 400 had already opened the circuit breaker)
 *   2. (runtime) a worker without the 30 topic tags still took jobs and failed them for good  → tests/queue/runtime.test.ts
 *   3. a draft for a word that gets no entry passed validation with its content
 *   4. the "[kiểm tra]" notes of the validator were cut off when Haiku sent 10 or more notes
 *   5. a lemma with regex metacharacters ("c++") made the validator throw
 * plus the breaker rule for provider budgets and the wider Wiktionary window for words with many senses.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHaikuCaller, FALLBACK_TOOL_NAME } from '../../services/enrichment/haiku/client';
import { LIMITS } from '../../services/enrichment/haiku/schema';
import { buildDataObject, MANY_SENSES_THRESHOLD, PROMPT_SENSES_DEFAULT, PROMPT_SENSES_MANY } from '../../services/enrichment/haiku/user-message';
import { escapeRegExp, validateDraft } from '../../services/enrichment/haiku/validators';
import { AnthropicEnrichClient, type CreateMessageFn } from '../../services/upstream/anthropicEnrichClient';
import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';
import { makeBundle, makeDraft, makeSense, wrow } from './fixtures';

const ctx = (over: Partial<Parameters<typeof validateDraft>[1]> = {}) => ({ word: 'bank', expectedLemma: null, ...over });

describe('1. the forced-tool fallback works with the REAL client and circuit breaker', () => {
  const apiError = (status: number, message: string) =>
    Anthropic.APIError.generate(status, { type: 'error', error: { type: 'invalid_request_error', message } }, undefined, new Headers({ 'request-id': 'req_1' }));

  function setup(first: () => never) {
    const seen: Array<{ tools: boolean }> = [];
    const createMessage: CreateMessageFn = async (params) => {
      seen.push({ tools: Boolean((params as any).tools) });
      if (!(params as any).tools) first();
      return {
        data: {
          id: 'm', type: 'message', role: 'assistant', model: 'm', stop_reason: 'tool_use', stop_sequence: null,
          content: [{ type: 'tool_use', id: 't1', name: FALLBACK_TOOL_NAME, input: { is_english_word: true } }],
          usage: { input_tokens: 10, output_tokens: 20 },
        } as any,
        request_id: 'req_ok',
      };
    };
    const breaker = new CircuitBreaker('anthropic', { failureThreshold: 5, resetMs: 30_000 });
    const client = new AnthropicEnrichClient({ apiKey: 'k', model: 'm', maxOutputTokens: 100, timeoutMs: 1000 }, { breaker, createMessage });
    return { seen, breaker, caller: createHaikuCaller(client) };
  }

  it('output_config rejected → the second request (forced tool) really reaches the API, and the breaker stays closed', async () => {
    const { seen, breaker, caller } = setup(() => {
      throw apiError(400, 'output_config.format is not supported for this model');
    });
    const r = await caller({ messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toEqual([{ tools: false }, { tools: true }]);
    expect(r.text).toBe(JSON.stringify({ is_english_word: true }));
    expect(breaker.currentState()).toBe('closed');
  });

  it('any other 400 is a real configuration problem: no fallback, and the breaker opens', async () => {
    const { seen, breaker, caller } = setup(() => {
      throw apiError(400, 'max_tokens: must be greater than 0');
    });
    await expect(caller({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(UpstreamConfigError);
    expect(seen).toHaveLength(1);
    expect(breaker.currentState()).toBe('open');
  });
});

describe('breaker and budgets (spec §11.2, §11.4)', () => {
  it('a spend limit or provider quota opens the breaker at once; our own monthly counter does not', async () => {
    for (const [reason, expected] of [['spend_limit', 'open'], ['provider_quota', 'open'], ['monthly_chars', 'closed']] as const) {
      const breaker = new CircuitBreaker('anthropic', { failureThreshold: 5, resetMs: 30_000 });
      await breaker.exec(() => Promise.reject(new BudgetExceeded('anthropic', reason))).catch(() => undefined);
      expect(breaker.currentState()).toBe(expected);
    }
  });

  it('while it is open the next call is refused without reaching the provider (UpstreamUnavailable breaker_open → pg-boss retries later)', async () => {
    const breaker = new CircuitBreaker('anthropic', { failureThreshold: 5, resetMs: 30_000 });
    await breaker.exec(() => Promise.reject(new BudgetExceeded('anthropic', 'spend_limit'))).catch(() => undefined);
    const fn = jest.fn(async () => 'x');
    await expect(breaker.exec(fn)).rejects.toMatchObject({ reason: 'breaker_open' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('UpstreamConfigError flagged affectsBreaker=false is ignored, the default still trips', async () => {
    const quiet = new CircuitBreaker('anthropic', { failureThreshold: 5, resetMs: 30_000 });
    await quiet.exec(() => Promise.reject(new UpstreamConfigError('anthropic', 'shape', 400, { affectsBreaker: false }))).catch(() => undefined);
    expect(quiet.currentState()).toBe('closed');
    const loud = new CircuitBreaker('anthropic', { failureThreshold: 5, resetMs: 30_000 });
    await loud.exec(() => Promise.reject(new UpstreamConfigError('anthropic', 'key', 401))).catch(() => undefined);
    expect(loud.currentState()).toBe('open');
    expect(new UpstreamUnavailable('anthropic', 'timeout').affectsBreaker).toBe(true);
  });
});

describe('3. a word that gets no entry carries no content (spec §9.5)', () => {
  const withContent = (over: Parameters<typeof makeDraft>[0]) =>
    makeDraft({
      cefr_level: 'B2',
      topics: ['education_school'],
      is_countable: true,
      is_transitive: true,
      senses: [makeSense({ meanings_vi: ['中文', '(x)'] })],
      idioms: [{ idiom_text: 'a b', definition_en: 'd', definition_vi: 'đ', example_en: 'e', example_vi: 'v' }],
      ...over,
    });

  it.each([
    ['a proper noun', { is_proper_noun: true }],
    ['not English', { is_english_word: false }],
    ['a misspelling', { variant_of: 'receive' }],
  ])('%s: senses, pos, topics, phrases, cefr_level and the flags are emptied, not validated', (_name, over) => {
    const r = validateDraft(withContent(over as any), ctx({ word: 'london' }));
    expect(r.issues).toEqual([]); // the CJK / parenthesis in the dropped senses do not cause a repair request
    expect(r.draft).toMatchObject({ senses: [], pos: [], topics: [], idioms: [], phrasal_verbs: [], collocations: [], cefr_level: null, is_countable: null, is_transitive: null });
    expect(r.draft.notes_for_review.join(' ')).toContain('bỏ nội dung của từ không lập mục');
  });

  it('an already empty draft gets no such note and keeps the model\'s own notes', () => {
    const r = validateDraft(
      makeDraft({ is_proper_noun: true, senses: [], pos: [], cefr_level: null, topics: [], is_countable: null, notes_for_review: ['London là tên riêng.'] }),
      ctx({ word: 'london' })
    );
    expect(r.draft.notes_for_review).toEqual(['London là tên riêng.']);
  });
});

describe('4. the validator\'s own notes survive a long list of notes from Haiku', () => {
  it('the model\'s notes are capped at 10, the "[kiểm tra]" lines are all kept', () => {
    const modelNotes = Array.from({ length: 12 }, (_, i) => `ghi chú ${i}`);
    const r = validateDraft(makeDraft({ notes_for_review: modelNotes, topics: ['bogus_a', 'bogus_b', 'education_school'] }), ctx());
    const audit = r.draft.notes_for_review.filter((n) => n.startsWith('[kiểm tra]'));
    expect(audit).toHaveLength(2);
    expect(r.draft.notes_for_review.filter((n) => !n.startsWith('[kiểm tra]'))).toHaveLength(LIMITS.notes);
  });
});

describe('5. a lemma with regex metacharacters does not make the validator throw', () => {
  it.each(['c++', 'foo(', '[x', 'a.b', 'what?', 'a|b', '$1', 'back\\slash', '*'])('lemma %j gives an issue, not an exception', (lemma) => {
    const draft = makeDraft({ headword: lemma, lemma, senses: [makeSense({ definition_en: `a thing like ${lemma}` })] });
    expect(() => validateDraft(draft, ctx())).not.toThrow();
    expect(validateDraft(draft, ctx()).issues.map((i) => i.code)).toContain('format');
  });

  it('escapeRegExp makes every metacharacter literal', () => {
    for (const s of ['c++', 'a.b', '(x)', '[a-z]', 'a|b', '^$', 'a\\b', "don't", 'well-being']) expect(new RegExp(`^${escapeRegExp(s)}$`).test(s)).toBe(true);
    expect(new RegExp(escapeRegExp('a.b')).test('axb')).toBe(false);
  });

  it('the reuse-of-the-word note still works for normal words, including hyphens and apostrophes', () => {
    const r = validateDraft(makeDraft({ headword: "don't", lemma: "don't", senses: [makeSense({ definition_en: "the way you say don't in a polite refusal" })] }), ctx({ word: "don't" }));
    expect(r.draft.notes_for_review.join(' ')).toContain('dùng lại chính từ');
  });
});

describe('words with many senses show Haiku a wider window (docs/lookup-enrichment-samples.md §4)', () => {
  const senses = (n: number) => Array.from({ length: n }, (_, i) => ({ glosses: [`gloss number ${i}`], tags: [] }));
  const shown = (n: number) => buildDataObject(makeBundle({ wiktionaryRows: [wrow({ word: 'bank', pos: 'noun', senses: senses(n) })] })).wiktionary as any[];

  it(`up to ${MANY_SENSES_THRESHOLD} senses: ${PROMPT_SENSES_DEFAULT} are shown`, () => {
    expect(shown(MANY_SENSES_THRESHOLD).reduce((n, e) => n + e.senses.length, 0)).toBe(PROMPT_SENSES_DEFAULT);
  });

  it(`more than ${MANY_SENSES_THRESHOLD}: ${PROMPT_SENSES_MANY} are shown`, () => {
    expect(shown(MANY_SENSES_THRESHOLD + 1).reduce((n, e) => n + e.senses.length, 0)).toBe(Math.min(PROMPT_SENSES_MANY, MANY_SENSES_THRESHOLD + 1));
    expect(shown(20).reduce((n, e) => n + e.senses.length, 0)).toBe(PROMPT_SENSES_MANY);
  });

  it('Haiku still writes at most 6 senses', () => {
    expect(LIMITS.senses).toBe(6);
  });
});
