import { POS_VALUES } from '../../services/enrichment/haiku/schema';
import { isPosValue, normalizePos, normalizePosList } from '../../services/enrichment/pos';

describe('normalizePos', () => {
  it.each([
    ['adj', 'adjective'],
    ['adv', 'adverb'],
    ['intj', 'exclamation'],
    ['prep', 'preposition'],
    ['conj', 'conjunction'],
    ['pron', 'pronoun'],
    ['det', 'determiner'],
    ['num', 'number'],
    ['art', 'article'],
    ['interjection', 'exclamation'],
    ['noun', 'noun'],
    ['verb', 'verb'],
    ['modal verb', 'modal verb'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePos(raw)).toBe(expected);
  });

  it('is case and space insensitive', () => {
    expect(normalizePos('  Adj ')).toBe('adjective');
    expect(normalizePos('MODAL   VERB')).toBe('modal verb');
  });

  it.each(['name', 'phrase', 'prefix', 'suffix', 'contraction', 'proverb', 'symbol', 'particle', '', '   ', 'xyz'])('%j is not one of the 12 values → null', (raw) => {
    expect(normalizePos(raw)).toBeNull();
  });

  it.each([null, undefined, 5, {}, ['noun']])('%j (not a string) → null', (raw) => {
    expect(normalizePos(raw)).toBeNull();
  });

  it('every value it returns is one of the 12 values the database already uses', () => {
    for (const raw of ['n', 'v', 'adj', 'adv', 'intj', 'interj', 'prep', 'conj', 'pron', 'det', 'num', 'art', 'modal', 'adjective', 'numeral']) {
      expect(POS_VALUES).toContain(normalizePos(raw));
    }
  });

  it('the 12 values map to themselves', () => {
    for (const v of POS_VALUES) expect(normalizePos(v)).toBe(v);
  });
});

describe('normalizePosList', () => {
  it('keeps the order of first appearance, drops duplicates and unknown names', () => {
    expect(normalizePosList(['verb', 'noun', 'adj', 'verb', 'name', 'phrase', 'adjective', 'noun'])).toEqual(['verb', 'noun', 'adjective']);
  });
  it('is empty for nothing usable', () => {
    expect(normalizePosList(['name', 'prefix'])).toEqual([]);
  });
});

describe('isPosValue', () => {
  it('accepts the 12 values only', () => {
    expect(isPosValue('noun')).toBe(true);
    expect(isPosValue('adj')).toBe(false);
    expect(isPosValue(3)).toBe(false);
  });
});
