import {
  EXAMPLE_VI_MAX_CHARS,
  SENSE_MEANING_MAX_CHARS,
  SENSE_VI_MAX_CHARS,
  SENSE_VI_MAX_MEANINGS,
  canChangePublished,
  cleanText,
  exampleHistoryField,
  senseHistoryField,
  validateExampleVi,
  validateSenseDefinitionVi,
} from '../../services/lookup/adminRules';
import { historyField } from '../../utils/lookupAdminView';

/** The rules for what an admin may save as the Vietnamese of a sense (P9). Pure. */

describe('cleanText', () => {
  it('trims, collapses every run of white space (new lines and tabs too) into one space', () => {
    expect(cleanText('  xin   chào\n\tbạn  ')).toBe('xin chào bạn');
  });

  it('removes control, zero-width and bidirectional-override characters, but keeps Vietnamese letters', () => {
    expect(cleanText('ng\u200Bhĩa\u0000 \u202Ecủa\u0007 từ\uFEFF')).toBe('nghĩa của từ');
  });

  it('puts the text in NFC (a decomposed "ệ" and a composed one are the same text)', () => {
    const decomposed = 'e\u0323\u0302'; // e + dot below + circumflex (three code points: ệ)
    expect(cleanText(decomposed)).toBe('\u1EC7');
    expect(cleanText(decomposed).length).toBe(1);
  });
});

describe('validateSenseDefinitionVi', () => {
  const ok = (input: unknown) => {
    const r = validateSenseDefinitionVi(input);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    return r.value as { value: string; meanings: string[] };
  };
  const bad = (input: unknown) => {
    const r = validateSenseDefinitionVi(input);
    expect(r.ok).toBe(false);
    return r.error as string;
  };

  it('stores the meanings joined with "; " (spec §9.8)', () => {
    expect(ok('chạy;  vận hành ; điều hành').value).toBe('chạy; vận hành; điều hành');
    expect(ok('một nghĩa').meanings).toEqual(['một nghĩa']);
  });

  it('drops empty and repeated meanings (repeats are compared without regard to case)', () => {
    expect(ok(' a ;; b ; A ;').value).toBe('a; b');
  });

  it('refuses an empty text, or one that is only separators and spaces', () => {
    expect(bad('')).toMatch(/không được để trống/);
    expect(bad('  ;  ; ')).toMatch(/không được để trống/);
  });

  it('refuses what is not a string', () => {
    for (const v of [undefined, null, 5, ['a'], { a: 1 }]) expect(bad(v)).toMatch(/phải là chuỗi/);
  });

  it('refuses < and > (no meaning needs them, and they are how markup starts)', () => {
    expect(bad('chạy <b>nhanh</b>')).toMatch(/< hoặc >/);
    expect(bad('a > b')).toMatch(/< hoặc >/);
  });

  it(`refuses a meaning longer than ${SENSE_MEANING_MAX_CHARS} characters and says which one`, () => {
    expect(ok(`ngắn; ${'a'.repeat(SENSE_MEANING_MAX_CHARS)}`).meanings).toHaveLength(2);
    expect(bad(`ngắn; ${'a'.repeat(SENSE_MEANING_MAX_CHARS + 1)}`)).toMatch(/nghĩa thứ 2 dài 101/);
  });

  it(`refuses more than ${SENSE_VI_MAX_MEANINGS} meanings`, () => {
    const eight = Array.from({ length: SENSE_VI_MAX_MEANINGS }, (_, i) => `nghĩa ${String.fromCharCode(97 + i)}`).join('; ');
    expect(ok(eight).meanings).toHaveLength(SENSE_VI_MAX_MEANINGS);
    expect(bad(`${eight}; nghĩa z`)).toMatch(/Tối đa 8 nghĩa/);
  });

  it(`refuses more than ${SENSE_VI_MAX_CHARS} characters in all`, () => {
    const meanings = Array.from({ length: 4 }, (_, i) => String.fromCharCode(97 + i).repeat(90)).join('; '); // 4 × 90 + 3 × 2 = 366
    expect(meanings.length).toBeGreaterThan(SENSE_VI_MAX_CHARS);
    expect(bad(meanings)).toMatch(/Tổng cộng tối đa 300/);
  });

  it('cleans before it checks: invisible characters and new lines do not count or get stored', () => {
    expect(ok('chạy\u200B\nnhanh;\tvội').value).toBe('chạy nhanh; vội');
  });
});

describe('validateExampleVi', () => {
  it('returns the cleaned translation', () => {
    expect(validateExampleVi('  Cô ấy   có một nốt ruồi. ')).toEqual({ ok: true, value: 'Cô ấy có một nốt ruồi.' });
  });

  it('refuses empty, non-string, markup and too long', () => {
    expect(validateExampleVi('   ').ok).toBe(false);
    expect(validateExampleVi(null).ok).toBe(false);
    expect(validateExampleVi('<script>').ok).toBe(false);
    expect(validateExampleVi('x'.repeat(EXAMPLE_VI_MAX_CHARS + 1)).error).toMatch(/tối đa 500/);
    expect(validateExampleVi('x'.repeat(EXAMPLE_VI_MAX_CHARS)).ok).toBe(true);
  });
});

describe('who may change `published`', () => {
  it('super_admin and content_editor may; a moderator, an unknown role and nobody may not', () => {
    expect(canChangePublished('super_admin')).toBe(true);
    expect(canChangePublished('content_editor')).toBe(true);
    for (const role of ['moderator', 'user', '', undefined, null]) expect(canChangePublished(role as any)).toBe(false);
  });
});

describe('the history lines of a sense', () => {
  const sense = '0123abcd-4567-89ab-cdef-0123456789ab';
  const example = 'fedc4321-ba98-7654-3210-fedcba987654';

  it('name the sense, and fit the VARCHAR(100) column of entry_edit_history', () => {
    expect(senseHistoryField(sense)).toBe(`sense:${sense}:definition_vi`);
    expect(exampleHistoryField(sense, example)).toBe(`sense:${sense}:example_vi:${example}`);
    expect(senseHistoryField(sense).length).toBeLessThanOrEqual(100);
    expect(exampleHistoryField(sense, example).length).toBeLessThanOrEqual(100);
  });

  it('are shown in words by the page, with the first 8 characters of the id, and other fields are shown as they are', () => {
    expect(historyField(senseHistoryField(sense))).toBe('nghĩa tiếng Việt của sense …0123abcd');
    expect(historyField(exampleHistoryField(sense, example))).toBe('dịch ví dụ của sense …0123abcd');
    expect(historyField('published')).toBe('published');
    expect(historyField(null)).toBe('');
  });
});
