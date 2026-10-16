# WordyGo · Báo cáo nghiệm thu tra từ (P7b)

Chạy lúc 2026-10-15T16:43:29.923764Z (đồng hồ DB) · DB: ep-divine-field-aoljwkwq.c-2.ap-southeast-1.aws.neon.tech / neondb · máy chủ: http://localhost:3000 · nhóm: A, B, C, D, E, F, H · ENRICHMENT_PUBLISH_POLICY=review · LOOKUP_TOTAL_DEADLINE_MS=3000 · LOOKUP_FAST_TRANSLATOR=google · tổng thời gian 111 s.
Tạo bởi `npm run acceptance:lookup`; cách chạy ở `docs/lookup-runbook.md` mục 12. Bảng bên dưới là kết quả ĐO, không chỉnh để cho xanh.

## 1. Tóm tắt

| Đạt | Không đạt | Bỏ qua (tiền đề sai) |
|---|---|---|
| 18 | 10 | 6 |

| Kiểm tra cấp lần chạy | Kết quả | Chi tiết |
|---|---|---|
| Nhóm A và B không gọi Google (ký tự không đổi) | ĐẠT | trước 2883, sau 2883 |
| p95 đường nhanh nhóm C, D, E, H ≤ 3500 ms | KHÔNG ĐẠT | p50 = 1618 ms, p95 = 3756 ms, 16 mẫu; p95 = 3756 ms > 3500 ms (LOOKUP_TOTAL_DEADLINE_MS 3000 + 500) |

## 2. Đường nhanh (mỗi từ một lần tra)

| Nhóm | Từ | HTTP | source | temporary | matched_form | partial | missing | meanings_vi | senses | enrichment | ms | Kết quả đường nhanh |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | run | 200 | dictionary | - | - | - |  | - | 5 | - | 229 | ĐẠT |
| A | bank | 200 | dictionary | - | - | - |  | - | 3 | - | 232 | ĐẠT |
| A | light | 200 | dictionary | - | - | - |  | - | 5 | - | 222 | ĐẠT |
| B | ran | 200 | dictionary | - | ran | - |  | - | 5 | - | 228 | ĐẠT |
| B | running | 200 | dictionary | - | running | - |  | - | 5 | - | 230 | ĐẠT |
| B | went | 200 | dictionary | - | went | - |  | - | 5 | - | 216 | ĐẠT |
| B | children | 200 | dictionary | - | children | - |  | - | 2 | - | 219 | ĐẠT |
| B | banks | 200 | dictionary | - | banks | - |  | - | 3 | - | 231 | ĐẠT |
| B | lights | 200 | dictionary | - | lights | - |  | - | 5 | - | 201 | ĐẠT |
| C | nostalgia (thay serendipity) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3346 | ĐẠT |
| C | ubiquitous | 200 | translation | true | - | false |  | 2 | 3 | queued | 1173 | ĐẠT |
| C | gregarious (thay ephemeral) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3680 | ĐẠT |
| C | lucid (thay podcast) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3688 | ĐẠT |
| C | procrastinate | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3701 | ĐẠT |
| D | sushi | 200 | translation | true | - | false |  | 1 | 2 | queued | 1224 | ĐẠT |
| D | tsunami | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3756 | ĐẠT |
| E | london | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 1618 | ĐẠT |
| E | microsoft | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 3733 | KHÔNG ĐẠT |
| E | shakespeare | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 3693 | KHÔNG ĐẠT |
| F | asdfghjk | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 3263 | KHÔNG ĐẠT |
| F | xinchao | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 3307 | KHÔNG ĐẠT |
| F | recieve | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3599 | ĐẠT |
| H | batter | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 1052 | KHÔNG ĐẠT |
| H | mole | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 1056 | KHÔNG ĐẠT |
| H | sage | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 1016 | KHÔNG ĐẠT |
| H | tick | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 999 | KHÔNG ĐẠT |
| H | trunk (thay bass) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 1542 | KHÔNG ĐẠT |
| H | fawn | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 1660 | KHÔNG ĐẠT |

## 3. Job nền và dữ liệu đã ghi

Chờ tối đa 10 phút.

| Nhóm | Từ | Kỳ vọng | Job | reason | Mục từ | published | sense | ví dụ | meaning_vi | Kết quả job |
|---|---|---|---|---|---|---|---|---|---|---|
| A | run | none | không có | - | có (có từ trước lần chạy) | - | - | - | - | ĐẠT |
| A | bank | none | không có | - | có (có từ trước lần chạy) | - | - | - | - | ĐẠT |
| A | light | none | không có | - | có (có từ trước lần chạy) | - | - | - | - | ĐẠT |
| B | ran | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| B | running | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| B | went | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| B | children | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| B | banks | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| B | lights | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| C | nostalgia | succeeded | succeeded | - | có | false | 2 | 2 | nỗi nhớ nhà; nỗi hoài niệm; nỗi nhớ quê hương; niềm luyến ti | ĐẠT |
| C | ubiquitous | succeeded | succeeded | - | có | false | 2 | 3 | có mặt khắp nơi; rất thông dụng; phổ biến khắp nơi; lan rộng | ĐẠT |
| C | gregarious | succeeded | succeeded | - | có | false | 3 | 3 | hòa đồng; sống thành bầy đàn; mọc thành cụm; thích giao du;  | ĐẠT |
| C | lucid | succeeded | succeeded | - | có | false | 4 | 4 | rõ ràng; minh mẫn; trong suốt; giấc mơ tỉnh; dễ hiểu; tỉnh t | ĐẠT |
| C | procrastinate | succeeded | succeeded | - | có | false | 2 | 3 | trì hoãn; hoãn lại; chần chừ; lần lữa | ĐẠT |
| D | sushi | succeeded | succeeded | - | có | false | 3 | 4 | sushi; miếng sushi; làm thành sushi; món sushi; cuộn sushi;  | ĐẠT |
| D | tsunami | succeeded | succeeded | - | có | false | 2 | 2 | sóng thần; làn sóng dữ dội; sóng biển khổng lồ; cơn lũ | ĐẠT |
| E | london | rejected_proper_noun | rejected | proper_noun | không | - | - | - | - | ĐẠT |
| E | microsoft | rejected_proper_noun | rejected | proper_noun | không | - | - | - | - | ĐẠT |
| E | shakespeare | rejected_proper_noun | rejected | proper_noun | không | - | - | - | - | ĐẠT |
| F | asdfghjk | none | không có | - | không | - | - | - | - | ĐẠT |
| F | xinchao | none | không có | - | không | - | - | - | - | ĐẠT |
| F | recieve | variant_if_any | skipped | variant_form | không | - | - | - | - | ĐẠT |
| H | batter | succeeded | succeeded | - | có | false | 5 | 5 | đánh liên tục; đánh bại thảm hại; phủ bột nhúng; bột nhão; n | ĐẠT |
| H | mole | succeeded | succeeded | - | có | false | 5 | 5 | nốt ruồi; đào rãnh thoát nước; chuột chũi; đê chắn sóng; mol | ĐẠT |
| H | sage | succeeded | succeeded | - | có | false | 3 | 3 | khôn ngoan; bậc hiền triết; cây xô thơm; thông thái; nhà thô | ĐẠT |
| H | tick | succeeded | succeeded | - | có | false | 5 | 5 | tiếng tích tắc; kêu tích tắc; đánh dấu kiểm; dấu kiểm; con v | ĐẠT |
| H | trunk | succeeded | succeeded | - | có | false | 6 | 6 | thân cây; thân mình; vòi; hòm; cốp xe; chặt ngọn | ĐẠT |
| H | fawn | succeeded | succeeded | - | có | false | 5 | 5 | hươu con; màu nâu nhạt; vẫy đuôi nịnh; nịnh bợ; sự nịnh bợ;  | ĐẠT |

## 4. Từ KHÔNG ĐẠT, nguyên nhân

| Nhóm | Từ | Nguyên nhân |
|---|---|---|
| E | microsoft | HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 200 |
| E | shakespeare | HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 200 |
| F | asdfghjk | HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 404 ENTRY_NOT_FOUND |
| F | xinchao | HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 404 ENTRY_NOT_FOUND |
| H | batter | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |
| H | mole | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |
| H | sage | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |
| H | tick | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |
| H | trunk | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |
| H | fawn | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |

## 5. Từ BỎ QUA (tiền đề sai)

| Nhóm | Từ | Lý do |
|---|---|---|
| C | serendipity | đã có mục từ (published=false, ví dụ do P6b tạo) |
| C | ephemeral | đã có mục từ (published=false, ví dụ do P6b tạo) |
| C | podcast | đã có mục từ (published=false, ví dụ do P6b tạo) |
| C | quarantine | đã có mục từ (published=false, ví dụ do P6b tạo) |
| D | karaoke | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | bass | đã có trong từ điển (published) |

Từ dự phòng đã chạy: nostalgia (thay serendipity), gregarious (thay ephemeral), lucid (thay podcast), trunk (thay bass).

## 6. Token và chi phí của lần chạy

| Đại lượng | Giá trị |
|---|---|
| `api_usage_counters` anthropic (tháng 2026-10) tăng | vào 140284, ra 16672 |
| Cộng từ hàng job (16 job có gọi Haiku) | vào 140284, ra 16672 |
| Chi phí ước tính | $0.01105 |

Chi phí là ƯỚC TÍNH từ bảng giá nhập tay ngày 2026-10-15 (`services/enrichment/pricing.ts`, phải xác minh lại), giả định mỗi job đọc 7.859 token system prompt từ cache còn phần vào còn lại tính đầy đủ; hàng job chỉ lưu tổng token đầu vào nên không tách được chính xác (ghi cache, lần sửa). Token vào gồm cả ghi và đọc cache. Chi phí Google chỉ biết số ký tự (mục 1), không quy ra tiền.


## 7. Phân tích nguyên nhân (VIẾT TAY, không do script sinh; chạy lại script sẽ ghi đè tệp này nên chép phần này đi nếu cần giữ)

Kết luận ngắn: **không có lỗi nào nằm ở mã của pipeline hay của hàng đợi**: 12/12 job nền của nhóm C, D, H chạy `succeeded`, 3/3 tên riêng bị `rejected / proper_noun`, `recieve` bị `skipped / variant_form`, không từ rác nào sinh job, nhóm A và B không tốn một ký tự Google. Cả 10 dòng không đạt xuất phát từ **Free Dictionary**, từ hạn chót 3 s, hoặc từ chỗ kỳ vọng của bài nghiệm thu chưa tính tới hai điều đó. Đối chiếu từng dòng với log `lookup` của máy chủ (trường `fd`):

| Dòng không đạt | Nguyên nhân | Phân loại |
|---|---|---|
| E microsoft, shakespeare | Google trả bản dịch trùng từ gốc (bị loại), Free Dictionary treo (`fd: error:timeout`). Ma trận spec §6 "không G, FD lỗi" cho **503**, nên 503 là hành vi đúng. Kỳ vọng "partial vì Free Dictionary 404" giả định dịch vụ này trả 404 JSON; thực tế nó treo (`docs/lookup-api-notes.md` mục 1.3). Job `rejected / proper_noun` đúng | kỳ vọng của bài thử sai so với hành vi dịch vụ ngoài |
| F asdfghjk, xinchao | Như trên, với từ rác: Free Dictionary treo thay vì 404, nên 503 thay vì 404 `ENTRY_NOT_FOUND`. Không job nào được tạo (đúng) | như trên |
| H batter, mole, sage, tick, trunk, fawn | `senses = 0`: Free Dictionary không trả dữ liệu. Sáu từ này tra liền sau nhóm E và F, nơi 5 lần treo liên tiếp **mở mạch `free_dictionary`**; cả sáu ghi `fd: error:breaker_open` (không hề hỏi dịch vụ). Job nền của cả sáu **đạt** (3 đến 6 sense, `meaning_vi` đủ nghĩa) | dịch vụ ngoài + hiệu ứng thứ tự nhóm |
| p95 = 3.756 ms (> 3.500) | Hạn chót 3.000 ms chỉ bao các cuộc gọi ra ngoài. Sau đó còn gửi job (F11, một giao dịch pg-boss tới DB ở Singapore, ~0,5 s) và ghi `word_lookups` (F12), rồi HTTP còn xác thực và kiểm tra đoạn văn (~0,15 s). Khi Free Dictionary treo hết hạn chót, các từ chưa có trong từ điển mất 3,3 đến 3,8 s; khi nó trả lời hoặc mạch đang mở, 1,0 đến 1,7 s. Mẫu có 16 lượt tra nên p95 gần bằng giá trị lớn nhất | thiết kế hiện tại (cần quyết định, xem báo cáo bàn giao) |

**Chạy lại riêng nhóm H** (sau khi mạch đóng; `batter` và `mole` đã có mục từ nên được thay bằng `rack`, `pawn`): vẫn không đạt với cùng dấu hiệu (`rack`: `error:timeout` 2,5 s, `pawn`: mạch mở lại sau chuỗi timeout), job nền cả hai `succeeded` (4 sense, `meaning_vi` đủ). Tức là **điều kiện "H có từ 2 sense ngay ở đường nhanh" chưa từng được chứng minh đạt** trong lần nghiệm thu này, vì nó cần Free Dictionary khỏe; phần mã dựng `senses` từ Free Dictionary đã có test đơn vị và test với máy chủ giả (`tests/lookup/`).

**Ảnh hưởng của thứ tự:** mạch Free Dictionary dùng chung cho mọi từ, nên một chuỗi 5 lần treo (E, F) làm các từ sau (H) mất dữ liệu dù Free Dictionary chỉ vừa hồi phục. Đây là hành vi được thiết kế (mạch mở 30 s) nhưng làm kết quả nghiệm thu phụ thuộc thứ tự nhóm.

**Điều chưa biết được từ lần chạy này:**
* Ngoài tiến trình `npm run dev` tôi bật (host `Performance-PC`, đăng ký trong `pgboss.instance` lúc 16:43 UTC), còn một worker khác nối vào cùng DB và đang sống (host `srv-…-hibernate-…`, một triển khai từ xa, đăng ký từ 10:42 UTC). Tôi không khởi động nó và không biết phiên bản mã hay `ENRICHMENT_PUBLISH_POLICY` của nó. Các job nhóm C, D, H có thể do worker nào cũng xử lý; vì cả 12 mục từ ra `published = false` nên không có dấu hiệu worker nào chạy chính sách `auto`, nhưng log không ghi tên worker để chứng minh. Biến này **mặc định là `auto` khi không đặt** (`config/lookup.ts`).
* Chưa quan sát được 429 thật của Free Dictionary hay mã `reason` 403 thật của Google (`docs/lookup-api-notes.md`).
