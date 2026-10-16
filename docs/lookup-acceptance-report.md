# WordyGo · Báo cáo nghiệm thu tra từ (P7b)

Chạy lúc 2026-10-16T06:49:50.160288Z (đồng hồ DB) · DB: ep-divine-field-aoljwkwq.c-2.ap-southeast-1.aws.neon.tech / neondb · máy chủ: http://localhost:3010 · nhóm: A, B, C, D, E, F, H · ENRICHMENT_PUBLISH_POLICY=review · LOOKUP_TOTAL_DEADLINE_MS=3000 · LOOKUP_FAST_TRANSLATOR=google · tổng thời gian 85 s.
Tạo bởi `npm run acceptance:lookup`; cách chạy ở `docs/lookup-runbook.md` mục 12. Bảng bên dưới là kết quả ĐO, không chỉnh để cho xanh.

## 1. Tóm tắt

| Đạt | Không đạt | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi | Bỏ qua (tiền đề sai) |
|---|---|---|---|
| 5 | 0 | 10 | 40 |

**Lần chạy này CHƯA kết luận hết**: 10 từ không đánh giá được vì Free Dictionary lỗi (mục 1.1 và 4.1). Đó không phải đạt và cũng không phải không đạt. Chạy lại riêng các nhóm đó khi nguồn khỏe: `npm run acceptance:lookup -- --staging --only H,E,F --base-url http://localhost:3010`

| Kiểm tra cấp lần chạy | Kết quả | Chi tiết |
|---|---|---|
| Nhóm A và B không gọi Google (ký tự không đổi) | ĐẠT | trước 7727, sau 7727 |
| p95 đường nhanh nhóm C, D, E, H ≤ 3500 ms | ĐẠT | p50 = 616 ms, p95 = 3396 ms, 3 mẫu |

### 1.1 Free Dictionary trong lần chạy này

Thăm dò gọi THẲNG Free Dictionary (không qua máy chủ, để không làm mạch ngắt của máy chủ nhích), 3 lần liền, mỗi lần một từ thông dụng khác nhau (một từ duy nhất như `hello` có thể nằm sẵn trong bộ nhớ đệm của CDN và vẫn được trả lời khi máy chủ gốc đã treo); **khỏe** chỉ khi cả 3 lần trả 200 với danh sách mục từ không rỗng trong LOOKUP_UPSTREAM_TIMEOUT_MS.

| Lúc | Kết luận | Chi tiết 3 lần |
|---|---|---|
| trước khi chạy | **KHÔNG KHỎE** | lần 1 (house): OK (HTTP 200) 234 ms; lần 2 (water): http_404 (HTTP 404) 86 ms; lần 3 (tree): http_404 (HTTP 404) 87 ms |
| sau lượt tra | **KHÔNG KHỎE** | lần 1 (house): OK (HTTP 200) 213 ms; lần 2 (water): http_404 (HTTP 404) 65 ms; lần 3 (tree): http_404 (HTTP 404) 109 ms |

Thứ tự chạy: A, B, C, D, **H**, E, F. Nhóm H chạy trước E và F vì E, F là hai nhóm làm Free Dictionary treo nhiều nhất (tên riêng và từ rác không có bản dịch của Google nên phải chờ Free Dictionary hết giờ).

**Quy tắc chấm khi Free Dictionary lỗi** (không sửa đặc tả để hợp thức hóa kết quả, mục 6 của đặc tả giữ nguyên):

* Một ca **503 TRANSLATION_UNAVAILABLE** của nhóm E hoặc F (kể cả từ rác như `asdfghjk`, `xinchao`) là hành vi **ĐÚNG** theo ma trận mục 6: "không G, FDerr → 503". Từ rác không có bản dịch của Google, Free Dictionary treo hoặc lỗi thì máy chủ KHÔNG được bịa ra 404; trả 503 là đúng (**đạt có ghi chú**). Kỳ vọng của nhóm (E: 200, F: 404) không kiểm tra được lúc đó, nên dòng được ghi là "KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi", không phải "không đạt".
* Nhóm **H** cần các sense của Free Dictionary: nếu một lần thăm dò hoặc mạch ngắt cho thấy nó không khỏe lúc tra, từ H không có sense được ghi là "KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi". Phần job nền của dòng vẫn được chấm riêng: một job sai vẫn là "không đạt".
* Mọi lỗi khác (sai mã HTTP, sai `source`, thiếu bản dịch…) vẫn là "không đạt" dù Free Dictionary ra sao.

## 2. Đường nhanh (mỗi từ một lần tra)

| Nhóm | Từ | HTTP | source | temporary | matched_form | partial | missing | meanings_vi | senses | enrichment | ms | Kết quả đường nhanh |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | bank | 200 | dictionary | - | - | - |  | - | 3 | - | 174 | ĐẠT |
| B | children | 200 | dictionary | - | children | - |  | - | 2 | - | 163 | ĐẠT |
| B | banks | 200 | dictionary | - | banks | - |  | - | 3 | - | 163 | ĐẠT |
| E | london | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 616 | ĐẠT |
| E | microsoft | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 3396 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| E | shakespeare | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 330 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| F | asdfghjk | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 694 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| F | xinchao | 503 TRANSLATION_UNAVAILABLE | - | - | - | - |  | - | - | - | 353 | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi |
| F | recieve | 200 | translation | true | - | true | pos,definition_en,ipa,audio_url | 1 | 0 | queued | 369 | ĐẠT |

## 3. Job nền và dữ liệu đã ghi

Chờ tối đa 12 phút.

| Nhóm | Từ | Kỳ vọng | Job | reason | Mục từ | published | sense | ví dụ | meaning_vi | Kết quả job |
|---|---|---|---|---|---|---|---|---|---|---|
| A | bank | none | không có | - | có (có từ trước lần chạy) | - | - | - | - | ĐẠT |
| B | children | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
| B | banks | none; word_forms có | không có | - | không | - | - | - | - | ĐẠT |
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
| E | microsoft | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 200) |
| E | shakespeare | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 200) |
| F | asdfghjk | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 404 ENTRY_NOT_FOUND) |
| F | xinchao | 503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời<br>(HTTP 503 TRANSLATION_UNAVAILABLE, mong đợi 404 ENTRY_NOT_FOUND) |
| H | wave | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi: chưa chạy vì Free Dictionary không trả lời lúc bắt đầu (từ giữ nguyên cho lần chạy lại) |
| H | well | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi: chưa chạy vì Free Dictionary không trả lời lúc bắt đầu (từ giữ nguyên cho lần chạy lại) |
| H | yard | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi: chưa chạy vì Free Dictionary không trả lời lúc bắt đầu (từ giữ nguyên cho lần chạy lại) |
| H | fan | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi: chưa chạy vì Free Dictionary không trả lời lúc bắt đầu (từ giữ nguyên cho lần chạy lại) |
| H | tap | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi: chưa chạy vì Free Dictionary không trả lời lúc bắt đầu (từ giữ nguyên cho lần chạy lại) |
| H | rock | KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi: chưa chạy vì Free Dictionary không trả lời lúc bắt đầu (từ giữ nguyên cho lần chạy lại) |

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
| H | jam | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | ring | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | spring | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | bat | đã có trong từ điển (published) (từ dự phòng cho "batter") |
| H | mint | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | pound | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | row | đã có mục từ (published=false, ví dụ do P6b tạo) (từ dự phòng cho "batter") |
| H | mole | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | sage | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | tick | đã có mục từ (published=false, ví dụ do P6b tạo) |
| H | bass | đã có trong từ điển (published) |
| H | fawn | đã có mục từ (published=false, ví dụ do P6b tạo) |

## 6. Token và chi phí của lần chạy

| Đại lượng | Giá trị |
|---|---|
| `api_usage_counters` anthropic (tháng 2026-10) tăng | vào 26036, ra 873 |
| Cộng từ hàng job (3 job có gọi Haiku) | vào 26036, ra 873 |
| Chi phí ước tính | $0.00092 |

Chi phí là ƯỚC TÍNH từ bảng giá nhập tay ngày 2026-10-15 (`services/enrichment/pricing.ts`, phải xác minh lại), giả định mỗi job đọc 7.859 token system prompt từ cache còn phần vào còn lại tính đầy đủ; hàng job chỉ lưu tổng token đầu vào nên không tách được chính xác (ghi cache, lần sửa). Token vào gồm cả ghi và đọc cache. Chi phí Google chỉ biết số ký tự (mục 1), không quy ra tiền.

## 7. Phân tích các lần chạy ngày 15 và 16/10/2026 (viết tay; chạy lại script sẽ ghi đè cả tệp, bản lưu ở `docs/lookup-runbook.md` mục 12.2 và 12.3)

| Lần chạy | Mã | Chạy | Đạt | Không đạt | Không đánh giá được | p50 / p95 nhóm C, D, E, H |
|---|---|---|---|---|---|---|
| 15/10 (P7b) | cũ: gửi job trước response; Free Dictionary đã mở mạch ở E, F nên hỏng H | 28 từ (6 bỏ qua) | 18 | 10 | (chưa có nhãn) | 1.0 đến 1.7 s khi nguồn khỏe; **p95 3.756 ms, vượt 3.500** |
| 16/10 lần 1 | mới: gửi job và ghi `word_lookups` SAU response; công cụ đã có nhãn "không đánh giá được" cho 503 của E, F | 15 từ (27 bỏ qua) | 6 | 5 (nhóm H: `senses = 0`) | 4 (503 của E, F) | 3.075 ms / **3.389 ms**, trong giới hạn |
| 16/10 lần 2 | thêm hỏi lại ĐÚNG từ H sau lượt tra | 15 từ (34 bỏ qua) | 5 | 0 | 10 (6 H, 2 E, 2 F) | 834 ms / **3.432 ms**, trong giới hạn |
| 16/10 lần 3 (báo cáo ở trên) | thêm thăm dò bằng 3 từ khác nhau; nhóm H không chạy khi nguồn không khỏe | 9 từ (40 bỏ qua) | 5 | 0 | 10 (6 H chưa chạy, 2 E, 2 F) | 616 ms / **3.396 ms**, trong giới hạn |

**Free Dictionary đang hỏng ở phía họ, không phải ở mã.** Ngày 16/10 (kiểm bằng `curl` trực tiếp, ngoài ứng dụng): các từ `hello` và `house` trả 200 trong 0,2 s (CDN của dịch vụ có sẵn trong bộ nhớ đệm); các từ khác như `water`, `tree`, `jam`, `crane`, `bolt` lúc thì treo hơn 6 đến 8 giây, lúc thì trả **404 trong 90 ms** (tức máy chủ gốc không đọc được mục từ). Nhật ký của chính máy chủ ứng dụng cho cùng một kết luận: `fd: error:timeout` (crane, bolt, stalk, london, microsoft), `error:bad_response` (pitch, seal), rồi `error:breaker_open` sau 5 lỗi liên tiếp. Vì vậy:

* **Nhóm H không chấm được hôm nay.** Lần 1 chấm 5 từ H "không đạt" (`senses = 0`) trong khi lần thăm dò đầu và cuối đều "khỏe": thăm dò chỉ dùng `hello`, một từ luôn có trong bộ nhớ đệm của CDN, nên không thấy máy chủ gốc đang chết. Đã sửa công cụ: thăm dò bằng ba từ khác nhau (`house`, `water`, `tree`), hỏi lại đúng từ H không có sense, và không chạy H khi lần thăm dò đầu không khỏe (lần 3).
* **503 của E, F (microsoft, shakespeare, asdfghjk, xinchao) là hành vi đúng của ma trận mục 6** ("không G, FDerr → 503"): Google dịch ra chính từ đó nên không dùng được, và Free Dictionary treo hoặc lỗi thì máy chủ không được bịa ra 404. **Đạt có ghi chú** về hành vi; kỳ vọng của đề bài (E: 200, F: 404) không kiểm tra được lúc này nên các dòng là "không đánh giá được: nguồn ngoài lỗi". Đặc tả mục 6 không đổi.
* **Điều đã chứng minh được hôm nay** dù nguồn hỏng: A và B đạt và ký tự Google không đổi (7.727 trước và sau); `london` (200, `translation`, job `rejected / proper_noun`, không mục từ); `recieve` (200 hoặc 404; job `skipped / variant_form`, không mục từ); mọi job của E rejected đúng; **p95 ≤ 3.500 ms ở cả ba lần chạy** (3.389, 3.432, 3.396 ms), gồm cả những câu chạm hết hạn chót 3.000 ms, vì việc gửi job (310 đến 460 ms, `enqueue_ms` trong log `lookup_enrich`) không còn nằm trước response.
* **Điều chưa chứng minh được và cần chạy lại khi Free Dictionary khỏe:** các điều kiện của nhóm H (`senses` từ 2 phần tử khác loại, `meanings_vi` từ 3) ở đường nhanh, và hai kỳ vọng E (microsoft, shakespeare: 200) và F (asdfghjk, xinchao: 404).

**Vì sao chỉ 9 đến 15 trong 30 từ chạy được, và việc cần bạn quyết để chạy đủ:**

1. **Nhóm C và D (9 từ) đều đã có mục từ** do job của lần chạy 15/10 tạo (`published = false`), nên tiền đề "chưa có mục từ" sai và các từ bị bỏ qua. Chạy lại nhóm C, D cần xóa các mục từ ấy (`npm run acceptance:lookup -- --staging --cleanup`) hoặc dùng từ mới. Prompt này cấm xóa dữ liệu nên **không** chạy `--cleanup`.
2. **Nhóm A và B thiếu `run`, `go`, `light` đã xuất bản**: ba mục từ đó đang `published = false` (mục từ `bank` và `child` vẫn `published = true`). Bản seed (`npm run seed:lookup-test -- --staging`) sẽ xuất bản lại chúng; tôi **không** chạy seed vì không rõ ai đã gỡ xuất bản và vì có thể bạn không muốn. Tôi chỉ tạo lại `.acceptance.local.json` (đổi mật khẩu của người dùng thử `lookup-acceptance@example.com`, không đụng mục từ nào).
3. **Mỗi lần chạy nhóm H để lại một mục từ cho mỗi từ** (job không cần Free Dictionary), nên mỗi lần chạy "dùng hết" 6 từ H. Đã dùng (đã có mục từ): batter, mole, sage, tick, fawn, trunk, rack, pawn (15/10), bark, crane, pitch, seal, bolt, stalk (lần 1 ngày 16/10), jam, ring, spring, mint, pound, row (lần 2). Còn 8 từ dự phòng chưa dùng: wave, well, yard, fan, tap, rock, bear, pool (đủ cho một lần chạy H nữa; nhóm H lần 3 **không chạy** nên không dùng thêm từ nào). Thêm từ vào `FALLBACK_WORDS.H` (`scripts/acceptance/words.ts`) khi cần.

Khi `curl -m 6 https://api.dictionaryapi.dev/api/v2/entries/en/water` trả 200 nhanh trở lại: `npm run acceptance:lookup -- --staging --only H,E,F --base-url http://localhost:3000`.
