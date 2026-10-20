import {
  BLOCKING_REVIEW_NOTE_CATEGORIES,
  REVIEW_NOTE_CATEGORIES,
  blockingReviewNotes,
  classifyReviewNote,
  classifyReviewNotes,
  foldNote,
  hasBlockingReviewNote,
  type ReviewNoteCategoryId,
} from '../../services/lookup/reviewNotes';

/**
 * The rule that decides which notes of Haiku hold an entry back from the bulk publish (docs/lookup-admin.md §3.4). Pure.
 * The notes below are REAL ones, copied from the 41 entries made by the job on the dev database (16/10/2026).
 */
const category = (note: string): ReviewNoteCategoryId => classifyReviewNote(note).category;

describe('the table of categories', () => {
  it('has one row per id, each with a label and a description', () => {
    const ids = REVIEW_NOTE_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of REVIEW_NOTE_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(3);
      expect(c.description.length).toBeGreaterThan(10);
    }
  });

  it('BLOCKING_REVIEW_NOTE_CATEGORIES is exactly the rows marked `blocks`', () => {
    expect([...BLOCKING_REVIEW_NOTE_CATEGORIES].sort()).toEqual(REVIEW_NOTE_CATEGORIES.filter((c) => c.blocks).map((c) => c.id).sort());
  });

  it('the "cần xem" groups of the brief block: doubt about a meaning, sensitive words, proper nouns, and what nobody recognises', () => {
    for (const id of ['meaning_doubt', 'sensitive', 'proper_noun', 'other', 'validator_flag'] as const) expect(BLOCKING_REVIEW_NOTE_CATEGORIES).toContain(id);
  });

  it('the light groups do not block: how a word is used, a CEFR estimate, a sense left out, merged, a suggestion', () => {
    for (const id of ['usage_check', 'cefr_estimate', 'omitted_sense', 'merged_sense', 'suggestion', 'source_data', 'kept_decision', 'validator_tag_dropped'] as const) {
      expect(BLOCKING_REVIEW_NOTE_CATEGORIES).not.toContain(id);
    }
  });
});

describe('notes that BLOCK (cần xem)', () => {
  it.each([
    ["Nghĩa 'quát tháo' của động từ được rút ra từ nghĩa figuratively trong dữ liệu, cần kiểm tra lại."],
    ["Nghĩa danh từ 'an abrupt loud vocal utterance' chưa lập riêng vì trùng với nghĩa tiếng sủa, cần xem lại."],
    ["Nghĩa 'phố' và 'dãy nhà' có thể gộp, cần kiểm tra lại."],
    ["Nghĩa 'lò xo' (metal coil) không có trong dữ liệu Wiktionary cung cấp; đã bổ sung từ kiến thức chung, cần kiểm tra lại."],
    ["Nghĩa 'mạch nước' xuất phát từ tên gọi 'spring' trong nguồn nhưng không có ví dụ; cần xác nhận."],
    ["Nghĩa 'trình bày ý tưởng, chào hàng' (sales pitch, to pitch an idea) rất phổ biến nhưng không có trong dữ liệu nguồn; cần bổ sung."],
    ["Nghĩa địa lý (ephemeral lakes/streams) lấy từ dữ liệu Wiktionary; cần kiểm tra thuật ngữ tiếng Việt thường dùng."],
    ["Nghĩa 'bảng' (chart/grid) thuộc nghĩa danh từ riêng, cần kiểm tra lại thứ tự ưu tiên."],
  ])('doubt about a meaning: %s', (note) => {
    const c = classifyReviewNote(note);
    expect([c.category, c.blocks]).toEqual(['meaning_doubt', true]);
  });

  it('the job\'s own checker: "[kiểm tra] … dùng lại chính từ đang định nghĩa" blocks', () => {
    const c = classifyReviewNote('[kiểm tra] senses[2].definition_en dùng lại chính từ đang định nghĩa');
    expect([c.category, c.blocks]).toEqual(['validator_flag', true]);
  });

  it('a note about a sensitive sense blocks, even one that says it was left out', () => {
    expect(category("Nghĩa 'bisexual' và nghĩa lịch sử về phái Cathar bị bỏ qua vì hiếm và không phù hợp người học.")).toBe('sensitive');
    expect(category('Từ này có nghĩa thô tục trong tiếng lóng.')).toBe('sensitive');
    expect(category('Offensive in some regions, vulgar slang.')).toBe('sensitive');
  });

  it('a proper noun that is NOT said to be left out blocks', () => {
    const c = classifyReviewNote('Từ này có thể là tên riêng (họ người).');
    expect([c.category, c.blocks]).toEqual(['proper_noun', true]);
  });

  it('a note nobody recognises blocks: an unknown note is read by a person', () => {
    const c = classifyReviewNote('Haiku ghi một điều chưa từng thấy ở đây.');
    expect([c.category, c.blocks]).toEqual(['other', true]);
    expect(classifyReviewNote('').blocks).toBe(true);
  });
});

describe('notes that do NOT block (lưu ý nhẹ)', () => {
  it.each([
    ['cefr_level ước tính B2 dựa trên zipf 3.85 và rank 8895; chưa chắc chắn.', 'cefr_estimate'],
    ['Mức CEFR C1 ước tính từ tần suất thấp (zipf 3.56); cần xem lại.', 'cefr_estimate'],
    ['Ước tính B2 dựa trên tần suất thấp (zipf 3.64) nhưng đây là từ chuyên ngành y tế được dùng nhiều trong thời sự.', 'cefr_estimate'],
    ['Ước lượng CEFR C1 dựa trên tần suất thấp (zipf 3.53); nên xem lại vì nghĩa cờ vua phổ biến hơn nhiều.', 'cefr_estimate'],
    ["Nghĩa 'cây cỏ' như Peruvian bark (vỏ canhkina) và nghĩa 'thuyền buồm' (lỗi thời) đã được bỏ qua.", 'omitted_sense'],
    ["Nghĩa 'đất sét bùn' rất hiếm và chuyên ngành nên không đưa vào.", 'omitted_sense'],
    ["Họ riêng Crane và tên sông không đưa vào vì không thuộc nội dung từ điển từ vựng thông dụng.", 'omitted_sense'],
    ["Chỉ 'mole' là tên sông; không lập mục tên riêng.", 'omitted_sense'],
    ["Bỏ nghĩa 'động tác kéo tập gym' do chưa chắc chắn về ví dụ và cách dịch chuẩn.", 'omitted_sense'],
    ['Nghĩa bóng (isolate, restrict) chưa đưa vào để giữ mục từ gọn; có thể bổ sung nếu cần.', 'omitted_sense'],
    ["Nghĩa 'cờ vây' (Go, trò chơi) và tên riêng ngôn ngữ lập trình Go chưa được đưa vào sense vì bài này tập trung vào từ go thông dụng; cần xem lại nếu muốn lập mục riêng.", 'omitted_sense'],
    ["Nghĩa 'then cửa' và 'chốt cửa' gần nhau, đã gộp hợp lý.", 'merged_sense'],
    ["Nghĩa 'pertaining to a flock or crowd' bị gộp vào nghĩa về loài vật sống bầy đàn.", 'merged_sense'],
    ['Datamuse không cung cấp antonym; antonyms lấy từ Wiktionary.', 'source_data'],
    ["Dữ liệu nguồn thiếu ví dụ cho nghĩa 'bảng' và 'tabulate'; ví dụ đã tự viết.", 'source_data'],
    ["Nghĩa 'trong suốt' (sense 3) là nghĩa văn chương, hiếm; cân nhắc giữ hoặc bỏ.", 'omitted_sense'],
    ["Datamuse không cung cấp antonyms; cần bổ sung trái nghĩa như 'confused' hoặc 'incoherent' nếu muốn.", 'suggestion'],
    ['Chưa xác định chắc is_countable cho nghĩa cầm cố (dữ liệu ghi uncountable); đã đặt true theo nghĩa quân cờ.', 'usage_check'],
    ['Wiktionary ghi cả nghĩa ngoại động và nội động cho động từ; đã đánh dấu is_transitive là true theo nghĩa phổ biến nhất, cần kiểm tra lại.', 'usage_check'],
    ["Nghĩa 'trại chó hoang' được ghi nhận là chủ yếu ở Anh; cần xác nhận cách dùng ở Mỹ (animal shelter/pound).", 'usage_check'],
    ["Nghĩa 'đồ ăn' (food served) được xếp vào mức formal, cần xác nhận lại.", 'usage_check'],
    ["Nghĩa động từ 'đưa ra thảo luận' và 'hoãn lại' khác nhau theo vùng (Anh/Mỹ), đã ghi trong usage_note.", 'usage_check'],
    ['Chủ đề psychology_mind được chọn dựa trên tính chất trừu tượng của từ, cần kiểm tra lại.', 'usage_check'],
    ["Nghĩa mol (đơn vị đo lượng chất) là thuật ngữ khoa học; đã giữ vì thường gặp trong học tập.", 'kept_decision'],
    ['Chỉ một nghĩa vì từ chỉ có một cách hiểu chính trong tiếng Việt.', 'kept_decision'],
    ['[kiểm tra] bỏ academic_formal: chỉ dành cho từ trừu tượng trình độ C1 hoặc C2 không hợp chủ đề nào khác', 'validator_tag_dropped'],
  ] as Array<[string, ReviewNoteCategoryId]>)('%s', (note, expected) => {
    const c = classifyReviewNote(note);
    expect([c.category, c.blocks]).toEqual([expected, false]);
  });
});

describe('the order of the tests', () => {
  it('a CEFR estimate stays light even when it says "cần xem lại" or "chưa chắc chắn" (every CEFR level is an estimate)', () => {
    expect(classifyReviewNote('CEFR C1 ước tính từ zipf thấp (3.02) và rank lớn; cần xem lại.').blocks).toBe(false);
    expect(classifyReviewNote('cefr_level B2 ước tính, chưa chắc chắn.').blocks).toBe(false);
  });

  it('"bỏ" (to leave out) is told from "bổ" (as in bổ sung) by its accent: "cần bổ sung" is a request, "đã bỏ" is not', () => {
    expect(classifyReviewNote('Nghĩa A rất phổ biến nhưng thiếu; cần bổ sung.').blocks).toBe(true);
    expect(classifyReviewNote('Nghĩa A rất hiếm nên đã bỏ.').blocks).toBe(false);
  });

  it('"… nếu muốn" is an offer, not a doubt', () => {
    expect(classifyReviewNote('Có thể thêm nghĩa B, cần xem lại nếu muốn lập mục riêng.').blocks).toBe(false);
    expect(classifyReviewNote('Nghĩa B có vẻ sai, cần xem lại.').blocks).toBe(true);
  });

  it('a thing left out for being unsure is left out (nothing in the entry to doubt); a thing KEPT while unsure is a doubt', () => {
    expect(classifyReviewNote("Bỏ nghĩa 'x' do chưa chắc chắn về cách dịch.").blocks).toBe(false);
    expect(classifyReviewNote("Nghĩa 'x' được giữ nhưng chưa chắc chắn về cách dịch.").blocks).toBe(true);
  });

  it('a doubt about HOW a word is used is light, about WHAT it means blocks', () => {
    expect(classifyReviewNote('is_transitive đặt true, cần kiểm tra lại.').blocks).toBe(false);
    expect(classifyReviewNote("Nghĩa 'x' cần kiểm tra lại.").blocks).toBe(true);
  });

  it('accents and case do not matter', () => {
    expect(foldNote('Nghĩa ĐÃ BỎ')).toBe('nghia da bo');
    expect(classifyReviewNote('NGHĨA RẤT HIẾM NÊN ĐÃ BỎ.').category).toBe('omitted_sense');
    expect(classifyReviewNote('nghia can kiem tra lai').category).toBe('meaning_doubt');
  });
});

describe('a whole entry', () => {
  const light = ['Mức CEFR C1 ước tính từ tần suất thấp (zipf 3.56); cần xem lại.', "Nghĩa 'đất sét bùn' rất hiếm và chuyên ngành nên không đưa vào."];
  const blocking = "Nghĩa 'phố' và 'dãy nhà' có thể gộp, cần kiểm tra lại.";

  it('light notes alone never hold it back', () => {
    expect(hasBlockingReviewNote(light)).toBe(false);
    expect(blockingReviewNotes(light)).toEqual([]);
  });

  it('no notes at all never hold it back', () => {
    expect(hasBlockingReviewNote([])).toBe(false);
  });

  it('ONE blocking note among light ones does, and only that one is returned', () => {
    const notes = [...light, blocking];
    expect(hasBlockingReviewNote(notes)).toBe(true);
    expect(blockingReviewNotes(notes).map((n) => n.text)).toEqual([blocking]);
  });

  it('keeps the order of the notes and gives each its label', () => {
    const all = classifyReviewNotes([blocking, ...light]);
    expect(all.map((n) => n.category)).toEqual(['meaning_doubt', 'cefr_estimate', 'omitted_sense']);
    expect(all.every((n) => n.label.length > 3)).toBe(true);
  });
});
