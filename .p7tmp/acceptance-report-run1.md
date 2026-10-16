# WordyGo · Báo cáo nghiệm thu tra từ (P7b)

Chạy lúc 2026-10-16T06:38:31.845416Z (đồng hồ DB) · DB: ep-divine-field-aoljwkwq.c-2.ap-southeast-1.aws.neon.tech / neondb · máy chủ: http://localhost:3010 · nhóm: A, B, C, D, E, F, H · ENRICHMENT_PUBLISH_POLICY=review · LOOKUP_TOTAL_DEADLINE_MS=3000 · LOOKUP_FAST_TRANSLATOR=google · tổng thời gian 135 s.
Tạo bởi `npm run acceptance:lookup`; cách chạy ở `docs/lookup-runbook.md` mục 12. Bảng bên dưới là kết quả ĐO, không chỉnh để cho xanh.

## 1. Tóm tắt

| Đạt | Không đạt | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi | Bỏ qua (tiền đề sai) |
|---|---|---|---|
| 6 | 5 | 4 | 27 |

**Lần chạy này CHƯA kết luận hết**: 4 từ không đánh giá được vì Free Dictionary lỗi (mục 1.1 và 4.1). Đó không phải đạt và cũng không phải không đạt. Chạy lại riêng các nhóm đó khi nguồn khỏe: `npm run acceptance:lookup -- --staging --only E,F --base-url http://localhost:3010`

| Kiểm tra cấp lần chạy | Kết quả | Chi tiết |
|---|---|---|
| Nhóm A và B không gọi Google (ký tự không đổi) | ĐẠT | trước 7300, sau 7300 |
| p95 đường nhanh nhóm C, D, E, H ≤ 3500 ms | ĐẠT | p50 = 3075 ms, p95 = 3389 ms, 9 mẫu |

### 1.1 Free Dictionary trong lần chạy này

Thăm dò gọi THẲNG Free Dictionary (không qua máy chủ, để không làm mạch ngắt của máy chủ nhích), 3 lần liền với một từ mẫu; **khỏe** chỉ khi cả 3 lần trả 200 với danh sách mục từ không rỗng trong LOOKUP_UPSTREAM_TIMEOUT_MS.

| Lúc | Kết luận | Chi tiết 3 lần |
|---|---|---|
| trước khi chạy | khỏe | lần 1: OK (HTTP 200) 370 ms; lần 2: OK (HTTP 200) 112 ms; lần 3: OK (HTTP 200) 109 ms |
| sau nhóm H | khỏe | lần 1: OK (HTTP 200) 205 ms; lần 2: OK (HTTP 200) 69 ms; lần 3: OK (HTTP 200) 68 ms |
| sau lượt tra | khỏe | lần 1: OK (HTTP 200) 203 ms; lần 2: OK (HTTP 200) 67 ms; lần 3: OK (HTTP 200) 79 ms |

* Sau nhóm H mạch ngắt Free Dictionary của máy chủ có vẻ đã mở (nhiều lần lỗi liên tiếp): chờ 32 s (UPSTREAM_BREAKER_RESET_MS = 30000 ms cộng 2 s đệm) trước nhóm E.

Thứ tự chạy: A, B, C, D, **H**, E, F. Nhóm H chạy trước E và F vì E, F là hai nhóm làm Free Dictionary treo nhiều nhất (tên riêng và từ rác không có bản dịch của Google nên phải chờ Free Dictionary hết giờ).

**Quy tắc chấm khi Free Dictionary lỗi** (không sửa đặc tả để hợp thức hóa kết quả, mục 6 của đặc tả giữ nguyên):

* Một ca **503 TRANSLATION_UNAVAILABLE** của nhóm E hoặc F (kể cả từ rác như `asdfghjk`, `xinchao`) là hành vi **ĐÚNG** theo ma trận mục 6: "không G, FDerr → 503". Từ rác không có bản dịch của Google, Free Dictionary treo hoặc lỗi thì máy chủ KHÔNG được bịa ra 404; trả 503 là đúng (**đạt có ghi chú**). Kỳ vọng của nhóm (E: 200, F: 404) không kiểm tra được lúc đó, nên dòng được ghi là "KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi", không phải "không đạt".
* Nhóm **H** cần các sense của Free Dictionary: nếu một lần thăm dò hoặc mạch ngắt cho thấy nó không khỏe lúc tra, từ H không có sense được ghi là "KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi". Phần job nền của dòng vẫn được chấm riêng: một job sai vẫn là "không đạt".
* Mọi lỗi khác (sai mã HTTP, sai `source`, thiếu bản dịch…) vẫn là "không đạt" dù Free Dictionary ra sao.

## 2. Đường nhanh (mỗi từ một lần tra)

| Nhóm | Từ | HTTP | source | temporary | matched_form | partial | missing | meanings_vi | senses | enrichment | ms | Kết quả đường nhanh |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | bank | 200 | dictionary | - | - | - |  | - | 3 | - | 166 | ĐẠT |
| B | children | 200 | dictionary | - | children | - |  | - | 2 | - | 157 | ĐẠT |
| B | banks | 200 | dictionary | - | banks | - |  | - | 3 | - | 149 | ĐẠT |
| H | bark (thay batter) | 200 | translation | true | - | false |  | 3 | 4 | queued | 1544 | ĐẠT |
| H | crane (thay mole) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3248 | KHÔNG ĐẠT |
| H | pitch (thay sage) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 567 | KHÔNG ĐẠT |
| H | seal (thay tick) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 618 | KHÔNG ĐẠT |
| H | bolt (thay bass) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3146 | KHÔNG ĐẠT |
| H | stalk (thay fawn) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3164 | KHÔNG ĐẠT |
| E | london | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3075 | ĐẠT |
| E | microsoft | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 3389 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| E | shakespeare | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 554 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| F | asdfghjk | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 549 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| F | xinchao | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 607 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| F | recieve | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 670 | ĐẠT |

## 3. Job nền và dữ liệu đã ghi

Chờ tối đa 12 phút.

| Nhóm | Từ | Kỳ vọng | Job | reason | Mục từ | published | sense | ví dụ | meaning_vi | Kết quả job |
|---|---|---|---|---|---|---|---|---|---|---|
| A | bank | none | không có | - | có (có từ trước lần chạy) | - | - | - | - | ĐẠT |
| B | children | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| B | banks | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| H | bark | succeeded | succeeded | - | có | false | 5 | 7 | sủa; quát tháo; tiếng sủa; vỏ cây; làm trầy; gầm gừ | ĐẠT |
| H | crane | succeeded | succeeded | - | có | false | 4 | 4 | chim sếu; cần cẩu; vươn cổ; cẩu lên; chim hạc; máy trục | ĐẠT |
| H | pitch | succeeded | succeeded | - | có | false | 6 | 6 | nhựa đường; quét hắc ín; cú ném; ném; cao độ; lên giọng | ĐẠT |
| H | seal | succeeded | succeeded | - | có | false | 5 | 5 | hải cẩu; niêm phong; con dấu; ấn chương; đóng dấu; bịt kín | ĐẠT |
| H | bolt | succeeded | succeeded | - | có | false | 6 | 6 | bu lông; chốt cửa; bắt bu lông; cài chốt; thẳng đơ; bỏ chạy | ĐẠT |
| H | stalk | succeeded | succeeded | - | có | false | 4 | 4 | thân cây; rình theo; bám đuôi; bước đi lặng lẽ; cuống; lén t | ĐẠT |
| E | london | rejected_proper_noun | rejected | proper_noun | không | - | - | - | - | ĐẠT |
| E | microsoft | rejected_proper_noun | rejected | proper_noun | không | - | - | - | - | ĐẠT |
| E | shakespeare | rejected_proper_noun | rejected | proper_noun | không | - | - | - | - | ĐẠT |
| F | asdfghjk | none | không có | - | không | - | - | - | - | ĐẠT |
| F | xinchao | none | không có | - | không | - | - | - | - | ĐẠT |
| F | recieve | variant_if_any | skipped | variant_form | không | - | - | - | - | ĐẠT |

## 4. Từ KHÔNG ĐẠT, nguyên nhân

| Nhóm | Từ | Nguyên nhân |
|---|---|---|
| H | crane | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |
| H | pitch | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |
| H | seal | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |
| H | bolt | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |
| H | stalk | senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi<br>meanings_vi có 1 phần tử, mong đợi từ 3 |

### 4.1 Từ "KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi"

| Nhóm | Từ | Vì sao không chấm được |
|---|---|---|
| E | microsoft | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 200) |
| E | shakespeare | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 200) |
| F | asdfghjk | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 404 ENTRY_NOT_FOUND) |
| F | xinchao | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 404 ENTRY_NOT_FOUND) |

Chạy lại riêng khi Free Dictionary khỏe (cần thêm từ mới cho nhóm H: các từ H đã chạy đã có mục từ do job tạo, nên script dùng từ dự phòng):

```bash
npm run acceptance:lookup -- --staging --only E,F --base-url http://localhost:3010
```

## 5. Từ BỎ QUA (tiền đề sai)

| Nhóm | Từ | Lý do |
|---|---|---|
| A | run | có mục từ nhưng published=false |
| A | light | có mục từ nhưng published=false |
| B | ran | mục từ gốc "run" có nhưng published=false |
| B | running | mục từ gốc "run" có nhưng published=false |
| B | went | mục từ gốc "go" có nhưng published=false |
| B | lights | mục từ gốc "light" có nhưng published=false |
| C | serendipity | đã có mục từ (published=false, ví dụ do P6b tạo) |
| C | nostalgia | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "serendipity") |
| C | gregarious | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "serendipity") |
| C | lucid | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "serendipity") |
| C | ubiquitous | đã có mục từ (published=false, ví dụ do P6b tạo) |
| C | ephemeral | đã có mục từ (published=false, ví dụ do P6b tạo) |
| C | podcast | đã có mục từ (published=false, ví dụ do P6b tạo) |
| C | quarantine | đã có mục từ (published=false, ví dụ do P6b tạo) |
| C | procrastinate | đã có mục từ (published=false, ví dụ do P6b tạo) |
| D | karaoke | đã có mục từ (published=false, ví dụ do P6b tạo) |
| D | sushi | đã có mục từ (published=false, ví dụ do P6b tạo) |
| D | tsunami | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | batter | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | trunk | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | rack | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | pawn | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | mole | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | sage | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | tick | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | bass | đã có trong từ điển (published) |
| H | fawn | đã có mục từ (published=false, ví dụ do P6b tạo) |

Từ dự phòng đã chạy: bark (thay batter), crane (thay mole), pitch (thay sage), seal (thay tick), bolt (thay bass), stalk (thay fawn).

## 6. Token và chi phí của lần chạy

| Đại lượng | Giá trị |
|---|---|
| `api_usage_counters` anthropic (tháng 2026-10) tăng | vào 93542, ra 11360 |
| Cộng từ hàng job (9 job có gọi Haiku) | vào 93542, ra 11360 |
| Chi phí ước tính | $0.00867 |

Chi phí là ƯỚC TÍNH từ bảng giá nhập tay ngày 2026-10-15 (`services/enrichment/pricing.ts`, phải xác minh lại), giả định mỗi job đọc 7.859 token system prompt từ cache còn phần vào còn lại tính đầy đủ; hàng job chỉ lưu tổng token đầu vào nên không tách được chính xác (ghi cache, lần sửa). Token vào gồm cả ghi và đọc cache. Chi phí Google chỉ biết số ký tự (mục 1), không quy ra tiền.

