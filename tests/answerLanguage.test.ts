import { looksVietnamese, stripDiacritics } from '../utils/answerLanguage';

describe('looksVietnamese', () => {
  it.each([
    'màu nâu', // the case that was wrongly accepted: only plain grave / circumflex marks, in every word
    'nâu',
    'có màu nâu',
    'Màu Nâu',
    'MÀU NÂU',
    'màu xanh', // a single weak-mark word plus one plain one is 50 %
    'đất', // strong letter
    'một loại quả',
    'cái dùng để thử; vật mẫu',
    'vật mẫu',
    'thân thiện',
    'ý nghĩa',
    'maù nâu'.normalize('NFD'), // typed with combining marks (NFD) is the same text
  ])('flags Vietnamese: %s', (text) => {
    expect(looksVietnamese(text)).toBe(true);
  });

  it.each([
    'having the colour of earth, wood, or coffee',
    'the colour brown',
    'brown',
    'a thing used in a test',
    'a small café on the corner', // one loanword among six words
    'café',
    'résumé',
    'a short summary, or résumé, of your career',
    'a French à la carte menu',
    'fiancée',
    'naïve',
    'jalapeño pepper',
    'über-cool',
    "o'clock",
    'full-time',
    '',
    '   ',
  ])('does not flag English: %s', (text) => {
    expect(looksVietnamese(text)).toBe(false);
  });

  it('copes with null and undefined', () => {
    expect(looksVietnamese(null)).toBe(false);
    expect(looksVietnamese(undefined)).toBe(false);
  });
});

describe('stripDiacritics', () => {
  it.each([
    ['màu nâu', 'mau nau'],
    ['Đất đai', 'Dat dai'],
    ['cái dùng để thử', 'cai dung de thu'],
    ['ĐƯỜNG', 'DUONG'],
    ['plain', 'plain'],
    ['maù nâu'.normalize('NFD'), 'mau nau'],
  ])('%s → %s', (input, expected) => {
    expect(stripDiacritics(input)).toBe(expected);
  });

  it('copes with null and undefined', () => {
    expect(stripDiacritics(null)).toBe('');
    expect(stripDiacritics(undefined)).toBe('');
  });
});
