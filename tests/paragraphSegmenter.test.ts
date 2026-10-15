import { segmentParagraphs, countWords, splitSentences } from '../utils/paragraphSegmenter';

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function endsWithSentenceTerminator(s: string): boolean {
  // Accept any of: . ! ? … plus optional closing quotes/brackets.
  return /[.!?…]['"’”\)\]]?\s*$/.test(s);
}

let _wordIdx = 0;
function makeWords(n: number): string {
  return Array.from({ length: n }, () => `word${++_wordIdx}`).join(' ');
}

function makeSentence(n: number): string {
  const raw = makeWords(n) + '.';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
//  countWords
// ─────────────────────────────────────────────────────────────────────────────
describe('countWords', () => {
  test('counts simple words', () => {
    expect(countWords('hello world foo')).toBe(3);
  });

  test('handles extra whitespace', () => {
    expect(countWords('  one  two   three  ')).toBe(3);
  });

  test('returns 0 for empty string', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  splitSentences (sbd-backed)
// ─────────────────────────────────────────────────────────────────────────────
describe('splitSentences', () => {
  test('splits at period + space + uppercase', () => {
    const result = splitSentences('Hello world. This is a test. Another sentence.');
    expect(result).toHaveLength(3);
  });

  test('does NOT split on common abbreviations', () => {
    const result = splitSentences('Mr. Smith met Dr. Jones at 8 a.m. They discussed the case.');
    // "Mr.", "Dr.", "a.m." should NOT be split.
    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/Mr\. Smith met Dr\. Jones at 8 a\.m\./);
  });

  test('does NOT split on initials like J.K. Rowling', () => {
    const result = splitSentences('I love J.K. Rowling books. She is an amazing author.');
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('J.K. Rowling');
  });

  test('does NOT split on i.e. / e.g. / etc.', () => {
    const result = splitSentences('Use a fast language, e.g. C++. Avoid bloat, i.e. unused libs.');
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('e.g.');
    expect(result[1]).toContain('i.e.');
  });

  test('does NOT split decimal numbers like 1.5', () => {
    const result = splitSentences('The version is 1.5 and stable. We will ship soon.');
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('1.5');
  });

  test('handles question marks and exclamation', () => {
    const result = splitSentences('Are you ready? I am! Let us go.');
    expect(result).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  segmentParagraphs — core contract
// ─────────────────────────────────────────────────────────────────────────────
describe('segmentParagraphs — author boundary respect', () => {
  test('returns empty array for blank input', () => {
    expect(segmentParagraphs('')).toHaveLength(0);
    expect(segmentParagraphs('   \n\n   ')).toHaveLength(0);
  });

  test('a short author block becomes exactly one paragraph', () => {
    const text = 'A small paragraph with a few words.';
    expect(segmentParagraphs(text)).toEqual([text]);
  });

  test('two author blocks (separated by \\n\\n) never merge', () => {
    const text = 'First block has several words here.\n\nSecond block is also separate from first.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('First block has several words here.');
    expect(result[1]).toBe('Second block is also separate from first.');
  });

  test('every paragraph ends at a sentence boundary (incl. abbreviations)', () => {
    // Long block intentionally containing abbreviations that would trip a naive splitter.
    _wordIdx = 0;
    const block =
      'Mr. Smith said hello to Dr. Jones at 9 a.m. ' +
      'They discussed J.K. Rowling at length, e.g. her early works. ' +
      'After lunch, i.e. around 1 p.m., they walked to St. Paul Street. ' +
      'Version 1.5 of the report was due, but Mrs. Lee had concerns. ' +
      'Eventually, the U.S. team approved it. ' +
      'They celebrated with cake.';

    const paragraphs = segmentParagraphs(block);
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const p of paragraphs) {
      expect(endsWithSentenceTerminator(p)).toBe(true);
    }
  });

  test('a 5000-word block of long sentences with abbreviations splits only at sentence ends', () => {
    _wordIdx = 0;
    const sentences: string[] = [];
    for (let i = 0; i < 100; i++) {
      // Mix sentences of varying lengths and abbreviations.
      const filler = makeWords(50);
      sentences.push(`Mr. Smith and Dr. Jones, e.g. at 8 a.m., discussed ${filler} in detail.`);
    }
    const block = sentences.join(' ');
    const paragraphs = segmentParagraphs(block);

    expect(paragraphs.length).toBeGreaterThan(0);
    for (const p of paragraphs) {
      expect(endsWithSentenceTerminator(p)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Regression: the "Hunger Games" Even/though bug
// ─────────────────────────────────────────────────────────────────────────────
describe('regression — never split mid-word or mid-sentence', () => {
  test('the reported "Even" / "though" split must not happen', () => {
    // The original passage from the bug report. Even after considering author
    // paragraph breaks were lost, the splitter must NOT cut between "Even" and
    // "though" — both lie inside the same sentence.
    const passage =
      'It must have looked particularly funny since Buttercup was struggling to hold on to me. ' +
      'Or at least distrusts me. ' +
      'Even though it was years ago, I think he still remembers how I tried to drown him in a bucket when Prim brought him home.';

    const paragraphs = segmentParagraphs(passage);

    for (const p of paragraphs) {
      // No paragraph should END with the bare word "Even" (or even "Even." which
      // wasn't a real sentence in the source) — that would mean we cut the
      // following sentence in half.
      expect(p.trimEnd().endsWith('Even')).toBe(false);
      // No paragraph should START mid-sentence with lowercase "though".
      expect(/^though\b/.test(p)).toBe(false);
      // Every paragraph must end at a real sentence boundary.
      expect(endsWithSentenceTerminator(p)).toBe(true);
    }
  });

  test('a single sentence longer than MAX_WORDS is kept whole, not chopped at commas', () => {
    // 80-word sentence with several commas — must stay as one paragraph.
    const longSentence =
      'Although the rain had been falling steadily for hours, soaking the streets and gutters, ' +
      'the children kept playing in the park, laughing and shouting and running between puddles, ' +
      'their coats heavy with water, their boots squelching with every step, ' +
      'while their parents watched anxiously from doorways, sipping coffee, glancing at their watches, ' +
      'wondering when the storm would finally pass and the sun would once again return to dry the world.';

    const result = segmentParagraphs(longSentence);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(longSentence);
  });
});
