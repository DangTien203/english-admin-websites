/**
 * "Is this answer written in Vietnamese?" — used by the English-meaning check (Leitner / practice, box 4/5): the learner is asked
 * to explain the word IN ENGLISH, so a Vietnamese answer is wrong however correct a translation it is. Deterministic on purpose: it
 * runs before the cache and before any paid model call.
 *
 * Two kinds of diacritics tell Vietnamese from English:
 *   - strong: letters / tone marks that exist in Vietnamese and in no English word or common loanword (đ ă ơ ư, hook-above, tilde,
 *     dot-below, stacked marks such as ầ ế ố ứ) — one of them is enough;
 *   - weak: plain acute / grave / circumflex (à á â è é ê ì í ò ó ô ù ú) — French, Spanish and Italian loanwords have them too
 *     ("café", "résumé"), so they count only when at least half of the words carry one, loanwords on the list below aside.
 * An answer typed without any diacritics ("mau nau") cannot be told apart this way: the caller compares it with the entry's
 * Vietnamese meanings (stripDiacritics), and the grading prompt requires English as the last line of defence.
 */

const STRONG_VI = /[đăơưýỳảẳẩẻểỉỏổởủửỷãẵẫẽễĩõỗỡũữỹạặậẹệịọộợụựỵầấằắềếồốờớừứ]/i;
const WEAK_VI = /[àáâèéêìíòóôùú]/i;

/** English words (loanwords) that carry an accent: they do not make an answer "Vietnamese". */
const ENGLISH_ACCENTED = new Set([
  'à', 'café', 'cafés', 'résumé', 'résumés', 'cliché', 'clichés', 'fiancé', 'fiancée', 'protégé', 'protégée', 'entrée', 'passé',
  'touché', 'soufflé', 'sauté', 'sautéed', 'purée', 'crème', 'brûlée', 'décor', 'déjà', 'élan', 'séance', 'rôle', 'pâté', 'château',
  'fête', 'bête', 'risqué', 'blasé', 'mêlée', 'matinée', 'éclair', 'éclairs', 'ménage', 'née', 'exposé', 'divorcée', 'détente',
  'attaché', 'communiqué', 'émigré', 'précis', 'dénouement',
]);

const tokens = (text: string): string[] => text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);

/** Removes every diacritic and maps đ → d: "màu nâu" → "mau nau". */
export function stripDiacritics(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFC');
}

/** True when the text is, with near certainty, Vietnamese (see the file header for what that rests on). */
export function looksVietnamese(text: string | null | undefined): boolean {
  if (!text) return false;
  const nfc = text.normalize('NFC');
  if (STRONG_VI.test(nfc)) return true;

  const words = tokens(nfc);
  if (words.length === 0) return false;
  const accented = words.filter((w) => WEAK_VI.test(w) && !ENGLISH_ACCENTED.has(w));
  return accented.length > 0 && accented.length / words.length >= 0.5;
}
