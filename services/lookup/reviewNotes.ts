/**
 * What to do with the notes of Haiku (`notes_for_review`, the part of an `[auto]` admin_note that follows "ghi chú của Haiku:").
 *
 * Until P9 ONE such note of any kind stopped an entry from being bulk-published, and since the model writes some for every entry
 * (the 29 entries of 16/10/2026 had 2 to 6 each) the bulk publish could not select a single one. A note is now put in a CATEGORY
 * by what it says, and only the categories marked `blocks` hold an entry back; the others stay visible in the detail of the
 * entry (docs/lookup-admin.md §3.4).
 *
 * To change the rule edit REVIEW_NOTE_CATEGORIES (flip a `blocks`, add or change a pattern): that table is all there is. The
 * classifier is a plain keyword match on Vietnamese text with the accents removed, so it is cheap and predictable, and it is
 * wrong sometimes: that is why a note that matches nothing BLOCKS (an unknown note is read by a person, never waved through), and
 * why the full table of what each note was classified as can be printed (`npx tsx scripts/dev/classify-review-notes.ts`).
 *
 * Pure: no database, no clock.
 */

export type ReviewNoteCategoryId =
  | 'meaning_doubt'
  | 'validator_flag'
  | 'sensitive'
  | 'proper_noun'
  | 'other'
  | 'usage_check'
  | 'cefr_estimate'
  | 'omitted_sense'
  | 'merged_sense'
  | 'suggestion'
  | 'source_data'
  | 'kept_decision'
  | 'validator_tag_dropped';

export interface ReviewNoteCategory {
  id: ReviewNoteCategoryId;
  /** shown to the reviewer */
  label: string;
  /** true: an entry with a note of this kind is NOT bulk-published ("cần xem"); false: a light note, it only informs */
  blocks: boolean;
  /** one line for docs and the table */
  description: string;
}

/**
 * The categories, with the rule of bulk publishing: `blocks: true` = "cần xem". Edit here.
 * Order is only for display; the order in which a note is tested is in `classifyReviewNote`.
 */
export const REVIEW_NOTE_CATEGORIES: readonly ReviewNoteCategory[] = [
  { id: 'meaning_doubt', blocks: true, label: 'Nghi ngờ nghĩa', description: 'Haiku nói chưa chắc, cần kiểm tra, xem lại hay xác nhận một nghĩa, một cách dịch hay một sense còn thiếu' },
  { id: 'validator_flag', blocks: true, label: 'Bộ kiểm tra của job báo lỗi', description: 'Dòng "[kiểm tra] …" do chính bộ kiểm tra của job ghi, ví dụ định nghĩa tiếng Anh dùng lại chính từ đang định nghĩa' },
  { id: 'sensitive', blocks: true, label: 'Từ nhạy cảm hoặc thô tục', description: 'Nhắc tới nghĩa thô tục, xúc phạm, nhạy cảm hay tình dục' },
  { id: 'proper_noun', blocks: true, label: 'Tên riêng', description: 'Nói từ có thể là tên riêng (họ, tên người, địa danh) mà KHÔNG nói là đã bỏ nghĩa đó' },
  { id: 'other', blocks: true, label: 'Còn lại (không nhận ra)', description: 'Không khớp nhóm nào: một người đọc nó, không bao giờ cho qua mặc định' },
  { id: 'usage_check', blocks: false, label: 'Lưu ý nhẹ về cách dùng', description: 'Đếm được hay không, ngoại động hay nội động, register, Anh hay Mỹ, chủ đề, số nhiều' },
  { id: 'cefr_estimate', blocks: false, label: 'CEFR ước tính', description: 'Mức CEFR là ước tính từ tần suất (đã ghi là "ước tính" ở mọi nơi)' },
  { id: 'omitted_sense', blocks: false, label: 'Nghĩa đã bỏ có chủ ý', description: 'Haiku giải thích vì sao bỏ một nghĩa hiếm, cổ, chuyên ngành, tiếng lóng hay tên riêng để giữ mục từ gọn' },
  { id: 'merged_sense', blocks: false, label: 'Nghĩa gần nhau đã gộp', description: 'Hai nghĩa gần nhau được gộp hay giữ cả hai' },
  { id: 'suggestion', blocks: false, label: 'Gợi ý biên tập', description: '"Cân nhắc", "nếu muốn", "có thể thêm lại": không phải điều nghi ngờ' },
  { id: 'source_data', blocks: false, label: 'Ghi chú về dữ liệu nguồn', description: 'Datamuse hay Wiktionary không có đồng nghĩa, trái nghĩa hay ví dụ; ví dụ được viết lại' },
  { id: 'kept_decision', blocks: false, label: 'Giải thích điều đã giữ hay đã ghi', description: 'Haiku nói vì sao giữ một nghĩa, đã đưa nó vào sense nào, hay chỉ có một nghĩa' },
  { id: 'validator_tag_dropped', blocks: false, label: 'Thẻ đã bị bộ kiểm tra bỏ', description: '"[kiểm tra] bỏ <thẻ>": một thẻ chủ đề hay register bị bỏ vì không hợp' },
] as const;

const BY_ID = new Map(REVIEW_NOTE_CATEGORIES.map((c) => [c.id, c]));

/** The ids of the categories that hold an entry back from bulk publishing. Derived from the table above. */
export const BLOCKING_REVIEW_NOTE_CATEGORIES: readonly ReviewNoteCategoryId[] = REVIEW_NOTE_CATEGORIES.filter((c) => c.blocks).map((c) => c.id);

// ── keyword patterns (on text with accents removed, lower case) ─────────────────────────────────────────────────────────

/**
 * "Đã bỏ", "bỏ qua", "không đưa vào", "chưa lập": the model says what it LEFT OUT. "bỏ" (drop) and "bổ" (as in "bổ sung",
 * supplement) are the same letters once the accents are gone, so the verb is matched on the text WITH its accents.
 */
const OMISSION_VERB = /(?<![\p{L}])bỏ(?![\p{L}])/u;
const OMISSION = /khong (duoc )?(dua|lap|them|nhap)\b|chua (duoc )?(dua|lap|them|tach)\b|de giu (muc tu )?gon|giu toi da/;
/** The model ASKS a person to look at something ("cần kiểm tra", "cần xem lại", "cần xác nhận", "cần bổ sung"). */
const REQUEST = /can (kiem tra|xem lai|xac nhan|xac dinh|bo sung)|co the can (kiem tra|xem)|nen (kiem tra|xem lai)|kiem tra (them|lai)/;
/** The model says it is NOT SURE (when it left the thing out because of that, there is nothing in the entry to doubt). */
const UNCERTAIN = /chua chac|khong chac|chua (xac dinh|ro)\b|nghi ngo|co the sai/;
/** "… nếu muốn", "… nếu cần": an offer, not a doubt. */
const CONDITIONAL = /\bneu (muon|can)\b/;
/** A topic that is about HOW a word is used, not about WHAT it means: a doubt about it is a light note. */
const USAGE_TOPIC = /\bregister\b|\bformal\b|informal|ngu phap|is_countable|is_transitive|dem duoc|ngoai dong|noi dong|so nhieu|cach dung|\busage\b|vung mien|phuong ngu|\banh\b[^.;]*\bmy\b|\bmy\b|chu de|\btopic\b|psychology/;
/** A plain statement about usage (no doubt in it): "khác nhau theo vùng (Anh/Mỹ), đã ghi trong usage_note". */
const USAGE_INFO = /usage_note|khac nhau theo vung|\(anh\/my\)/;
const KEPT = /da (giu|dua vao|ghi|xep|danh dau|chon)\b|giu lai|chi (co )?mot nghia/;
const SENSITIVE = /tho tuc|tuc tiu|nhay cam|xuc pham|phan cam|miet thi|khiem nha|chui the|vulgar|offensive|derogatory|profan|\bslur\b|\btaboo\b|tinh duc|sexual|khieu dam|bao luc/;
const PROPER_NOUN = /ten rieng|danh tu rieng|ho rieng|ten (nguoi|song|lang|dia danh)|proper noun/;
const CEFR = /cefr|(uoc tinh|uoc luong)[^.;]*\b(a1|a2|b1|b2|c1|c2)\b|\b(a1|a2|b1|b2|c1|c2)\b[^.;]*(uoc tinh|uoc luong)/;
const MERGE = /\bgop\b|da gop|gan nhau|gan nhu giong|trung voi/;
const SUGGESTION = /can nhac|neu muon|neu can|co the (them|bo sung|tach|dieu chinh|giu hoac)/;
const SOURCE_DATA = /datamuse|wiktionary|du lieu (nguon|khong)|nguon (co|ghi|thieu)|vi du (da|duoc|cho)|khong co (tu dong nghia|antonym|ung vien)/;

/** Lower case, accents removed (đ → d), so that "Nghĩa" and "nghia" are the same. */
export function foldNote(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111|\u0110/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ClassifiedNote {
  text: string;
  category: ReviewNoteCategoryId;
  label: string;
  blocks: boolean;
}

function result(text: string, id: ReviewNoteCategoryId): ClassifiedNote {
  const c = BY_ID.get(id) as ReviewNoteCategory;
  return { text, category: id, label: c.label, blocks: c.blocks };
}

/**
 * Which category a note belongs to. The first test that matches wins, from the most specific to the most general:
 *   1. "[kiểm tra] …" lines of the job's own checker: a dropped tag is light, anything else blocks;
 *   2. a CEFR estimate (even when it says "cần xem lại": every CEFR level is an estimate and is shown as one);
 *   3. sensitive words;
 *   4. an expressed doubt (the model asks for a check, or says it is not sure about something it KEPT): about how the word is
 *      used → light, about a meaning → blocks. "… nếu muốn" is an offer, not a doubt; "bỏ … vì chưa chắc" is a thing left out;
 *   5. a proper noun: left out → light, otherwise blocks;
 *   6. a plain note about usage, what was left out, merged, suggested, said about the source data, or kept → light;
 *   7. nothing matched → blocks.
 */
export function classifyReviewNote(note: string): ClassifiedNote {
  const text = String(note ?? '').trim();
  const lower = text.normalize('NFC').toLowerCase();
  const f = foldNote(text);
  const omits = OMISSION_VERB.test(lower) || OMISSION.test(f);

  if (f.startsWith('[kiem tra]')) return result(text, /^\[kiểm tra\]\s*bỏ(?![\p{L}])/u.test(lower) ? 'validator_tag_dropped' : 'validator_flag');
  if (CEFR.test(f)) return result(text, 'cefr_estimate');
  if (SENSITIVE.test(f)) return result(text, 'sensitive');
  const doubt = !CONDITIONAL.test(f) && (REQUEST.test(f) || (UNCERTAIN.test(f) && !omits));
  if (doubt) return result(text, USAGE_TOPIC.test(f) ? 'usage_check' : 'meaning_doubt');
  if (PROPER_NOUN.test(f)) return result(text, omits ? 'omitted_sense' : 'proper_noun');
  if (USAGE_INFO.test(f)) return result(text, 'usage_check');
  if (omits) return result(text, 'omitted_sense');
  if (MERGE.test(f)) return result(text, 'merged_sense');
  if (SUGGESTION.test(f)) return result(text, 'suggestion');
  if (SOURCE_DATA.test(f)) return result(text, 'source_data');
  if (KEPT.test(f)) return result(text, 'kept_decision');
  return result(text, 'other');
}

export function classifyReviewNotes(notes: readonly string[]): ClassifiedNote[] {
  return notes.map(classifyReviewNote);
}

/** The notes that hold the entry back ("cần xem"). Empty = the notes alone do not stop a bulk publish. */
export function blockingReviewNotes(notes: readonly string[]): ClassifiedNote[] {
  return classifyReviewNotes(notes).filter((n) => n.blocks);
}

export function hasBlockingReviewNote(notes: readonly string[]): boolean {
  return notes.some((n) => classifyReviewNote(n).blocks);
}
