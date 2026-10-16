import {
  LOOKUP_ADMIN_READ_ROLES,
  LOOKUP_ADMIN_WRITE_ROLES,
  MAX_BULK_PUBLISH,
  MAX_WORDS_PER_REQUEST,
  RETRYABLE_REASONS,
  breakerLevel,
  canWriteLookupAdmin,
  flagMeanings,
  retryBlock,
  splitMeanings,
  tierAMissing,
  toWordList,
  usageLevel,
  type TierAFacts,
} from '../../services/lookup/adminRules';
import { isAutoNote, parseAutoNote } from '../../utils/autoEntryNote';
import { lk } from '../../utils/lookupAdminView';

// Notes written by the real job (dev database, 15/10/2026), shortened where the text was long.
const NOTE_WITH_NOTES =
  "[auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: d159f451-d6db-4b50-b2be-e6a51845b07e · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · thiếu tầng B: ipa, etymology · ước tính: cefr_level=C1 · ghi chú của Haiku: Nghĩa 'chắt rượu' thuộc chuyên ngành. | cefr_level ước tính C1 dựa trên zipf thấp; cần kiểm tra lại. | [kiểm tra] senses[2].definition_en dùng lại chính từ đang định nghĩa";
const NOTE_UNTAGGED =
  '[auto] nguồn: wiktionary, haiku · model: claude-haiku-5-5 · job: c0f17b90 · published=true (ENRICHMENT_PUBLISH_POLICY=auto) · ước tính: cefr_level=C1 · [ipa-untagged] ipa_us lấy từ IPA đầu tiên không gắn thẻ giọng của Wiktionary, không rõ giọng · ghi chú của Haiku: Chưa chắc is_countable.';

describe('roles (docs/lookup-spec.md §12.6)', () => {
  it('everybody reads; only super_admin and content_editor write', () => {
    expect([...LOOKUP_ADMIN_READ_ROLES].sort()).toEqual(['content_editor', 'moderator', 'super_admin']);
    expect([...LOOKUP_ADMIN_WRITE_ROLES].sort()).toEqual(['content_editor', 'super_admin']);
    expect(canWriteLookupAdmin('super_admin')).toBe(true);
    expect(canWriteLookupAdmin('content_editor')).toBe(true);
    expect(canWriteLookupAdmin('moderator')).toBe(false);
    expect(canWriteLookupAdmin(undefined)).toBe(false);
    expect(canWriteLookupAdmin('root')).toBe(false);
  });
});

describe('retryBlock', () => {
  it.each(RETRYABLE_REASONS.flatMap((r) => [['failed', r], ['skipped', r]] as const))('%s / %s may be sent again', (status, reason) => {
    expect(retryBlock({ status, reason }, false)).toBeNull();
  });

  it('lists exactly the reasons of the spec', () => {
    expect([...RETRYABLE_REASONS].sort()).toEqual(['budget', 'daily_cap', 'dead_letter', 'queue_error', 'stale', 'upstream_error']);
  });

  it.each([
    ['succeeded', null],
    ['succeeded', 'form_linked'],
    ['rejected', 'proper_noun'],
    ['queued', 'upstream_error'],
    ['running', null],
    ['failed', 'invalid_output'],
    ['failed', 'config_error'],
    ['failed', null],
    ['skipped', 'exists'],
    ['skipped', 'variant_form'],
    ['skipped', null],
  ])('%s / %s is refused as not retryable', (status, reason) => {
    expect(retryBlock({ status, reason }, false)).toBe('status_not_retryable');
  });

  it('a queued / running row for the same word blocks the retry', () => {
    expect(retryBlock({ status: 'failed', reason: 'upstream_error' }, true)).toBe('word_active');
  });
});

describe('toWordList', () => {
  it('splits lines, trims, drops blank lines', () => {
    expect(toWordList('  ubiquitous \r\n\r\nserendipity\n   \nephemeral')).toEqual(['ubiquitous', 'serendipity', 'ephemeral']);
  });
  it('takes an array as it is, trimmed', () => {
    expect(toWordList([' a ', '', 'b', 3, null])).toEqual(['a', 'b']);
  });
  it('anything else is empty', () => {
    expect(toWordList(undefined)).toEqual([]);
    expect(toWordList(42)).toEqual([]);
    expect(toWordList({})).toEqual([]);
  });
  it('has the limits of the task', () => {
    expect(MAX_WORDS_PER_REQUEST).toBe(50);
    expect(MAX_BULK_PUBLISH).toBe(100);
  });
});

describe('tier A (docs/lookup-spec.md §3)', () => {
  const full: TierAFacts = { headword: 'run', lemma: 'run', pos: ['verb'], meaning_vi: 'chạy', complete_senses: 1, complete_examples: 1 };

  it('complete entry: nothing missing', () => {
    expect(tierAMissing(full)).toEqual([]);
  });

  it.each([
    [{ headword: '  ' }, 'headword'],
    [{ lemma: null }, 'lemma'],
    [{ pos: [] }, 'pos'],
    [{ pos: null }, 'pos'],
    [{ meaning_vi: ' ' }, 'meaning_vi'],
    [{ complete_senses: 0 }, 'sense (definition_en và definition_vi)'],
    [{ complete_examples: 0 }, 'ví dụ (example_en và example_vi)'],
  ] as Array<[Partial<TierAFacts>, string]>)('%j → missing %s', (patch, label) => {
    expect(tierAMissing({ ...full, ...patch })).toEqual([label]);
  });

  it('reports every missing field, in the order the job writes them', () => {
    expect(tierAMissing({ headword: 'x', lemma: 'x', pos: [], meaning_vi: '', complete_senses: 0, complete_examples: 0 })).toEqual([
      'pos',
      'meaning_vi',
      'sense (definition_en và definition_vi)',
      'ví dụ (example_en và example_vi)',
    ]);
  });
});

describe('meanings of a sense', () => {
  it("splits definition_vi at '; '", () => {
    expect(splitMeanings('nốt ruồi; chuột chũi;  đê chắn sóng ;')).toEqual(['nốt ruồi', 'chuột chũi', 'đê chắn sóng']);
    expect(splitMeanings('')).toEqual([]);
    expect(splitMeanings(null)).toEqual([]);
    expect(splitMeanings('một nghĩa')).toEqual(['một nghĩa']);
  });

  it('flags a meaning longer than the writer was allowed to write (40 characters or 6 syllables)', () => {
    const [ok, longChars, longWords] = flagMeanings(['chạy', 'x'.repeat(41), 'một hai ba bốn năm sáu bảy'], []);
    expect(ok).toMatchObject({ too_long: false, in_review_notes: false });
    expect(longChars.too_long).toBe(true);
    expect(longWords.too_long).toBe(true);
    expect(flagMeanings(['x'.repeat(40)], [])[0].too_long).toBe(false);
    expect(flagMeanings(['một hai ba bốn năm sáu'], [])[0].too_long).toBe(false);
  });

  it('flags a meaning that a note for review mentions (ignoring case and spacing)', () => {
    const notes = ["Nghĩa 'Chắt  rượu' thuộc chuyên ngành.", 'cần kiểm tra lại'];
    const [a, b] = flagMeanings(['chắt rượu', 'chạy'], notes);
    expect(a.in_review_notes).toBe(true);
    expect(b.in_review_notes).toBe(false);
  });

  it('does not flag anything when there are no notes', () => {
    expect(flagMeanings(['chạy'], [])[0].in_review_notes).toBe(false);
  });
});

describe('usage meters', () => {
  it('turns to warning at 80 percent and critical at 100 percent', () => {
    expect(usageLevel(0, 100)).toBe('ok');
    expect(usageLevel(79, 100)).toBe('ok');
    expect(usageLevel(80, 100)).toBe('warn');
    expect(usageLevel(99, 100)).toBe('warn');
    expect(usageLevel(100, 100)).toBe('critical');
    expect(usageLevel(450_001, 450_000)).toBe('critical');
  });
  it('has no opinion without a usable limit', () => {
    expect(usageLevel(5, 0)).toBe('unknown');
    expect(usageLevel(null, 10)).toBe('unknown');
    expect(usageLevel(5, undefined)).toBe('unknown');
    expect(usageLevel(NaN, 10)).toBe('unknown');
  });
  it('breaker states', () => {
    expect(breakerLevel('closed')).toBe('ok');
    expect(breakerLevel('half_open')).toBe('warn');
    expect(breakerLevel('open')).toBe('critical');
    expect(breakerLevel(undefined)).toBe('ok');
  });
});

describe('parseAutoNote', () => {
  it('reads the parts of a note written by the job', () => {
    const n = parseAutoNote(NOTE_WITH_NOTES);
    expect(n.is_auto).toBe(true);
    expect(n.sources).toEqual(['wiktionary', 'ref_word_frequency', 'datamuse (chỉ là ứng viên của Haiku)', 'haiku']);
    expect(n.model).toBe('claude-haiku-5-5');
    expect(n.job_id).toBe('d159f451-d6db-4b50-b2be-e6a51845b07e');
    expect(n.publish_note).toBe('published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review)');
    expect(n.tier_a_missing).toEqual([]);
    expect(n.tier_b_missing).toEqual(['ipa', 'etymology']);
    expect(n.estimated).toEqual(['cefr_level=C1']);
    expect(n.review_notes).toEqual([
      "Nghĩa 'chắt rượu' thuộc chuyên ngành.",
      'cefr_level ước tính C1 dựa trên zipf thấp; cần kiểm tra lại.',
      '[kiểm tra] senses[2].definition_en dùng lại chính từ đang định nghĩa',
    ]);
    expect(n.other).toEqual([]);
  });

  it('reads tier A missing', () => {
    const n = parseAutoNote('[auto] nguồn: haiku · model: m · job: j · published=false: thiếu tầng A · thiếu tầng A: pos, ví dụ (example_en và example_vi)');
    expect(n.tier_a_missing).toEqual(['pos', 'ví dụ (example_en và example_vi)']);
    expect(n.review_notes).toEqual([]);
  });

  it('a note part before the notes of Haiku (the untagged IPA mark) is not a review note', () => {
    const n = parseAutoNote(NOTE_UNTAGGED);
    expect(n.review_notes).toEqual(['Chưa chắc is_countable.']);
    expect(n.other.map((o) => o.startsWith('[ipa-untagged]'))).toEqual([true]);
  });

  it('a part appended AFTER the notes (the IPA backfill does that) is not swallowed by the notes', () => {
    const n = parseAutoNote(`${NOTE_WITH_NOTES} · [ipa-untagged] ipa_us lấy từ IPA đầu tiên không gắn thẻ giọng của Wiktionary, không rõ giọng`);
    expect(n.review_notes).toHaveLength(3);
    expect(n.other).toHaveLength(1);
  });

  it('a note of Haiku that contains the separator stays in one piece', () => {
    const n = parseAutoNote('[auto] nguồn: haiku · ghi chú của Haiku: nghĩa A · nghĩa B hiếm | nghĩa C');
    expect(n.review_notes).toEqual(['nghĩa A · nghĩa B hiếm', 'nghĩa C']);
  });

  it('keeps what it does not know in `other`, and survives garbage', () => {
    expect(parseAutoNote('[auto] một thứ lạ · nguồn: haiku').other).toEqual(['một thứ lạ']);
    expect(parseAutoNote('[auto]').review_notes).toEqual([]);
    expect(parseAutoNote(null).is_auto).toBe(false);
    expect(parseAutoNote('ghi chú tay của admin').is_auto).toBe(false);
    expect(isAutoNote('[auto] x')).toBe(true);
    expect(isAutoNote(' [auto] x')).toBe(false);
    expect(isAutoNote(undefined)).toBe(false);
  });
});

describe('view helpers', () => {
  it('formats dates in Vietnam time and numbers with dots', () => {
    expect(lk.date('2026-10-15T16:43:29.000Z')).toBe('15/10/2026 23:43');
    expect(lk.date('2026-10-15T18:00:00.000Z')).toBe('16/10/2026 01:00');
    expect(lk.date(null)).toBe('—');
    expect(lk.date('garbage')).toBe('—');
    expect(lk.num(1234567)).toBe('1.234.567');
    expect(lk.num('450000')).toBe('450.000');
    expect(lk.num(null)).toBe('—');
    expect(lk.percent(80, 100)).toBe('80%');
    expect(lk.percent(1, 0)).toBe('—');
  });

  it('has a Vietnamese label for every status and every reason the job writes', () => {
    for (const s of ['queued', 'running', 'succeeded', 'rejected', 'failed', 'skipped']) expect(lk.statusLabel(s)).not.toBe(s);
    for (const r of ['form_linked', 'exists', 'variant_form', 'lemma_mismatch', 'budget', 'daily_cap', 'duplicate', 'unknown_word', 'proper_noun', 'not_english', 'invalid_output', 'config_error', 'upstream_error', 'dead_letter', 'stale', 'queue_error', 'invalid_word']) {
      expect(lk.reasonLabel(r)).not.toBe(r);
      expect(lk.reasonCodes).toContain(r);
    }
    expect(lk.reasonLabel(null)).toBe('');
    expect(lk.reasonLabel('something_new')).toBe('something_new');
  });
});
