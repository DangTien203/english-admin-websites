import type { z } from 'zod';
import { isTopicName } from '../topics';
import { LIMITS, type Draft, type Sense } from './schema';

/**
 * S4 — validation and light cleaning of Haiku's output (docs/lookup-spec.md §9.7 plus the extra rules of P6a).
 *
 * validateDraft() returns every problem with the path of the field ("senses[1].meanings_vi[2]"), so that the
 * repair request can quote them, plus a CLEANED copy of the draft (trimmed text, lowercase synonyms, unknown topics
 * dropped, over-long lists cut). What cannot be repaired by cleaning is an `issue`; what was cleaned or dropped is
 * written to notes_for_review as "[kiểm tra] …" so an editor can see it.
 */

export interface ValidationIssue {
  /** e.g. "senses[1].meanings_vi[2]" */
  path: string;
  code: string;
  message: string;
}

export interface ValidationContext {
  /** normalized lookup word */
  word: string;
  /** From the sources; null = unconstrained. Compared case-insensitively. */
  expectedLemma: string | null;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  draft: Draft;
}

// ── limits of the Vietnamese meanings (spec §9.7) ────────────────────────────

export const MEANING_MAX_CHARS = 40;
export const MEANING_MAX_SYLLABLES = 6;
export const DEFINITION_MAX_WORDS = 25;

const LEMMA_FORMAT = /^[a-z]+(?:['-][a-z]+)*$/;
/** CJK radicals and symbols, kana, bopomofo, hangul, ideographs, compatibility ideographs, full-width forms. */
const CJK = /[\u2E80-\u2FDF\u3000-\u30FF\u3100-\u312F\u3130-\u318F\u31A0-\u31FF\u3400-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
const PAREN = /[()（）]/;

export const hasCjk = (s: string): boolean => CJK.test(s);
export const hasParenthesis = (s: string): boolean => PAREN.test(s);
export const countWords = (s: string): number => (s.trim() === '' ? 0 : s.trim().split(/\s+/).length);

/** Case and whitespace insensitive form used to compare meanings. */
export const normalizeMeaning = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Vietnamese classifiers / nominalizers that can be put in front of a noun without changing its meaning. */
export const CLASSIFIERS = ['con', 'cái', 'chiếc', 'sự', 'việc', 'cuộc', 'nỗi', 'niềm'] as const;
/** Quantity words that likewise change nothing when put in front ("một tập podcast" / "tập podcast"). */
const DETERMINERS = ['một', 'những', 'các'] as const;
const LEADING_FILLERS: readonly string[] = [...CLASSIFIERS, ...DETERMINERS];

/** A normalized meaning without ONE leading classifier or determiner ("con mèo" → "mèo"); unchanged when nothing would be left. */
export function stripClassifier(normalized: string): string {
  const [first, ...rest] = normalized.split(' ');
  return rest.length > 0 && LEADING_FILLERS.includes(first) ? rest.join(' ') : normalized;
}

const tidy = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim();
const tidyMeaning = (s: string): string => tidy(s).replace(/[.;,:]+$/, '').trim();

// ── zod → issues ─────────────────────────────────────────────────────────────

export const formatPath = (path: ReadonlyArray<PropertyKey>): string =>
  path.reduce<string>((acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${String(part)}` : String(part)), '') || '$';

export function zodIssuesToValidation(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({ path: formatPath(i.path), code: `schema_${i.code}`, message: i.message }));
}

// ── the validator ────────────────────────────────────────────────────────────

export function validateDraft(input: Draft, ctx: ValidationContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const notes: string[] = [];
  const issue = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const note = (message: string) => notes.push(`[kiểm tra] ${message}`);

  const variantOf = tidy(input.variant_of ?? '').toLowerCase() || null;
  const headword = tidy(input.headword);
  const lemma = tidy(input.lemma).toLowerCase();
  const isReal = input.is_english_word && !input.is_proper_noun && variantOf === null;
  const lowerWord = ctx.word.toLowerCase();

  // ── identity ──
  if (isReal) {
    if (!headword) issue('headword', 'empty', 'headword is empty');
    if (!lemma) issue('lemma', 'empty', 'lemma is empty');
    else if (!LEMMA_FORMAT.test(lemma)) issue('lemma', 'format', `lemma "${lemma}" must be a single lowercase word (letters, with an apostrophe or hyphen between letters)`);
    if (headword && lemma && headword.toLowerCase() !== lemma) {
      issue('headword', 'headword_lemma', `headword "${headword}" must be the display form of lemma "${lemma}" (same letters, only the letter case may differ)`);
    }
    if (ctx.expectedLemma && lemma && lemma !== ctx.expectedLemma.toLowerCase()) {
      issue('lemma', 'lemma_mismatch', `lemma must be "${ctx.expectedLemma}" (the sources name it), got "${lemma}"`);
    }
  }

  // ── topics: unknown names are dropped, never replaced ──
  const topics: string[] = [];
  for (const raw of input.topics) {
    const name = tidy(raw);
    if (!isTopicName(name)) {
      note(`bỏ chủ đề không hợp lệ "${name}"`);
      continue;
    }
    if (!topics.includes(name)) topics.push(name);
  }
  // academic_formal is the last resort for abstract C1 words that fit no other topic: alone, and only at C1 / C2.
  const academic = topics.indexOf('academic_formal');
  if (academic >= 0 && !(topics.length === 1 && (input.cefr_level === 'C1' || input.cefr_level === 'C2'))) {
    topics.splice(academic, 1);
    note('bỏ academic_formal: chỉ dành cho từ trừu tượng trình độ C1 hoặc C2 không hợp chủ đề nào khác');
  }
  if (topics.length > LIMITS.topics) {
    note(`chỉ giữ ${LIMITS.topics} chủ đề đầu tiên`);
    topics.length = LIMITS.topics;
  }
  if (isReal && topics.length === 0) note('không có chủ đề hợp lệ nào (topics rỗng)');

  if (isReal) {
    if (input.cefr_level === null) issue('cefr_level', 'missing', 'cefr_level is required for a real word');
    if (input.senses.length === 0) issue('senses', 'empty', 'a real word needs at least one sense');
  }

  // ── senses ──
  const wordForms = new Set([lowerWord, lemma].filter(Boolean));
  const senses: Sense[] = input.senses.map((sense, i) => {
    const at = `senses[${i}]`;
    if (!isReal) return sense;

    // definition_en
    const definition = tidy(sense.definition_en);
    if (!definition) issue(`${at}.definition_en`, 'empty', 'definition_en is empty');
    else if (countWords(definition) > DEFINITION_MAX_WORDS) {
      issue(`${at}.definition_en`, 'too_long', `definition_en has ${countWords(definition)} words, the limit is ${DEFINITION_MAX_WORDS}`);
    }
    if (definition && [...wordForms].some((w) => new RegExp(`\\b${w.replace(/[-']/g, '\\$&')}\\b`, 'i').test(definition))) {
      note(`senses[${i}].definition_en dùng lại chính từ đang định nghĩa`);
    }

    // meanings_vi — the quality centre of the draft
    const meanings = sense.meanings_vi.map(tidyMeaning);
    const seen = new Map<string, number>();
    const seenCore = new Map<string, number>();
    meanings.forEach((m, j) => {
      const p = `${at}.meanings_vi[${j}]`;
      if (!m) return issue(p, 'empty', 'meaning is empty');
      if (m.length > MEANING_MAX_CHARS) issue(p, 'too_long', `"${m}" has ${m.length} characters, the limit is ${MEANING_MAX_CHARS}`);
      if (countWords(m) > MEANING_MAX_SYLLABLES) issue(p, 'too_many_syllables', `"${m}" has ${countWords(m)} syllables, the limit is ${MEANING_MAX_SYLLABLES}`);
      if (hasParenthesis(m)) issue(p, 'parenthesis', `"${m}" contains parentheses; put nuance into register, domain, region or usage_note`);
      if (hasCjk(m)) issue(p, 'cjk', `"${m}" contains Chinese, Korean or Japanese characters`);
      const key = normalizeMeaning(m);
      if (seen.has(key)) issue(p, 'duplicate', `"${m}" repeats meanings_vi[${seen.get(key)}]`);
      else {
        seen.set(key, j);
        // "con mèo" and "mèo" differ only by a classifier: one meaning, not two.
        const core = stripClassifier(key);
        if (seenCore.has(core)) issue(p, 'classifier_duplicate', `"${m}" is meanings_vi[${seenCore.get(core)}] with a classifier or determiner (${[...CLASSIFIERS, ...DETERMINERS].join(', ')}) added or removed; keep one`);
        else seenCore.set(core, j);
      }
    });
    const filled = meanings.filter(Boolean);
    if (filled.length > 0 && filled.every((m) => wordForms.has(normalizeMeaning(m)))) {
      issue(`${at}.meanings_vi`, 'same_as_english', `every meaning equals the English word "${ctx.word}"; a loanword may keep one identical meaning only next to a different one`);
    }

    // examples
    const examples = sense.examples.map((e, k) => {
      const p = `${at}.examples[${k}]`;
      const en = tidy(e.example_en);
      const vi = tidy(e.example_vi);
      if (!en) issue(`${p}.example_en`, 'empty', 'example_en is empty');
      if (!vi) issue(`${p}.example_vi`, 'empty', 'example_vi is empty');
      else if (en && vi.toLowerCase() === en.toLowerCase()) issue(`${p}.example_vi`, 'same_as_english', 'example_vi must be a translation, not a copy of example_en');
      if (vi && hasCjk(vi)) issue(`${p}.example_vi`, 'cjk', 'example_vi contains Chinese, Korean or Japanese characters');
      return { example_en: en, example_vi: vi };
    });

    // notes
    const grammarNote = tidy(sense.grammar_note ?? '') || null;
    const usageNote = tidy(sense.usage_note ?? '') || null;
    for (const [field, value] of [['grammar_note', grammarNote], ['usage_note', usageNote]] as const) {
      if (value && hasCjk(value)) issue(`${at}.${field}`, 'cjk', `${field} contains Chinese, Korean or Japanese characters`);
    }

    // related words
    const related = (list: string[], label: 'synonyms' | 'antonyms'): string[] => {
      const out = [...new Set(list.map((w) => tidy(w).toLowerCase()).filter((w) => w && !wordForms.has(w)))];
      if (out.length > LIMITS.related) note(`${at}.${label}: chỉ giữ ${LIMITS.related} từ đầu tiên`);
      return out.slice(0, LIMITS.related);
    };

    return {
      pos: sense.pos,
      definition_en: definition,
      meanings_vi: meanings,
      register: sense.register,
      domain: tidy(sense.domain ?? '').toLowerCase().slice(0, 100) || null,
      region: tidy(sense.region ?? '').slice(0, 30) || null,
      grammar_note: grammarNote,
      usage_note: usageNote,
      examples,
      synonyms: related(sense.synonyms, 'synonyms'),
      antonyms: related(sense.antonyms, 'antonyms'),
    };
  });

  // ── idioms, phrasal verbs, collocations: optional extras → bad items are dropped, not repaired ──
  const dropped = (kind: string, why: string) => note(`bỏ một ${kind}: ${why}`);
  const keepPhrases = <T>(list: T[], kind: string, check: (item: T) => string | null, clean: (item: T) => T): T[] => {
    const out: T[] = [];
    for (const item of list) {
      const problem = isReal ? check(item) : 'từ không được lập mục';
      if (problem) {
        if (isReal) dropped(kind, problem);
        continue;
      }
      out.push(clean(item));
    }
    if (out.length > LIMITS.phrases) note(`${kind}: chỉ giữ ${LIMITS.phrases} mục đầu tiên`);
    return out.slice(0, LIMITS.phrases);
  };
  const vietnameseOk = (...fields: string[]) => !fields.some((f) => hasCjk(f));

  const idioms = keepPhrases(
    input.idioms,
    'thành ngữ',
    (i) => (!tidy(i.idiom_text) || tidy(i.idiom_text).length > 500 ? 'idiom_text rỗng hoặc quá dài' : !tidy(i.definition_en) ? 'thiếu định nghĩa' : !vietnameseOk(i.definition_vi, i.example_vi) ? 'có ký tự Hán, Hàn, Nhật' : null),
    (i) => ({ idiom_text: tidy(i.idiom_text), definition_en: tidy(i.definition_en), definition_vi: tidy(i.definition_vi), example_en: tidy(i.example_en), example_vi: tidy(i.example_vi) })
  );
  const phrasalVerbs = keepPhrases(
    input.phrasal_verbs,
    'cụm động từ',
    (p) => {
      const verb = tidy(p.phrasal_verb).toLowerCase();
      if (!verb || verb.length > 255) return 'phrasal_verb rỗng hoặc quá dài';
      if (!tidy(p.particle) || tidy(p.particle).length > 30) return 'particle rỗng hoặc quá dài';
      if (isReal && lemma && !verb.startsWith(lemma)) return `"${verb}" không bắt đầu bằng động từ "${lemma}"`;
      return vietnameseOk(p.definition_vi, p.example_vi) ? null : 'có ký tự Hán, Hàn, Nhật';
    },
    (p) => ({ phrasal_verb: tidy(p.phrasal_verb), particle: tidy(p.particle), is_separable: p.is_separable, definition_en: tidy(p.definition_en), definition_vi: tidy(p.definition_vi), example_en: tidy(p.example_en), example_vi: tidy(p.example_vi) })
  );
  const collocations = keepPhrases(
    input.collocations,
    'cụm kết hợp',
    (c) => (!tidy(c.collocation) || tidy(c.collocation).length > 255 ? 'collocation rỗng hoặc quá dài' : !vietnameseOk(c.example_vi) ? 'có ký tự Hán, Hàn, Nhật' : null),
    (c) => ({ collocation: tidy(c.collocation), pattern: tidy(c.pattern).slice(0, 50), example_en: tidy(c.example_en), example_vi: tidy(c.example_vi) })
  );

  // ── part-of-speech dependent flags ──
  const hasNoun = senses.some((s) => s.pos === 'noun');
  const hasVerb = senses.some((s) => s.pos === 'verb' || s.pos === 'modal verb');
  const pos = senses.length > 0 ? [...new Set(senses.map((s) => s.pos))] : [...new Set(input.pos)];

  const notesForReview = [...input.notes_for_review.map(tidy).filter(Boolean), ...notes].slice(0, LIMITS.notes + notes.length);

  const draft: Draft = {
    is_english_word: input.is_english_word,
    is_proper_noun: input.is_proper_noun,
    variant_of: variantOf,
    headword,
    lemma,
    pos,
    cefr_level: input.cefr_level,
    is_countable: isReal && hasNoun ? input.is_countable : null,
    is_transitive: isReal && hasVerb ? input.is_transitive : null,
    topics,
    senses,
    idioms,
    phrasal_verbs: phrasalVerbs,
    collocations,
    notes_for_review: notesForReview,
  };
  return { issues, draft };
}
