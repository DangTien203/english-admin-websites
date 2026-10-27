import fs from 'node:fs';
import path from 'node:path';
import { HEADWORD_MAX_LENGTH, HEADWORD_PATTERN, headwordProblem, isHeadword, isLowercaseHeadword } from '../../utils/headword';
import { normalizeWord, stripEdges } from '../../services/wordTranslationService';

/** The one headword rule (utils/headword.ts): letters, a hyphen or apostrophe only between letters, no digits or spaces, at most 50. */

const ACCEPTED = ['full-time', 'long-term', 'well-being', 'T-shirt', "o'clock", 'good-for-nothing', 'hello', 'Hello', 'NASA', "don't", 'a'];
const REFUSED = [
  ['a leading hyphen', '-abc'],
  ['a trailing hyphen', 'abc-'],
  ['a doubled hyphen', 'a--b'],
  ['a phrase', 'ice cream'],
  ['a phrase with a hyphen', 'full-time job'],
  ['a digit', 'abc123'],
  ['only digits', '2026'],
  ['a leading apostrophe', "'abc"],
  ['a trailing apostrophe', "abc'"],
  ['a doubled apostrophe', "a''b"],
  ['a hyphen next to an apostrophe', "a'-b"],
  ['a hyphen next to an apostrophe (other order)', "a-'b"],
  ['only a hyphen', '-'],
  ['empty', ''],
  ['an accent', 'café'],
  ['an underscore', 'a_b'],
  ['a tab', 'a\tb'],
  ['a newline', 'a\nb'],
] as const;

describe('isHeadword', () => {
  it.each(ACCEPTED)('accepts %j', (word) => {
    expect(isHeadword(word)).toBe(true);
    expect(headwordProblem(word)).toBeNull();
  });

  it.each(REFUSED)('refuses %s: %j', (_name, word) => {
    expect(isHeadword(word)).toBe(false);
    expect(headwordProblem(word)).toEqual(expect.any(String));
  });

  it('allows exactly 50 characters, also with hyphens inside, and refuses 51', () => {
    expect(HEADWORD_MAX_LENGTH).toBe(50);
    expect(isHeadword('a'.repeat(50))).toBe(true);
    expect(isHeadword(`${'a'.repeat(24)}-${'b'.repeat(25)}`)).toBe(true); // 50 with the hyphen
    expect(isHeadword('a'.repeat(51))).toBe(false);
    expect(headwordProblem('a'.repeat(51))).toMatch(/50/);
  });

  it('refuses what is not a string', () => {
    for (const value of [undefined, null, 42, {}, ['a']]) expect(isHeadword(value)).toBe(false);
  });

  it('says WHY in words a person can act on (a hyphen at the edge is not blamed on "digits/symbols")', () => {
    expect(headwordProblem('ice cream')).toMatch(/no spaces/);
    expect(headwordProblem('abc123')).toMatch(/letters/);
    for (const word of ['-abc', 'abc-', 'a--b', "a'-b"]) expect(headwordProblem(word)).toMatch(/between two letters/);
  });
});

describe('isLowercaseHeadword (the shape of a lemma)', () => {
  it.each(['full-time', 'well-being', "o'clock", 'good-for-nothing', 'a'])('accepts %j', (word) => {
    expect(isLowercaseHeadword(word)).toBe(true);
  });
  it.each(['T-shirt', 'Hello', 'NASA', '-abc', 'abc-', 'a--b', 'ice cream', 'abc123', ''])('refuses %j', (word) => {
    expect(isLowercaseHeadword(word)).toBe(false);
  });
});

describe('normalizeWord follows the same rule', () => {
  it.each(ACCEPTED)('%j is valid and comes back lower-cased', (word) => {
    expect(normalizeWord(word)).toEqual({ normalized: word.toLowerCase(), display: word, isValid: true });
  });

  it.each(REFUSED.filter(([name]) => !/apostrophe/.test(name) || /hyphen/.test(name)))('refuses %s: %j', (_name, word) => {
    expect(normalizeWord(word).isValid).toBe(false);
  });

  it('only strips punctuation at the edges (an apostrophe or a quote there is not part of the word), never a hyphen', () => {
    expect(normalizeWord("'abc'").normalized).toBe('abc');
    expect(normalizeWord('"well-being"').normalized).toBe('well-being');
    expect(normalizeWord('(T-shirt)').normalized).toBe('t-shirt');
    expect(normalizeWord('-abc').isValid).toBe(false);
    expect(normalizeWord('abc-').isValid).toBe(false);
  });

  it('agrees with isHeadword on a few hundred generated strings', () => {
    const alphabet = ['a', 'B', 'z', '-', "'", ' ', '1', '_'];
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 400; i++) {
      const len = 1 + (next() % 8);
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[next() % alphabet.length];
      const stripped = stripEdges(s);
      expect(normalizeWord(s).isValid).toBe(stripped.length > 0 && isHeadword(stripped));
    }
  });
});

describe('there is a single definition of the rule', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  const SKIP = new Set(['node_modules', 'dist', 'tests', '.git', '.claude', 'docs', '.p11tmp', 'coverage']);
  const sources: string[] = [];
  (function walk(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(ts|mts|js|mjs)$/.test(name)) sources.push(full);
    }
  })(ROOT);

  it('no other file spells out the letters-with-hyphens pattern', () => {
    const pattern = /\[(?:A-Za-z|a-z|a-zA-Z)\]\+\(\?:\[(?:'-|-')\]/;
    const offenders = sources.filter((file) => !file.endsWith(path.join('utils', 'headword.ts')) && pattern.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('the HTML-ready pattern is the same text the regexes are built from', () => {
    expect(new RegExp(`^${HEADWORD_PATTERN}$`).test('T-shirt')).toBe(true);
    expect(new RegExp(`^${HEADWORD_PATTERN}$`).test('a--b')).toBe(false);
  });
});
