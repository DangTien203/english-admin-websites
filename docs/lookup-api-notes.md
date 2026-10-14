# WordyGo · Ghi chú API dịch vụ ngoài (P2)

Ngày kiểm chứng: 13/10/2026. Mọi điều dưới đây được gọi thật bằng script `scripts/smoke/*.ts` hoặc đọc tài liệu chính thức; mục nào chưa kiểm chứng được thì ghi rõ.
Fixture phản hồi thật của Free Dictionary: `tests/fixtures/lookup/free-dictionary/` (xem mục 1.6 về tên thư mục).

---

## 1. Free Dictionary API (`https://api.dictionaryapi.dev/api/v2/entries/en/<từ>`)

Không cần khóa. Client: `services/upstream/freeDictionaryClient.ts`.

### 1.1 Cấu trúc phản hồi 200 (đã thấy với hello, ubiquitous, ran)

Mảng các entry. Mỗi entry:

| Trường | Ghi chú thật |
|---|---|
| `word` | chuỗi. **Cùng một từ có thể có nhiều entry**: `ran` trả về 3 entry (động từ, danh từ, danh từ) với `sourceUrls` khác nhau |
| `phonetic` | chuỗi IPA, **có thể vắng** (hello, ubiquitous không có; ran có `/ɹæn/`). Không có thông tin giọng |
| `phonetics[]` | mỗi phần tử có thể có `text` (IPA), `audio` (URL tuyệt đối **hoặc chuỗi rỗng `""`**), `sourceUrl`, `license{name,url}`. `text` có thể vắng khi có audio (hello-au). Có phần tử chỉ có `text` và `audio:""` |
| `meanings[]` | `partOfSpeech`, `definitions[]`, `synonyms[]`, `antonyms[]` (cấp nghĩa, áp dụng cho cả loại từ) |
| `meanings[].definitions[]` | `definition` (bắt buộc), `synonyms[]`, `antonyms[]` (luôn có, thường rỗng), `example` (**tùy chọn**) |
| `license` | `{ name: "CC BY-SA 3.0", url }` |
| `sourceUrls[]` | URL Wiktionary, ví dụ `https://en.wiktionary.org/wiki/hello` |

Một nghĩa có thể rất dài: `ran` có một `meanings[]` với 34 định nghĩa. Fixture đã cắt còn 4 nghĩa × 3 định nghĩa (cấu trúc giữ nguyên).

### 1.2 Giọng Mỹ hay Anh: chỉ suy ra từ đuôi tên tệp audio

URL audio có dạng `https://api.dictionaryapi.dev/media/pronunciations/en/<từ>-<giọng>.mp3`. Đã thấy các đuôi `-us`, `-uk`, `-au` (Úc), ví dụ `hello-au.mp3`, `hello-uk.mp3`, `ubiquitous-us.mp3`, `ran-us.mp3`. Không có trường nào khác ghi giọng.
Hệ quả: IPA chỉ gắn được giọng khi **cùng phần tử `phonetics`** có audio mang đuôi. IPA không audio (ví dụ `/həˈloʊ/` của hello) không rõ giọng nên đi vào `ipa.any`, không đoán là Mỹ. Giọng Úc không dùng cho `us/uk`, chỉ làm dự phòng trong `any`.

### 1.3 Phản hồi lỗi: điểm khác nhiều với giả định

| Tình huống | Thực tế đã thấy |
|---|---|
| Từ không có | Tài liệu của dịch vụ mô tả thân JSON `{ "title": "No Definitions Found", "message": "...", "resolution": "..." }` (HTTP 404). **Không bắt được thật**: mọi lần thử với `asdfghjk`, `zxqvlorp`, `qwrtpsdf` đều gặp 522. Test dùng thân mô tả theo tài liệu và ghi rõ điều đó |
| **404 giả cho từ có thật** | `run` và `ran` trả **404 với trang HTML** (`Content-Type: text/html;charset=ISO-8859-1`, tiêu đề "404 page", nội dung của một site không liên quan) **liên tục 40 lần thử trong vài phút**. Header `cf-cache-status: HIT`, `Age: ~851000` (khoảng 10 ngày), `Cache-Control: max-age=14400`: đây là trang 404 sai bị Cloudflare cache cho đúng URL đó. Cùng từ đó đôi lúc trả 200 (`run` 9012 byte, `ran` 6168 byte ở các lần khác), nên kết quả phụ thuộc điểm biên (PoP) |
| 522 | Cloudflare "Connection timed out" (thân `error code: 522`), cũng gặp với `ubiquitous` ở một lần thử; nhiều từ khác chỉ treo tới hết timeout phía client |
| 429 / `Retry-After` | **Chưa gặp**. Không có bằng chứng nào về thân hay header của 429 |

Quyết định trong client:
- 404 **có thân JSON dạng object** → `{ found: false }` (không ném lỗi, không tính vào breaker).
- 404 **không phải JSON** (trang HTML) → `UpstreamUnavailable('bad_response')`, **không** được hiểu là "không có từ". Lỗi này gắn với từng từ (cache sai) nên cờ `affectsBreaker=false`: nhiều lần tra `run` không được làm mở breaker cho cả các từ khác.
- 5xx (kể cả 522) → `UpstreamUnavailable('http_5xx')`, tính vào breaker.
- 429 → `UpstreamUnavailable('rate_limited')` kèm `Retry-After` nếu có.

### 1.4 Header giới hạn tốc độ: KHÔNG đáng tin

Phản hồi 200 có `X-RateLimit-Limit: 450`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Nhưng các phản hồi này đến từ cache của CDN (`cf-cache-status: HIT`, `Age` tới 11 ngày): `Reset` trỏ về 27/07 đến 04/08/2026 trong khi hôm nay là 13/10/2026, và `Remaining` dao động vô nghĩa (334, 449). Không dùng các header này để ra quyết định; chỉ có token bucket nội bộ (`FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN`). Giá trị `450` cho thấy giới hạn thật của dịch vụ vào cỡ 450 lượt, chưa rõ cửa sổ thời gian.

### 1.5 Việc chưa kiểm chứng
- Thân và header thật của 429.
- Thân JSON thật của 404 "không có từ".
- Độ trễ điển hình (chưa đo có hệ thống; các lần 200 đều rất nhanh vì phục vụ từ cache).

### 1.6 Vị trí fixture
Prompt ghi `test/fixtures/...` (số ít). Repo dùng `tests/` (jest `testMatch` và `CLAUDE.md`), nên fixture nằm ở `tests/fixtures/lookup/free-dictionary/` để một thư mục test duy nhất. Dễ đổi nếu bạn muốn.
Fixture hiện có: `hello`, `ubiquitous` (bắt bằng script smoke), `ran` (bắt bằng curl khi script gặp 404 HTML). **Thiếu `run` và `asdfghjk`** vì dịch vụ không trả JSON hợp lệ (xem 1.3). Chạy lại script khi dịch vụ ổn định sẽ tự bổ sung: `npx tsx scripts/smoke/free-dictionary.ts run asdfghjk`.

---

## 2. Google Cloud Translation v2

Client: `services/upstream/googleTranslateClient.ts`. Khóa lấy từ `GOOGLE_TRANSLATE_API_KEY`. Đã chạy `scripts/smoke/google-translate.ts` với khóa thật (tiêu tốn khoảng 170 ký tự hạn mức).

| Câu hỏi | Kết quả thật |
|---|---|
| Gọi thế nào | `POST https://translation.googleapis.com/language/translate/v2`, thân JSON `{ q: string[], source:"en", target:"vi", format:"text" }`, HTTP 200. Tài liệu chính thức mô tả các tham số là query param; thân JSON vẫn hoạt động (đã thử) |
| Dạng phản hồi | `{ "data": { "translations": [ { "translatedText": "...", "detectedSourceLanguage": "en" } ] } }`. **`detectedSourceLanguage` vẫn có dù đã truyền `source`** (tài liệu nói là sẽ vắng) |
| Số phần tử | Bằng số `q` gửi lên, đúng thứ tự (5 vào, 5 ra) |
| Escape HTML | **Với `format=text` KHÔNG escape**: dấu nháy đơn `'`, nháy kép `"`, `&`, `<`, `>` giữ nguyên. Với `format=html` thì nháy kép thành `&quot;`. Client vẫn giải mã thực thể còn sót (đúng spec) nhưng thực tế `format=text` không sinh ra thực thể |
| Xuống dòng | `\n` giữ nguyên |
| Dấu `:` | Giữ lại trong bản dịch (`"ubiquitous: present, ..."` → `"Có mặt khắp nơi: hiện diện, ..."`), nên kỹ thuật tiền tố của spec F9 có cơ sở. Việc thử đầy đủ vẫn thuộc P3 |
| **Truyền khóa** | **Header `X-Goog-Api-Key` hoạt động**, nên khóa không cần nằm trong URL. Client dùng header để khóa không lọt vào log, thông báo lỗi hay proxy |
| Khóa sai | **HTTP 400** (không phải 401), thân `{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID",...}]}}`. Khớp spec §11.3: 400 là lỗi cấu hình |
| Giới hạn | Tài liệu: tối đa 128 chuỗi mỗi request. Giới hạn ký tự mỗi request (khoảng 30.000) lấy từ trang quota của Google, **chưa kiểm chứng ở đây**; client chặn cả hai |
| Chưa kiểm chứng | 403 do hết quota (mã `reason` cụ thể), 429 và `Retry-After` của Google, hành vi với chuỗi rỗng trong `q` |

---

## 3. Datamuse (`https://api.datamuse.com`)

Client: `services/upstream/datamuseClient.ts`. Nguồn: https://www.datamuse.com/api/ (đọc ngày 13/10/2026), cộng hai lệnh gọi thật.

- `GET /words?rel_syn=<từ>&max=20` và `rel_ant=...`: mảng JSON `[{ "word": "sad", "score": 32055 }, ...]`. `max` mặc định 100, tối đa 1000. Đã thử `rel_syn=happy` (200, ~1,2 s, `Cache-Control: max-age=86400`).
- Không khóa: tối đa 100.000 lượt/ngày.
- **Khóa API**: trang thông báo sẽ **bắt buộc có khóa trong năm 2027** và "đang chuẩn bị cấp khóa", **nhưng không nói khóa được gửi bằng header hay query, tên là gì**. Trang còn tự mâu thuẫn về ngày (một chỗ ghi 1/1/2027, một chỗ ghi 1/2/2027). Spec đang cảnh báo từ 2027-01-01 (mốc sớm hơn, an toàn).
  → `applyDatamuseAuth()` là hàm **cố tình để trống** kèm `TODO(datamuse-key)`; không đoán tên tham số để khỏi gửi khóa vào chỗ vô nghĩa. Khi Datamuse công bố, chỉ sửa hàm đó và test tương ứng.

---

## 4. Anthropic (khung)

Client: `services/upstream/anthropicEnrichClient.ts`. SDK `@anthropic-ai/sdk` 0.80.0: `messages.create(...).withResponse()` trả `{ data, request_id }`; `maxRetries: 0` để SDK không tự thử lại. Lỗi SDK (`APIError.status`, `.headers`, `.error` = thân JSON, `.requestID`) được phân loại theo spec §11.3/§11.4:

| Tình huống | Kết quả |
|---|---|
| 429 có `retry-after` | `UpstreamUnavailable('rate_limited', retryAfterMs)` |
| 429 có `error.details.error_code = enforced_spend_limit_reached` | `BudgetExceeded('spend_limit')` |
| HTTP 400 thông báo bắt đầu "You have reached your specified API usage limits" | `BudgetExceeded('spend_limit')` |
| Các 400/401/403/404 khác | `UpstreamConfigError` |
| 5xx, 529 | `UpstreamUnavailable('http_5xx')` |
| Hết thời gian, lỗi kết nối | `timeout`, `network` |

**Chưa kiểm chứng với API thật**: hình dạng thân của lỗi `enforced_spend_limit_reached` (client chấp nhận cả `body.error.details.error_code` lẫn `body.details.error_code`) và thông báo "usage limits" — cả hai lấy từ spec, chưa gọi thử vì không thể chủ động gây ra hết ngân sách.
Script smoke cho Anthropic không có trong P2 (chưa có prompt hay schema nội dung; P6 làm).

---

## 5. Điểm khác biệt cần cập nhật vào lookup-spec.md

1. **§6 và §11.2 ("FD404", "404 không phải lỗi")**: chỉ đúng với 404 có thân JSON. 404 dạng HTML là sự cố của CDN, phải coi là `FDerr` (hàng "không G, FDerr → 503", hoặc "G, FDerr → partial"), không bao giờ ra `ENTRY_NOT_FOUND`. Nếu không, từ như `run` sẽ bị báo "không tìm thấy" sai.
2. **§11.2**: lỗi theo từng từ (404 HTML, 4xx lạ) không được tính vào breaker; đã hiện thực bằng cờ `affectsBreaker=false`.
3. **§11.5**: header `X-RateLimit-*` của Free Dictionary không dùng được (cache CDN); chỉ token bucket nội bộ.
4. **§11.3 (Google)**: khóa sai trả **400**, không phải 401/403; vẫn xếp là lỗi cấu hình.
5. **Google nhận khóa qua header `X-Goog-Api-Key`**: spec không nói; nên ghi vào §5 F8 để khóa không nằm trong URL.
6. **§5 F9/F10**: `format=text` không escape HTML; giải mã thực thể chỉ là phòng thủ.
7. **Datamuse (§1)**: cơ chế truyền khóa chưa được công bố; thêm ghi chú và mốc ngày mâu thuẫn (1/1 so với 1/2/2027).
8. **§13.1**: có thêm `affectsBreaker`, `withRetry` và `ApiUsage.release()` (hoàn lại ký tự khi Google từ chối) nằm ngoài danh sách test của spec.
