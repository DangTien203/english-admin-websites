import {
  buildAnswerCandidates,
  matchVietnameseAnswer,
} from '../utils/answerMatcher';
import { normalizeVietnameseAnswer } from '../utils/answerNormalizer';

describe('Vietnamese answer matcher', () => {
  it('accepts any comma-separated expected answer', () => {
    const candidates = buildAnswerCandidates({ meaningVi: 'đến, tới' });

    expect(matchVietnameseAnswer('đến', candidates)).toMatchObject({
      matched: true,
      grading_source: 'exact',
      matched_answer: 'đến',
    });
    expect(matchVietnameseAnswer('tới', candidates)).toMatchObject({
      matched: true,
      grading_source: 'exact',
      matched_answer: 'tới',
    });
  });

  it('normalizes Vietnamese unicode, casing, punctuation, and spaces', () => {
    const candidates = buildAnswerCandidates({ meaningVi: 'Đến, tới' });

    expect(normalizeVietnameseAnswer('  TỚI.  ')).toBe('tới');
    expect(matchVietnameseAnswer('  TỚI.  ', candidates).matched).toBe(true);
  });

  it('accepts the core answer when the expected answer has a parenthetical note', () => {
    const candidates = buildAnswerCandidates({
      meaningVi: 'và (nối từ, cụm từ, mệnh đề)',
    });

    expect(candidates.map((candidate) => candidate.text)).toEqual(['và']);
    expect(matchVietnameseAnswer('và', candidates)).toMatchObject({
      matched: true,
      grading_source: 'exact',
      matched_answer: 'và',
    });
  });

  it('uses active aliases as deterministic matches', () => {
    const candidates = buildAnswerCandidates({
      meaningVi: 'trẻ em, đứa trẻ',
      aliases: ['trẻ con'],
    });

    expect(matchVietnameseAnswer('trẻ con', candidates)).toMatchObject({
      matched: true,
      grading_source: 'alias',
      matched_answer: 'trẻ con',
    });
  });

  it('does not over-accept related but unlisted meanings', () => {
    const candidates = buildAnswerCandidates({
      meaningVi: 'trẻ em, đứa trẻ',
    });

    expect(matchVietnameseAnswer('trẻ con', candidates)).toMatchObject({
      matched: false,
      grading_source: 'deterministic_miss',
    });
  });
});
