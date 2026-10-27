/**
 * The one definition of a single-word headword, shared by every place that checks one (the lookup path, the enqueuer, the Oxford
 * list reader, the enrichment pipeline). Nothing else should spell this pattern out.
 *
 * A headword is:
 *   - letters only, upper or lower case (A-Z, a-z): no digits, no spaces, no other symbols;
 *   - at most HEADWORD_MAX_LENGTH characters;
 *   - a hyphen or an apostrophe is allowed only BETWEEN two letters, one at a time: "well-being", "T-shirt", "o'clock",
 *     "good-for-nothing" pass; "-abc", "abc-", "a--b", "a'-b" and "a''b" do not.
 * Phrases ("ice cream") are not single words and stay refused.
 *
 * The lemma of an entry is the lower-case form of the same rule (isLowercaseHeadword).
 */
export const HEADWORD_MAX_LENGTH = 50;

/** Letters, then any number of (one separator + letters). Source text, so an HTML `pattern` attribute can reuse it. */
export const HEADWORD_PATTERN = "[A-Za-z]+(?:['-][A-Za-z]+)*";

const HEADWORD = new RegExp(`^${HEADWORD_PATTERN}$`);
const LOWERCASE_HEADWORD = /^[a-z]+(?:['-][a-z]+)*$/;

/** True for a string that follows the rule above (any letter case). */
export function isHeadword(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= HEADWORD_MAX_LENGTH && HEADWORD.test(value);
}

/** The same rule with lower-case letters only: the shape of a lemma. */
export function isLowercaseHeadword(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= HEADWORD_MAX_LENGTH && LOWERCASE_HEADWORD.test(value);
}

/** Why a string is not a headword, in English for logs and API messages; null when it is one. */
export function headwordProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'word must be a string';
  if (value.length === 0) return 'word is empty';
  if (value.length > HEADWORD_MAX_LENGTH) return `word exceeds ${HEADWORD_MAX_LENGTH} characters`;
  if (HEADWORD.test(value)) return null;
  if (/\s/.test(value)) return 'word must be a single word (no spaces)';
  if (/[0-9]/.test(value)) return 'word must contain only letters (digits/symbols not allowed)';
  if (/^['-]|['-]$/.test(value) || /['-]{2}/.test(value)) return 'a hyphen or apostrophe is only allowed between two letters';
  return 'word must contain only letters (digits/symbols not allowed)';
}
