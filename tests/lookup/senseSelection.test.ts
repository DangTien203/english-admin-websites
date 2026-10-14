import * as fs from 'fs';
import * as path from 'path';
import type { FdSense } from '../../services/upstream/freeDictionaryClient';
import {
  buildPrefixedQuery,
  cleanGloss,
  dedupeMeanings,
  meaningKey,
  selectSenses,
  splitGloss,
  truncateDefinition,
} from '../../services/lookup/senseSelection';

const sense = (pos: string, definition: string): FdSense => ({ pos, definition, example: null, synonyms: [], antonyms: [] });

describe('selectSenses (F9)', () => {
  it('takes the first sense of every part of speech first, then deeper senses of the main one', () => {
    const senses = [
      sense('verb', 'v1'), sense('verb', 'v2'), sense('verb', 'v3'),
      sense('noun', 'n1'), sense('noun', 'n2'),
      sense('adjective', 'a1'),
    ];
    expect(selectSenses(senses, 4).map((s) => s.definition)).toEqual(['v1', 'n1', 'a1', 'v2']);
    expect(selectSenses(senses, 6).map((s) => s.definition)).toEqual(['v1', 'n1', 'a1', 'v2', 'n2', 'v3']);
  });

  it('the "main" part of speech is the one with the most senses, not necessarily the first listed', () => {
    const senses = [sense('noun', 'n1'), sense('verb', 'v1'), sense('verb', 'v2'), sense('verb', 'v3')];
    expect(selectSenses(senses, 4).map((s) => s.definition)).toEqual(['n1', 'v1', 'v2', 'v3']);
  });

  it('never returns more than max, and cuts by part-of-speech order when there are too many', () => {
    const senses = ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => sense(p, `${p}1`));
    expect(selectSenses(senses, 4).map((s) => s.pos)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('skips duplicate definitions', () => {
    const senses = [sense('verb', 'Same.'), sense('noun', 'same.'), sense('verb', 'Other.')];
    expect(selectSenses(senses, 4).map((s) => s.definition)).toEqual(['Same.', 'Other.']);
  });

  it('handles empty input and non-positive max', () => {
    expect(selectSenses([], 4)).toEqual([]);
    expect(selectSenses([sense('verb', 'x')], 0)).toEqual([]);
  });
});

describe('truncateDefinition / buildPrefixedQuery', () => {
  it('leaves short definitions alone and collapses whitespace', () => {
    expect(truncateDefinition('  a   b ', 160)).toBe('a b');
  });

  it('cuts at a word boundary without a dangling comma', () => {
    const out = truncateDefinition('one two three, four five six', 15);
    expect(out).toBe('one two three');
    expect(out.length).toBeLessThanOrEqual(15);
  });

  it('never exceeds the limit even without spaces', () => {
    expect(truncateDefinition('x'.repeat(500), 160)).toHaveLength(160);
  });

  it('builds "<word>: <definition>"', () => {
    expect(buildPrefixedQuery('run', 'To move quickly.', 160)).toBe('run: To move quickly.');
  });
});

describe('splitGloss', () => {
  it('splits at the FIRST colon and lowercases the gloss', () => {
    expect(splitGloss('Ngân hàng: Một tổ chức: nhận tiền gửi.', 'bank', false)).toEqual({
      gloss_vi: 'ngân hàng',
      definition_vi: 'Một tổ chức: nhận tiền gửi.',
    });
  });

  it('accepts the full-width colon', () => {
    expect(splitGloss('Chạy：Di chuyển nhanh.', 'run', false).gloss_vi).toBe('chạy');
  });

  it('without a separator there is no gloss and the whole text is the definition', () => {
    expect(splitGloss('Di chuyển nhanh bằng chân', 'run', false)).toEqual({ gloss_vi: null, definition_vi: 'Di chuyển nhanh bằng chân' });
  });

  it('does NOT split on a spaced dash (it appears inside definitions)', () => {
    expect(splitGloss('Một loại xe - chạy bằng điện', 'car', false)).toEqual({ gloss_vi: null, definition_vi: 'Một loại xe - chạy bằng điện' });
  });

  it('empty input gives nothing', () => {
    expect(splitGloss('   ', 'x', false)).toEqual({ gloss_vi: null, definition_vi: null });
  });

  it('drops an untranslated echo of the word unless keepEcho (loanwords)', () => {
    expect(splitGloss('Bank: Nghiêng máy bay.', 'bank', false).gloss_vi).toBeNull();
    expect(splitGloss('taxi: Xe chở khách.', 'taxi', true).gloss_vi).toBe('taxi');
  });
});

describe('cleanGloss', () => {
  it.each([
    ['', null],
    ['   ', null],
    ['"con dơi"', 'con dơi'],
    ['một hai ba bốn năm', 'một hai ba bốn năm'], // 5 words: allowed
    ['một hai ba bốn năm sáu', null], // 6 words: dropped
    ['x'.repeat(41), null],
    ['x'.repeat(40), 'x'.repeat(40)],
    ['Ánh sáng', 'ánh sáng'],
  ])('%j → %j', (raw, expected) => {
    expect(cleanGloss(raw, 'something', false)).toBe(expected);
  });
});

describe('meanings de-duplication', () => {
  it('ignores case and a leading classifier word', () => {
    expect(meaningKey('Con dơi')).toBe(meaningKey('dơi'));
    expect(meaningKey('cuộc thi đấu')).not.toBe(meaningKey('trận đấu'));
    expect(meaningKey('con')).toBe('con'); // a lone classifier is kept
  });

  it('keeps the first occurrence, drops empties/non-strings, and cuts to max', () => {
    expect(dedupeMeanings(['con dơi', 'dơi', ' ', null, undefined, 'Đánh bóng', 'đánh bóng', 'gậy', 'extra'], 4)).toEqual(['con dơi', 'Đánh bóng', 'gậy', 'extra']);
    expect(dedupeMeanings(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
});

// Real answers captured from Google on 2026-10-13 (docs/lookup-multimeaning-experiment.md)
describe('real Google answers (tests/fixtures/lookup/google-prefix)', () => {
  const dir = path.resolve(__dirname, '../fixtures/lookup/google-prefix');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const load = (word: string) => JSON.parse(fs.readFileSync(path.join(dir, `${word}.json`), 'utf8'));

  it('has all twelve words', () => {
    expect(files).toHaveLength(12);
  });

  it('every one of the 44 answers can be split at ":" into a usable gloss or a dropped gloss', () => {
    let answers = 0;
    for (const file of files) {
      const d = load(file.replace('.json', ''));
      const keepEcho = String(d.headline).trim().toLowerCase() === d.word;
      d.translations.forEach((t: string) => {
        answers++;
        const r = splitGloss(t, d.word, keepEcho);
        expect(r.definition_vi).toBeTruthy(); // the colon was kept by Google every time
        if (r.gloss_vi) {
          expect(r.gloss_vi.length).toBeLessThanOrEqual(40);
          expect(r.gloss_vi).toBe(r.gloss_vi.charAt(0).toLocaleLowerCase('vi') + r.gloss_vi.slice(1));
        }
      });
    }
    expect(answers).toBe(44);
  });

  it.each([
    ['spring', ['mùa xuân', 'nhảy', 'lò xo', 'suối']],
    ['light', ['ánh sáng', 'đốt lửa', 'nhẹ']],
    ['bank', ['ngân hàng', 'bờ']], // the verb sense came back as the untranslated "Bank" and is dropped
    ['bat', ['con dơi', 'đánh bóng', 'gậy bóng chày']], // "dơi" is a duplicate of "con dơi"
    ['fair', ['hội chợ', 'công bằng', 'khá']], // the colour sense came back as untranslated "fair"
    ['address', ['địa chỉ']], // Google glosses every sense "địa chỉ": a known limitation
  ])('%s → meanings_vi', (word, expected) => {
    const d = load(word);
    const keepEcho = String(d.headline).trim().toLowerCase() === word;
    const glosses = d.translations.map((t: string) => splitGloss(t, word, keepEcho).gloss_vi);
    const lowerFirst = (s: string) => s.charAt(0).toLocaleLowerCase('vi') + s.slice(1);
    expect(dedupeMeanings([lowerFirst(d.headline), ...glosses], 4)).toEqual(expected);
  });
});
