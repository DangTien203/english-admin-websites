import { normalizeWord } from '../../services/wordTranslationService';

/** Word sanitizer (docs/lookup-spec.md §5 F1, §12.3): the filter that existed before P3, now under test. */
describe('normalizeWord', () => {
  it.each([
    ['Hello', 'hello', 'Hello'],
    ['  "Running!" ', 'running', 'Running'],
    ['(well-being)', 'well-being', 'well-being'],
    ["Don't", "don't", "Don't"],
    ['‘quoted’', 'quoted', 'quoted'],
    ['UBIQUITOUS.', 'ubiquitous', 'UBIQUITOUS'],
  ])('%j is valid → %j', (raw, normalized, display) => {
    expect(normalizeWord(raw)).toEqual({ normalized, display, isValid: true });
  });

  it.each([
    ['empty', ''],
    ['only punctuation', '?!...'],
    ['only whitespace', '   \t\n'],
    ['two words', 'ice cream'],
    ['a digit', 'abc1'],
    ['only digits', '2026'],
    ['a control character', 'a\u0000b'],
    ['a newline inside', 'a\nb'],
    ['a zero-width space', 'a​b'],
    ['a right-to-left override', '‮evil'],
    ['accented letters (not supported today)', 'café'],
    ['non-latin letters', 'слово'],
    ['emoji', 'dog🐶'],
    ['an html tag', '<script>'],
    ['sql punctuation', "x';--"],
    ['a leading hyphen', '-abc'],
    ['a doubled apostrophe inside', "a''b"],
  ])('%s is rejected', (_name, raw) => {
    expect(normalizeWord(raw).isValid).toBe(false);
  });

  it('rejects words longer than 50 characters and accepts exactly 50', () => {
    expect(normalizeWord('a'.repeat(50)).isValid).toBe(true);
    const long = normalizeWord('a'.repeat(51));
    expect(long.isValid).toBe(false);
    expect(long.reason).toMatch(/50/);
  });

  it('rejects non-strings', () => {
    expect(normalizeWord(undefined as any).isValid).toBe(false);
    expect(normalizeWord(42 as any).isValid).toBe(false);
    expect(normalizeWord({} as any).isValid).toBe(false);
  });

  it('a valid result never contains uppercase letters in the key', () => {
    expect(normalizeWord('MiXeD').normalized).toBe('mixed');
  });
});
