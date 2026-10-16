# WordyGo · Báo cáo nghiệm thu tra từ (P7b)

Chạy lúc 2026-10-16T06:43:23.165483Z (đồng hồ DB) · DB: ep-divine-field-aoljwkwq.c-2.ap-southeast-1.aws.neon.tech / neondb · máy chủ: http://localhost:3010 · nhóm: A, B, C, D, E, F, H · ENRICHMENT_PUBLISH_POLICY=review · LOOKUP_TOTAL_DEADLINE_MS=3000 · LOOKUP_FAST_TRANSLATOR=google · tổng thời gian 128 s.
Tạo bởi `npm run acceptance:lookup`; cách chạy ở `docs/lookup-runbook.md` mục 12. Bảng bên dưới là kết quả ĐO, không chỉnh để cho xanh.

## 1. Tóm tắt

| Đạt | Không đạt | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi | Bỏ qua (tiền đề sai) |
|---|---|---|---|
| 5 | 0 | 10 | 34 |

**Lần chạy này CHƯA kết luận hết**: 10 từ không đánh giá được vì Free Dictionary lỗi (mục 1.1 và 4.1). Đó không phải đạt và cũng không phải không đạt. Chạy lại riêng các nhóm đó khi nguồn khỏe: `npm run acceptance:lookup -- --staging --only H,E,F --base-url http://localhost:3010`

| Kiểm tra cấp lần chạy | Kết quả | Chi tiết |
|---|---|---|
| Nhóm A và B không gọi Google (ký tự không đổi) | ĐẠT | trước 7654, sau 7654 |
| p95 đường nhanh nhóm C, D, E, H ≤ 3500 ms | ĐẠT | p50 = 834 ms, p95 = 3432 ms, 9 mẫu |

### 1.1 Free Dictionary trong lần chạy này

Thăm dò gọi THẲNG Free Dictionary (không qua máy chủ, để không làm mạch ngắt của máy chủ nhích), 3 lần liền với một từ mẫu; **khỏe** chỉ khi cả 3 lần trả 200 với danh sách mục từ không rỗng trong LOOKUP_UPSTREAM_TIMEOUT_MS.

| Lúc | Kết luận | Chi tiết 3 lần |
|---|---|---|
| trước khi chạy | khỏe | lần 1: OK (HTTP 200) 204 ms; lần 2: OK (HTTP 200) 76 ms; lần 3: OK (HTTP 200) 73 ms |
| sau nhóm H | khỏe | lần 1: OK (HTTP 200) 368 ms; lần 2: OK (HTTP 200) 111 ms; lần 3: OK (HTTP 200) 112 ms |
| sau lượt tra | khỏe | lần 1: OK (HTTP 200) 315 ms; lần 2: OK (HTTP 200) 116 ms; lần 3: OK (HTTP 200) 104 ms |

* Sau nhóm H mạch ngắt Free Dictionary của máy chủ có vẻ đã mở (nhiều lần lỗi liên tiếp): chờ 32 s (UPSTREAM_BREAKER_RESET_MS = 30000 ms cộng 2 s đệm) trước nhóm E.

Từ nhóm H trả về không có sense của Free Dictionary được hỏi lại ĐÚNG từ đó sau lượt tra (từ mẫu `hello` luôn được CDN của dịch vụ trả lời nên không lộ ra lúc nó chập chờn với từ chưa có trong bộ nhớ đệm):

| Từ | Free Dictionary khi hỏi lại | Hiểu là |
|---|---|---|
| jam | không trả lời | nguồn vẫn lỗi; không đánh giá được |
| ring | không trả lời | nguồn vẫn lỗi; không đánh giá được |
| spring | không trả lời | nguồn vẫn lỗi; không đánh giá được |
| mint | không trả lời | nguồn vẫn lỗi; không đánh giá được |
| pound | không trả lời | nguồn vẫn lỗi; không đánh giá được |
| row | có dữ liệu (200) | lúc tra máy chủ không nhận được gì: nguồn chập chờn, từ không sai; không đánh giá được |

Thứ tự chạy: A, B, C, D, **H**, E, F. Nhóm H chạy trước E và F vì E, F là hai nhóm làm Free Dictionary treo nhiều nhất (tên riêng và từ rác không có bản dịch của Google nên phải chờ Free Dictionary hết giờ).

**Quy tắc chấm khi Free Dictionary lỗi** (không sửa đặc tả để hợp thức hóa kết quả, mục 6 của đặc tả giữ nguyên):

* Một ca **503 TRANSLATION_UNAVAILABLE** của nhóm E hoặc F (kể cả từ rác như `asdfghjk`, `xinchao`) là hành vi **ĐÚNG** theo ma trận mục 6: "không G, FDerr → 503". Từ rác không có bản dịch của Google, Free Dictionary treo hoặc lỗi thì máy chủ KHÔNG được bịa ra 404; trả 503 là đúng (**đạt có ghi chú**). Kỳ vọng của nhóm (E: 200, F: 404) không kiểm tra được lúc đó, nên dòng được ghi là "KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi", không phải "không đạt".
* Nhóm **H** cần các sense của Free Dictionary: nếu một lần thăm dò hoặc mạch ngắt cho thấy nó không khỏe lúc tra, từ H không có sense được ghi là "KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi". Phần job nền của dòng vẫn được chấm riêng: một job sai vẫn là "không đạt".
* Mọi lỗi khác (sai mã HTTP, sai `source`, thiếu bản dịch…) vẫn là "không đạt" dù Free Dictionary ra sao.

## 2. Đường nhanh (mỗi từ một lần tra)

| Nhóm | Từ | HTTP | source | temporary | matched_form | partial | missing | meanings_vi | senses | enrichment | ms | Kết quả đường nhanh |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | bank | 200 | dictionary | - | - | - |  | - | 3 | - | 171 | ĐẠT |
| B | children | 200 | dictionary | - | children | - |  | - | 2 | - | 159 | ĐẠT |
| B | banks | 200 | dictionary | - | banks | - |  | - | 3 | - | 154 | ĐẠT |
| H | jam (thay batter) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3156 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| H | ring (thay mole) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 834 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| H | spring (thay sage) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 442 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| H | mint (thay tick) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 937 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| H | pound (thay bass) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 395 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| H | row (thay fawn) | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 571 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| E | london | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 3094 | ĐẠT |
| E | microsoft | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 3432 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| E | shakespeare | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 330 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| F | asdfghjk | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 576 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| F | xinchao | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 317 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| F | recieve | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 346 | ĐẠT |

## 3. Job nền và dữ liệu đã ghi

Chờ tối đa 12 phút.

| Nhóm | Từ | Kỳ vọng | Job | reason | Mục từ | published | sense | ví dụ | meaning_vi | Kết quả job |
|---|---|---|---|---|---|---|---|---|---|---|
| A | bank | none | không có | - | có (có từ trước lần chạy) | - | - | - | - | ĐẠT |
| B | children | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| B | banks | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| H | jam | succeeded | succeeded | - | có | false | 6 | 12 | mứt; tình thế khó khăn; tắc nghẽn; kẹt; nhét; làm tắc nghẽn | ĐẠT |
| H | ring | succeeded | succeeded | - | có | false | 5 | 6 | nhẫn; vòng tròn; bao quanh; tiếng chuông; rung chuông; vòng | ĐẠT |
| H | spring | succeeded | succeeded | - | có | false | 6 | 7 | mùa xuân; cú nhảy; lò xo; suối; nhảy vọt; nảy mầm | ĐẠT |
| H | mint | succeeded | succeeded | - | có | false | 6 | 6 | xưởng đúc tiền; một khoản tiền lớn; đúc tiền; tạo ra; còn mớ | ĐẠT |
| H | pound | succeeded | succeeded | - | có | false | 6 | 6 | cân Anh; bảng Anh; trại chó hoang; đập mạnh; giã; đập thình  | ĐẠT |
| H | row | succeeded | succeeded | - | có | false | 6 | 9 | hàng; dãy nhà; chèo; chuyến chèo thuyền; cuộc cãi vã; cãi vã | ĐẠT |
| E | london | rejected_proper_noun | rejected | proper_noun | không | - | - | - | - | ĐẠT |
| E | microsoft | rejected_proper_noun | rejected | proper_noun | không | - | - | - | - | ĐẠT |
| E | shakespeare | rejected_proper_noun | rejected | proper_noun | không | - | - | - | - | ĐẠT |
| F | asdfghjk | none | không có | - | không | - | - | - | - | ĐẠT |
| F | xinchao | none | không có | - | không | - | - | - | - | ĐẠT |
| F | recieve | variant_if_any | skipped | variant_form | không | - | - | - | - | ĐẠT |

## 4. Từ KHÔNG ĐẠT, nguyên nhân

Không có.

### 4.1 Từ "KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi"

| Nhóm | Từ | Vì sao không chấm được |
|---|---|---|
| H | jam | Free Dictionary không khỏe lúc tra (thăm dò lại đúng từ này, Free Dictionary vẫn không trả lời); các sense của nhóm H đến từ nguồn đó<br>(senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi)<br>(meanings_vi có 1 phần tử, mong đợi từ 3) |
| H | ring | Free Dictionary không khỏe lúc tra (thăm dò lại đúng từ này, Free Dictionary vẫn không trả lời); các sense của nhóm H đến từ nguồn đó<br>(senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi)<br>(meanings_vi có 1 phần tử, mong đợi từ 3) |
| H | spring | Free Dictionary không khỏe lúc tra (thăm dò lại đúng từ này, Free Dictionary vẫn không trả lời); các sense của nhóm H đến từ nguồn đó<br>(senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi)<br>(meanings_vi có 1 phần tử, mong đợi từ 3) |
| H | mint | Free Dictionary không khỏe lúc tra (thăm dò lại đúng từ này, Free Dictionary vẫn không trả lời); các sense của nhóm H đến từ nguồn đó<br>(senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi)<br>(meanings_vi có 1 phần tử, mong đợi từ 3) |
| H | pound | Free Dictionary không khỏe lúc tra (thăm dò lại đúng từ này, Free Dictionary vẫn không trả lời); các sense của nhóm H đến từ nguồn đó<br>(senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi)<br>(meanings_vi có 1 phần tử, mong đợi từ 3) |
| H | row | Free Dictionary không khỏe lúc tra (mạch ngắt Free Dictionary đang mở sau nhiều lần lỗi liên tiếp); các sense của nhóm H đến từ nguồn đó<br>(senses=0: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi)<br>(meanings_vi có 1 phần tử, mong đợi từ 3) |
| E | microsoft | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 200) |
| E | shakespeare | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 200) |
| F | asdfghjk | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 404 ENTRY_NOT_FOUND) |
| F | xinchao | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 404 ENTRY_NOT_FOUND) |

Chạy lại riêng khi Free Dictionary khỏe (cần thêm từ mới cho nhóm H: các từ H đã chạy đã có mục từ do job tạo, nên script dùng từ dự phòng):

```bash
npm run acceptance:lookup -- --staging --only H,E,F --base-url http://localhost:3010
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
| H | bark | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | crane | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | pitch | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | seal | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | bolt | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | stalk | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | mole | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | sage | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | tick | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | bat | đã có trong từ điển (published) (từ dự phòng cho "tick") |
| H | bass | đã có trong từ điển (published) |
| H | fawn | đã có mục từ (published=false, ví dụ do P6b tạo) |

Từ dự phòng đã chạy: jam (thay batter), ring (thay mole), spring (thay sage), mint (thay tick), pound (thay bass), row (thay fawn).

## 6. Token và chi phí của lần chạy

| Đại lượng | Giá trị |
|---|---|
| `api_usage_counters` anthropic (tháng 2026-10) tăng | vào 94661, ra 12406 |
| Cộng từ hàng job (9 job có gọi Haiku) | vào 94661, ra 12406 |
| Chi phí ước tính | $0.00930 |

Chi phí là ƯỚC TÍNH từ bảng giá nhập tay ngày 2026-10-15 (`services/enrichment/pricing.ts`, phải xác minh lại), giả định mỗi job đọc 7.859 token system prompt từ cache còn phần vào còn lại tính đầy đủ; hàng job chỉ lưu tổng token đầu vào nên không tách được chính xác (ghi cache, lần sửa). Token vào gồm cả ghi và đọc cache. Chi phí Google chỉ biết số ký tự (mục 1), không quy ra tiền.

