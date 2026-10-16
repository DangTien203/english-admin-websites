# WordyGo · API tra từ trong ebook (sau P3)

`POST /api/v1/ebooks/:id/lookup` · cần JWT (`requireApiAuth`, gắn ở mount) · đường dẫn và xác thực **không đổi**.
Quy tắc tương thích: response **chỉ thêm trường**; mọi trường đã có giữ nguyên tên, vị trí và kiểu để app cũ vẫn chạy.
Nguồn thiết kế: `docs/lookup-spec.md` mục 4 đến 7, 11, 12. Ví dụ bên dưới là phản hồi thật (ngày 13/10/2026, khóa thật, DB thật).

## Request

```json
{ "word": "ubiquitous", "paragraph_id": "uuid-tùy-chọn" }
```

`word` được làm sạch như cũ (bỏ dấu câu hai đầu, chỉ chữ cái ASCII, `-` và `'` bên trong, tối đa 50 ký tự, đổi chữ thường để tra). Sai thì `400 INVALID_WORD`.

## Mã trả về

| Mã | Khi nào | Ghi chú |
|---|---|---|
| 200 `source:"dictionary"` | Có mục từ đã xuất bản khớp `headword`, `lemma`, `word_forms.form_value`, hoặc dạng biến cục bộ qua `ref_wiktionary_en` | Không gọi dịch vụ ngoài. Thêm `matched_form` nếu khớp qua dạng biến |
| 200 `source:"translation"` | Không có trong từ điển, gọi Google và/hoặc Free Dictionary | **Bản tạm**: `temporary:true`, `Cache-Control: no-store`, không ghi vào bảng từ điển hay cache nào |
| 400 `INVALID_WORD` | Từ không hợp lệ | như cũ |
| 404 `ENTRY_NOT_FOUND` | Không có trong từ điển và cả hai nguồn ngoài đều không biết từ; hoặc `TRANSLATION_FALLBACK_ENABLED=false` | như cũ; thêm `Cache-Control: no-store` |
| 429 `LOOKUP_RATE_LIMITED` | **Mới.** Người dùng tra từ không có trong từ điển quá `LOOKUP_MISS_RATE_LIMIT_PER_MIN` lần mỗi phút | Kèm header `Retry-After` (giây). Tra từ có trong từ điển không bị tính |
| 503 `TRANSLATION_UNAVAILABLE` | Cả Google lẫn Free Dictionary đều lỗi | mã lỗi như cũ |

## Response `source: "dictionary"`

Giữ nguyên (toàn bộ mục từ phẳng + `source:"dictionary"` + `lookup_context`). **Thêm:** `matched_form` (chuỗi, chỉ có khi khớp qua `word_forms` hoặc dạng biến, ví dụ tra `ran` ra mục `run`).

## Response `source: "translation"` (bản tạm)

### Trường đã có từ trước (giữ nguyên tên, vị trí, kiểu)

| Trường | Kiểu | Thay đổi về nội dung |
|---|---|---|
| `source` | `"translation"` | không |
| `word` | string | không (chữ người dùng gõ) |
| `translation_vi` | string \| **null** | Giờ là các nghĩa nối bằng `"; "` (tối đa `LOOKUP_MAX_MEANINGS`). **Có thể `null`** khi không có bản dịch. **Không bao giờ lặp lại từ gốc** (sửa lỗi cũ) |
| `phonetic` | string \| null | IPA (ưu tiên Mỹ, rồi Anh) |
| `audio_url` | string \| null | URL tuyệt đối của Free Dictionary |
| `pos` | string \| null | **Vẫn là chuỗi** (loại từ đầu tiên) như trước; danh sách đầy đủ ở `pos_list` |
| `definitions_en` | string[] | định nghĩa tiếng Anh của các sense đã chọn |
| `examples` | `{en, vi}[]` | `vi` luôn `null` |
| `providers` | string[] | `google_translate`, `free_dictionary_api` |
| `cached` | boolean | luôn `false` |
| `lookup_context` | object | không |

### Trường mới (spec mục 4.2)

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `temporary` | `true` | Đây là bản tạm, không nằm trong từ điển |
| `headword` | string | Từ chuẩn (của Free Dictionary nếu có, nếu không là chữ người dùng gõ) |
| `pos_list` | string[] | Mọi loại từ, theo thứ tự. (Spec ghi tên `pos`; tên đó đã dùng cho chuỗi nên đặt `pos_list`) |
| `ipa` | string \| null | Bằng `phonetic` (tên theo spec; `phonetic` giữ cho app cũ) |
| `meanings_vi` | string[] | Các nghĩa ngắn đã loại trùng |
| `senses` | `{pos, definition_en, definition_vi, gloss_vi, example_en}[]` | Tối đa `LOOKUP_MAX_MEANINGS`. `definition_vi`, `gloss_vi` là `null` khi chưa dịch được |
| `partial` | boolean | `true` khi thiếu dữ liệu vì một nguồn lỗi, không có, hoặc hết thời gian |
| `missing` | string[] | Phần thiếu: `translation_vi`; `pos`, `definition_en`, `ipa`, `audio_url`; `definition_vi` |
| `attribution` | `{name, license, url}[]` | Ghi công Wiktionary (CC BY-SA) lấy từ `license` và `sourceUrls` của Free Dictionary. **Mảng rỗng khi không có dữ liệu Free Dictionary** |
| `enrichment` | `{status, reason?}` | `queued` \| `already_queued` \| `skipped` \| `disabled`. Từ spec 1.5 giá trị là **quyết định tại thời điểm trả lời**, vì việc gửi job chạy NỀN sau response: `disabled` (`ENRICHMENT_ENABLED=false`), `skipped` với `reason: unknown_word` (từ không đáng tin), hoặc `queued` (đã giao cho khâu gửi nền: lời hứa thử gửi, không phải biên nhận). `already_queued` và `skipped` với `daily_cap`, `queue_error`, `invalid_word` không còn xuất hiện ở đây; kết quả thật của lần gửi nằm ở log `lookup_enrich`. Tên trường và các giá trị cũ giữ nguyên; app hiện không đọc trường này |

### Cách ghép (spec mục 6)

| Free Dictionary | Google | Kết quả |
|---|---|---|
| có | dùng được | 200 đầy đủ |
| có | không | 200 `partial`, `translation_vi: null`, `missing: ["translation_vi"]` |
| 404 JSON / lỗi | dùng được | 200 `partial`, `missing: ["pos","definition_en","ipa","audio_url"]` |
| 404 JSON | không | **404** `ENTRY_NOT_FOUND` |
| lỗi | không | **503** `TRANSLATION_UNAVAILABLE` |

"Dùng được" = không rỗng; nếu giống hệt từ gốc thì chỉ tính khi Free Dictionary xác nhận từ tồn tại (từ vay mượn như `taxi`). "Lỗi" của Free Dictionary gồm timeout, 5xx, 429, mạch ngắt mở, hết lượt nội bộ **và cả trang 404 dạng HTML** (xem `docs/lookup-api-notes.md`).

### Thứ tự xử lý

F1 làm sạch từ → F2 kiểm tra đoạn văn → F3 tăng `words_looked_up` (chạy ngầm, như cũ) → F4/F4b tra từ điển cục bộ → F5 cờ `TRANSLATION_FALLBACK_ENABLED` → F6 giới hạn tần suất → F7 single-flight theo từ → F8 Google (nghĩa chính) và Free Dictionary **song song** → F9 một request Google dịch `"<từ>: <định nghĩa>"` cho tối đa N sense → F10 ghép → F11 gắn hàng đợi → F12 ghi `word_lookups` (`dictionary`, `translation` hoặc `not_found`); **từ spec 1.5, F11 (gửi job) và F12 chạy nền sau khi response đã đi**, lỗi của chúng chỉ ra log. Tổng thời gian tính **từ đầu lần tra** và không vượt `LOOKUP_TOTAL_DEADLINE_MS`; hết hạn thì trả phần đã có với `partial:true`.

## Ví dụ 1 · Đầy đủ (từ `ubiquitous`, thật, ~0,55 s)

```json
{
  "success": true,
  "data": {
    "source": "translation",
    "temporary": true,
    "word": "ubiquitous",
    "headword": "ubiquitous",
    "translation_vi": "phổ biến; có mặt khắp mọi nơi",
    "meanings_vi": ["phổ biến", "có mặt khắp mọi nơi"],
    "phonetic": "/juˈbɪk.wɪ.təs/",
    "ipa": "/juˈbɪk.wɪ.təs/",
    "audio_url": "https://api.dictionaryapi.dev/media/pronunciations/en/ubiquitous-us.mp3",
    "pos": "adjective",
    "pos_list": ["adjective"],
    "definitions_en": ["Being everywhere at once: omnipresent.", "Appearing to be everywhere at once; ...", "Widespread; very prevalent."],
    "examples": [],
    "providers": ["google_translate", "free_dictionary_api"],
    "cached": false,
    "senses": [
      { "pos": "adjective", "definition_en": "Being everywhere at once: omnipresent.", "definition_vi": "Hiện diện ở mọi nơi cùng một lúc: toàn năng.", "gloss_vi": "có mặt khắp mọi nơi", "example_en": null },
      { "pos": "adjective", "definition_en": "Appearing to be everywhere at once; ...", "definition_vi": "Dường như hiện diện ở khắp mọi nơi cùng một lúc; ...", "gloss_vi": "có mặt khắp mọi nơi", "example_en": null },
      { "pos": "adjective", "definition_en": "Widespread; very prevalent.", "definition_vi": "Lan rộng; rất thường gặp.", "gloss_vi": "phổ biến", "example_en": null }
    ],
    "partial": false,
    "missing": [],
    "attribution": [
      { "name": "Wiktionary via Free Dictionary API", "license": "CC BY-SA 3.0", "url": "https://en.wiktionary.org/wiki/ubiquitous" }
    ],
    "enrichment": { "status": "disabled" },
    "lookup_context": { "source": "ebook", "ebook_id": "…", "paragraph_id": null }
  }
}
```

Headers: `Cache-Control: no-store`.

## Ví dụ 2 · Partial (từ `run`, thật: Free Dictionary trả 404 HTML nên coi là lỗi)

```json
{
  "success": true,
  "data": {
    "source": "translation",
    "temporary": true,
    "word": "run",
    "headword": "run",
    "translation_vi": "chạy",
    "meanings_vi": ["chạy"],
    "phonetic": null,
    "ipa": null,
    "audio_url": null,
    "pos": null,
    "pos_list": [],
    "definitions_en": [],
    "examples": [],
    "providers": ["google_translate"],
    "cached": false,
    "senses": [],
    "partial": true,
    "missing": ["pos", "definition_en", "ipa", "audio_url"],
    "attribution": [],
    "enrichment": { "status": "disabled" },
    "lookup_context": { "source": "ebook", "ebook_id": "…", "paragraph_id": null }
  }
}
```

Nếu Google lỗi mà Free Dictionary ổn: giống ví dụ 1 nhưng `"translation_vi": null`, `"meanings_vi": []`, `"partial": true`, `"missing": ["translation_vi"]`, `"providers": ["free_dictionary_api"]`. **Không bao giờ** điền `translation_vi` bằng chính từ vừa tra.

## Ví dụ 3 · Không tìm thấy (404)

```json
{ "success": false, "error": { "code": "ENTRY_NOT_FOUND", "message": "Không tìm thấy từ \"qwxz\" trong từ điển" } }
```

Hai ví dụ lỗi khác:

```json
// 429, kèm header  Retry-After: 17
{ "success": false, "error": { "code": "LOOKUP_RATE_LIMITED", "message": "Bạn tra từ quá nhanh. Vui lòng thử lại sau ít giây." } }

// 503
{ "success": false, "error": { "code": "TRANSLATION_UNAVAILABLE", "message": "Cannot translate this word right now. Please try again later." } }
```

## Thời gian đo thật (máy dev, DB Neon ở xa, 13/10/2026)

Mỗi dòng là một lần chạy `scripts/smoke/lookup-live.ts`. `local` = hai truy vấn từ điển cục bộ; `google` = nghĩa chính; `fd` = Free Dictionary; `step2` = dịch định nghĩa.

| Từ | Tổng | local | google | fd | step2 | Kết quả |
|---|---|---|---|---|---|---|
| ubiquitous | 553 ms | 88 | 187 | 100 | 275 | đầy đủ |
| ubiquitous | 557 ms | 75 | 184 | 116 | 297 | đầy đủ |
| ubiquitous | 1501 ms | 659 | 389 | 528 | 311 | đầy đủ |
| run | 282 ms | 92 | 189 | 99 | 0 | partial (FD trả 404 HTML) |
| run | 1127 ms | 685 | 440 | 355 | 0 | partial (FD 404 HTML) |

Google và Free Dictionary chạy song song nên bước 1 tốn bằng bên chậm hơn. Lần chạy đầu tiên trong một phiên chậm hơn do mở kết nối DB (local 659 đến 685 ms). Một lần chạy trước khi sửa hạn chót thấy Free Dictionary treo 2,8 đến 3,0 s (timeout rồi thử lại) khiến bước 2 không còn thời gian: khi đó `partial:true`, `missing:["definition_vi"]`. Đây là rủi ro thật với `LOOKUP_TOTAL_DEADLINE_MS=3000` (xem báo cáo P3).

## Ghi chú P3b · LOOKUP_FAST_TRANSLATOR

Hợp đồng response ở trên **không đổi** khi đặt `LOOKUP_FAST_TRANSLATOR=haiku`. Khác biệt chỉ nằm ở nội dung:
- `meanings_vi` và `translation_vi` lấy từ Claude Haiku (2 đến 4 nghĩa ngắn kèm loại từ); `senses[].gloss_vi` và `senses[].definition_vi` vẫn do bước 2 (Google) điền khi `LOOKUP_TRANSLATE_DEFINITIONS=true`, và các gloss đó **không** được thêm vào `meanings_vi`.
- `providers` có thêm `"claude_haiku"` (đứng trước `"google_translate"` nếu bước 2 chạy).
- Khi Haiku lỗi, timeout, hết ngân sách hoặc mạch ngắt mở, hệ thống tự rơi về Google và response giống hệt chế độ `google` (log ghi `translator: "google_fallback"` và `fallback_reason`).
- Nếu Haiku trả mảng rỗng ("không phải từ tiếng Anh") thì coi như không có bản dịch: Free Dictionary có từ → `partial` (`translation_vi: null`); Free Dictionary 404 → 404 `ENTRY_NOT_FOUND`.
Số đo và khuyến nghị chọn chế độ: `docs/lookup-multimeaning-experiment.md` (mục P3b).
