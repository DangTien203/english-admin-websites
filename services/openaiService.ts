import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-2024-08-06';

// ── Lazy init — no top-level instantiation ────────────────────────────────────
let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    _client = new OpenAI({
      apiKey,
      timeout: parseInt(process.env.OPENAI_TIMEOUT_MS || '20000', 10),
    });
  }
  return _client;
}

export function isOpenAIConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

// gpt-4o-2024-08-06 pricing (USD per token)
const PRICE_IN  = 2.50  / 1_000_000;
const PRICE_OUT = 10.00 / 1_000_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModerationResult {
  flagged: boolean;
  flag_type: 'sexual' | 'violence' | 'hate' | 'self_harm' | 'other' | null;
  severity: 'low' | 'medium' | 'high' | null;
  raw: object;
}

const SentenceResultSchema = z.object({
  target_word: z.string(),
  sentence: z.string(),
  used_target: z.boolean(),
  grammar_ok: z.boolean(),
  errors: z.array(z.object({
    type: z.string(),
    location: z.string(),
    message: z.string(),
  })),
  fix: z.string(),
  explanation_vi: z.string(),
});

const GradeOutputSchema = z.object({
  results: z.array(SentenceResultSchema),
  overall_score: z.number().int().min(0).max(100),
  overall_feedback_vi: z.string(),
});

export type GradeOutput = z.infer<typeof GradeOutputSchema>;

const VietnameseAnswerGradeOutputSchema = z.object({
  verdict: z.enum(['correct', 'near_correct', 'wrong']),
  confidence: z.number().min(0).max(1),
  matched_answer: z.string().nullable(),
  reason_vi: z.string(),
});

export type VietnameseAnswerGradeOutput = z.infer<typeof VietnameseAnswerGradeOutputSchema>;

export interface GradeInput {
  targetWords: Array<{ headword: string; meaning_vi: string | null; pos: string[] }>;
  sentences: string[];
  userLevel: string;
  systemPrompt: string;
}

export interface GradeResult {
  output: GradeOutput;
  model_used: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export interface VietnameseAnswerGradeInput {
  headword: string;
  pos: string[];
  expectedAnswers: string[];
  userAnswer: string;
  systemPrompt?: string;
}

export interface VietnameseAnswerGradeResult {
  output: VietnameseAnswerGradeOutput;
  model_used: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

const DEFAULT_VI_ANSWER_GRADER_PROMPT = `
You are a strict but fair grader for English-to-Vietnamese flashcard answers.

Grade whether the user's Vietnamese answer is an acceptable meaning of the English headword.
Use the part of speech and accepted answers as context, but do not require exact wording.

Return:
- correct: the user answer is a natural Vietnamese equivalent or synonym for the headword.
- near_correct: the answer is close, related, too broad, too narrow, or slightly off in nuance.
- wrong: the answer has a different meaning, is unrelated, or only matches by spelling accident.

Rules:
- Prefer common Vietnamese usage.
- Do not accept antonyms.
- Do not accept example sentences unless the answer phrase itself is clearly correct.
- Keep reason_vi short and user-friendly.
`.trim();

const DEFAULT_EN_MEANING_GRADER_PROMPT = `
You are a strict but fair grader for English vocabulary flashcards.

The learner was shown an English headword and asked to explain its meaning in English
(a definition, paraphrase, or close synonym). Grade whether the learner's answer
captures the meaning of the headword. Use the part of speech and reference definitions
as context, but do not require exact wording.

Return:
- correct: the answer clearly conveys the meaning (a valid definition, paraphrase, or close synonym).
- near_correct: related, too broad, too narrow, or slightly off in nuance.
- wrong: different meaning, unrelated, an antonym, or merely repeats the headword without explaining it.

Rules:
- Repeating the headword itself (or a trivial inflection of it) is wrong.
- Do not accept antonyms.
- Keep reason_vi short, user-friendly, and written in Vietnamese.
`.trim();

// ── moderateInput ─────────────────────────────────────────────────────────────

export async function moderateInput(text: string): Promise<ModerationResult> {
  const response = await getClient().moderations.create({ input: text });
  const result = response.results[0];

  if (!result.flagged) {
    return { flagged: false, flag_type: null, severity: null, raw: result as unknown as object };
  }

  const cats   = result.categories      as unknown as Record<string, boolean>;
  const scores = result.category_scores as unknown as Record<string, number>;

  let flag_type: ModerationResult['flag_type'] = 'other';
  if (cats['sexual'] || cats['sexual/minors'])
    flag_type = 'sexual';
  else if (cats['violence'] || cats['violence/graphic'])
    flag_type = 'violence';
  else if (cats['hate'] || cats['hate/threatening'])
    flag_type = 'hate';
  else if (cats['self-harm'] || cats['self-harm/intent'] || cats['self-harm/instructions'])
    flag_type = 'self_harm';

  const maxScore = Math.max(...Object.values(scores));
  const severity: ModerationResult['severity'] =
    maxScore >= 0.8 ? 'high' : maxScore >= 0.5 ? 'medium' : 'low';

  return { flagged: true, flag_type, severity, raw: result as unknown as object };
}

// ── gradeSentences ────────────────────────────────────────────────────────────

export async function gradeSentences(input: GradeInput): Promise<GradeResult> {
  const { targetWords, sentences, userLevel, systemPrompt } = input;

  const wordList = targetWords
    .map((w, i) =>
      `${i + 1}. Target word: "${w.headword}"${w.pos.length ? ` (${w.pos.join(', ')})` : ''}\n` +
      `   Vietnamese meaning: ${w.meaning_vi || '(not available)'}\n` +
      `   Sentence: "${sentences[i]}"`
    )
    .join('\n\n');

  const start = Date.now();

  const completion = await getClient().chat.completions.parse({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `User level: ${userLevel}\n\n${wordList}` },
    ],
    response_format: zodResponseFormat(GradeOutputSchema, 'grade_result'),
  });

  const latency_ms = Date.now() - start;
  const usage = completion.usage!;
  const tokens_in  = usage.prompt_tokens;
  const tokens_out = usage.completion_tokens;
  const cost_usd   = tokens_in * PRICE_IN + tokens_out * PRICE_OUT;

  const output = completion.choices[0].message.parsed;
  if (!output) throw new Error('OpenAI returned empty parsed output');

  return { output, model_used: completion.model, latency_ms, tokens_in, tokens_out, cost_usd };
}

// ── gradeVietnameseAnswer / gradeEnglishMeaning ──────────────────────────────

async function runAnswerGrade(
  systemPrompt: string,
  payload: Record<string, unknown>
): Promise<VietnameseAnswerGradeResult> {
  const start = Date.now();

  const completion = await getClient().chat.completions.parse({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    response_format: zodResponseFormat(
      VietnameseAnswerGradeOutputSchema,
      'vietnamese_answer_grade'
    ),
  });

  const latency_ms = Date.now() - start;
  const usage = completion.usage!;
  const tokens_in = usage.prompt_tokens;
  const tokens_out = usage.completion_tokens;
  const cost_usd = tokens_in * PRICE_IN + tokens_out * PRICE_OUT;

  const output = completion.choices[0].message.parsed;
  if (!output) throw new Error('OpenAI returned empty parsed output');

  return { output, model_used: completion.model, latency_ms, tokens_in, tokens_out, cost_usd };
}

export async function gradeVietnameseAnswer(
  input: VietnameseAnswerGradeInput
): Promise<VietnameseAnswerGradeResult> {
  return runAnswerGrade(input.systemPrompt || DEFAULT_VI_ANSWER_GRADER_PROMPT, {
    headword: input.headword,
    pos: input.pos,
    accepted_answers: input.expectedAnswers,
    user_answer: input.userAnswer,
  });
}

/** Grades a free-text English explanation (definition / paraphrase / synonym) of the headword. */
export async function gradeEnglishMeaning(
  input: VietnameseAnswerGradeInput
): Promise<VietnameseAnswerGradeResult> {
  return runAnswerGrade(input.systemPrompt || DEFAULT_EN_MEANING_GRADER_PROMPT, {
    headword: input.headword,
    pos: input.pos,
    reference_definitions: input.expectedAnswers,
    user_answer: input.userAnswer,
  });
}
