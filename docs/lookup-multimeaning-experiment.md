# WordyGo · Thử nghiệm kỹ thuật tiền tố "từ: định nghĩa" (P3)

Ngày chạy: 13/10/2026 · Script: `scripts/smoke/multimeaning-experiment.ts` · Dữ liệu Google thô đã lưu ở `tests/fixtures/lookup/google-prefix/<từ>.json` (dùng làm fixture thật cho test).
Chạy lại không tốn hạn mức Google: `npx tsx scripts/smoke/multimeaning-experiment.ts --offline`.

## Cách làm

12 từ: run, light, bank, bat, match, spring, right, lead, fair, close, address, minute.
Mỗi từ: lấy sense từ Free Dictionary → chọn tối đa 4 sense theo F9 (`selectSenses`) → **một** request Google với `q = ['<từ>: <định nghĩa tiếng Anh>', ...]` → tách tại dấu `:` đầu tiên (phần trước là `gloss_vi`, phần sau là `definition_vi`). Thêm một request riêng dịch riêng từ gốc (headline, F8a). Dùng đúng các client thật của P2 (chỉ thay sổ ngân sách bằng bản giả để không cần DB). Tổng khoảng 2.270 ký tự q cho phần định nghĩa, cộng phần headline nhỏ.

**Hạn chế quan trọng:** Free Dictionary đang chập chờn (xem `docs/lookup-api-notes.md`). Sau 4 lần thử mỗi từ, chỉ **4/12** từ lấy được sense thật (light, match, right, lead). **8/12** từ (run, bank, bat, spring, fair, close, address, minute) dùng bộ định nghĩa viết tay dự phòng, cột "senses từ" ghi `fallback`. Thử nghiệm đánh giá hành vi của Google với kiểu câu hỏi này, nhưng chưa phải toàn bộ dữ liệu thật của Free Dictionary.

## Bảng kết quả (sau khi áp dụng các chỉnh sửa ở mục "Điều chỉnh")

| Từ | Sense từ | meanings_vi (headline + gloss, đã loại trùng) | ≥ 2 nghĩa khác nhau và đúng? |
|---|---|---|---|
| run | fallback | chạy | **Không** (1 nghĩa) |
| light | free-dictionary | ánh sáng; đốt lửa; nhẹ | Có |
| bank | fallback | ngân hàng; bờ | Có |
| bat | fallback | con dơi; đánh bóng; gậy bóng chày | Có |
| match | free-dictionary | cuộc thi đấu; trận đấu; phù hợp | Có (2 nghĩa khác thật sự: trận đấu, phù hợp) |
| spring | fallback | mùa xuân; nhảy; lò xo; suối | Có (4/4) |
| right | free-dictionary | Phải; bên phải; đúng vậy; đúng | Có (bên phải, đúng) |
| lead | free-dictionary | chỉ huy; chì; dẫn đầu | Có (3/3) |
| fair | fallback | hội chợ; công bằng; khá | Có |
| close | fallback | đóng; gần; kết thúc | Có |
| address | fallback | Địa chỉ | **Không** (1 nghĩa) |
| minute | fallback | phút; biên bản | Có |

**Đạt 10/12** (ngưỡng của prompt là 9/12). Với 4 từ có sense thật từ Free Dictionary: 4/4 đạt.

## Số liệu từ 44 câu trả lời của Google

| Kiểm tra | Kết quả |
|---|---|
| Giữ lại dấu `:` | **44/44** (không lần nào bỏ, đổi sang dấu khác hay dịch dấu) |
| Phần trước dấu `:` dịch đúng thành nghĩa ngắn | 37/44 hợp lý |
| Gloss để nguyên tiếng Anh (không dịch) | 2/44 (bank "Bank", fair "fair") |
| Gloss dài hơn 40 ký tự hoặc hơn 5 từ | 0/44 |
| Thực thể HTML còn sót | 0/44 |
| Gloss viết hoa chữ đầu | 38/44 (cần hạ chữ thường); headline viết hoa 4/12 ("Phải", "Địa chỉ", …) |

## Các lỗi gặp

1. **Tiền tố lấn át định nghĩa (lỗi chính).** Google dịch phần "từ:" theo từ gốc chứ không theo định nghĩa đi kèm, nên các sense khác loại từ nhận cùng một gloss:
   - `address`: danh từ "địa chỉ" đúng, nhưng động từ "nói chuyện với", "giải quyết" và danh từ "bài diễn văn" đều ra "địa chỉ".
   - `run`: cả ba sense đều "chạy" (gần đúng nhưng chỉ 1 nghĩa).
   - `minute` tính từ "cực nhỏ" ra "phút" (sai); `right` với "Straight, not bent" ra "bên phải" (sai).
   Cộng lại khoảng **7/44** gloss sai hoặc không dùng được (bank #2, fair #3, address #2 #3 #4, right #1, minute #2).
2. **Gloss để nguyên tiếng Anh** khi từ nhiều nghĩa ("Bank:", "fair:"). Nếu giữ lại, người dùng sẽ thấy "bank" làm nghĩa tiếng Việt.
3. **Gloss trùng nghĩa nhưng khác chuỗi:** "con dơi" và "dơi", "Phải" và "bên phải" (đúng hơn là hai nghĩa gần nhau), "cuộc thi đấu" và "trận đấu".
4. **Chọn sense theo thứ tự của Free Dictionary** có thể bỏ sót nghĩa phổ biến (match: "que diêm" không nằm trong 4 sense được chọn).

Không gặp: Google bỏ dấu `:`, đổi dấu, dịch cả câu gộp, trả gloss quá dài.

## Điều chỉnh đã áp dụng (đều nằm trong `services/lookup/senseSelection.ts`)

- **Bộ tách:** giữ dấu `:` (và `：` toàn chiều rộng cho an toàn). **Không** thêm dấu gạch ngang như gợi ý của prompt vì dữ liệu cho thấy không cần (0/44 lần Google bỏ `:`) và " - " xuất hiện bên trong định nghĩa sẽ gây tách sai.
- **Echo:** gloss giống hệt từ gốc bị loại, trừ khi headline cũng giống hệt từ gốc (từ vay mượn như taxi). Sửa `bank` và `fair`.
- **Loại trùng bỏ qua từ loại đứng đầu** (con, cái, chiếc, việc, sự, cuộc, người): "con dơi" = "dơi".
- Hạ chữ cái đầu của mọi nghĩa (kể cả headline) về chữ thường khi ghép `meanings_vi`.

## Đánh giá và khuyến nghị

- Về ngưỡng của prompt (≥ 9/12): **đạt (10/12)**, nên đường nhanh vẫn dùng kỹ thuật này như thiết kế.
- Nhưng chất lượng từng nghĩa chỉ ở mức vừa phải: khoảng 1/6 gloss sai hoặc không dùng được, và với từ có nhiều loại từ cùng chung một chữ như `address`, `run` kỹ thuật này gần như chỉ cho một nghĩa. Dữ liệu ở đây cũng chưa đủ rộng (4 từ có sense thật).
- **Khuyến nghị: nên làm P3b** (bộ dịch nhanh bằng Haiku, trả JSON có cấu trúc đúng theo từng sense) nếu muốn nghĩa tiếng Việt thật sự đúng theo từng sense. Chưa cần làm ngay: bản tạm vẫn dùng được, và việc làm giàu nền (P6) sẽ thay bản tạm bằng mục từ chuẩn sau lần tra đầu.
- Việc cần làm khi Free Dictionary ổn định: chạy lại `npx tsx scripts/smoke/multimeaning-experiment.ts` để thay 8 từ fallback bằng sense thật.

---

# P3b · Google (kỹ thuật tiền tố) so với Claude Haiku làm bộ dịch nhanh

Ngày đo: 14/10/2026 · Script: `scripts/smoke/fast-translator-benchmark.ts` · Số liệu thô của lần chạy thứ hai: `tests/fixtures/lookup/fast-translator-benchmark.json`.
Chọn chế độ bằng `LOOKUP_FAST_TRANSLATOR` = `google` (mặc định) hoặc `haiku`. Haiku lỗi, timeout, hết ngân sách hoặc mạch ngắt mở thì tự rơi về Google (chỉ bước 1). Hợp đồng response không đổi; trong chế độ haiku, `providers` có thêm `claude_haiku`.

## Cách đo

- Máy dev ở Việt Nam, dịch vụ thật (Google Translate, Claude Haiku 5.5 `claude-haiku-5-5`, Free Dictionary), sổ ngân sách giả để không cần DB.
- **A. Độ trễ thô** của riêng bước dịch: 20 lần mỗi chế độ, gọi xen kẽ (Google, Haiku, Google, …) để cùng điều kiện mạng, timeout rộng 15 giây để thấy phân phối thật. Chạy **hai lần** vì phần đuôi của Haiku dao động mạnh.
- **B. Đường nhanh đầy đủ** với cấu hình thật (`LOOKUP_UPSTREAM_TIMEOUT_MS=2500`, `LOOKUP_TOTAL_DEADLINE_MS=3000`): bộ dịch chạy song song với Free Dictionary, rồi bước 2. 20 tra cứu mỗi chế độ, xen kẽ.
- Với n = 20, p95 thực chất là mẫu lớn thứ hai; coi là ước lượng thô.

## Độ trễ

**A. Bước dịch một mình**

| Chế độ | Lần chạy | p50 | p95 | nhỏ nhất | lớn nhất | Chậm hơn 2.500 ms |
|---|---|---|---|---|---|---|
| Google | 1 | 111 ms | 276 ms | 88 | 281 | 0/20 |
| Google | 2 | 109 ms | 124 ms | 83 | 322 | 0/20 |
| **Haiku** | 1 | **1.882 ms** | **9.053 ms** | 1.204 | 10.320 | **3/20** |
| **Haiku** | 2 | **1.681 ms** | **2.024 ms** | 1.241 | 2.713 | **1/20** |

- Gọi Haiku đầu tiên sau khi khởi động (biên dịch schema + mở kết nối) mất khoảng **2,5 đến 2,8 giây** (2.832 ms và 2.496 ms trong hai lần chạy).
- Haiku chậm hơn Google khoảng **15 đến 17 lần ở p50**. Lần chạy 1 có 3 cuộc gọi vượt timeout (đuôi tới 10 giây), lần chạy 2 chỉ 1 cuộc.

**B. Đường nhanh đầy đủ (lần chạy 2, cấu hình production)**

| Chế độ | Tổng p50 | Tổng p95 | Bước dịch p50 / p95 | Free Dictionary p50 / p95 | Kết quả |
|---|---|---|---|---|---|
| google | **287 ms** | 3.006 ms | 110 / 212 ms | 149 / 3.006 ms | đủ 8, partial 12 |
| haiku | **1.882 ms** | 3.007 ms | 1.740 / 2.049 ms | 118 / 3.007 ms | đủ 8, partial 12, 0 lần rơi dự phòng |

- Ở p95 hai chế độ ngang nhau (khoảng 3 giây) vì **Free Dictionary là điểm nghẽn chung**: chỉ **8/20** tra cứu lấy được dữ liệu từ Free Dictionary (12/20 bị 404 HTML hoặc treo tới hết timeout), nên bước 2 bị bỏ qua và kết quả là `partial`.
- Ở p50 Haiku làm người dùng chờ khoảng **1,9 giây** thay vì khoảng **0,3 giây**.

## Chi phí

| Hạng mục | Google | Haiku |
|---|---|---|
| Bước dịch nghĩa chính | ~7 ký tự (tên từ) ≈ **$0,00014** theo giá niêm yết $20/triệu ký tự (chưa kiểm chứng lại trong phiên này) | trung bình **668 token vào + 84 token ra** (~450 token là prompt và schema) ≈ **$0,000108** (giá Haiku 5.5: $0,10 vào, $0,50 ra mỗi triệu token) |
| Bước 2 (dịch định nghĩa, giống nhau ở cả hai chế độ) | ~250 ký tự khi Free Dictionary trả được dữ liệu ≈ **$0,005** | như Google |
| Tổng mỗi tra cứu đầy đủ | ≈ **$0,0051** | ≈ **$0,0051** (chênh dưới 1%) |

- Chi phí gần như **không đổi** giữa hai chế độ: bước 2 (Google) chiếm gần hết. Haiku chỉ thay phần "nghĩa chính" vốn rất rẻ.
- Muốn giảm chi phí thật sự: chế độ haiku kèm `LOOKUP_TRANSLATE_DEFINITIONS=false` còn khoảng **$0,0001 mỗi tra cứu** (rẻ hơn khoảng 50 lần) và không tiêu hạn mức ký tự Google, nhưng `senses[].definition_vi` sẽ là `null`.
- Hạn mức ký tự Google `GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT=450000` cho khoảng **1.800 tra cứu có bước 2 mỗi tháng** (250 ký tự mỗi lần) ở cả hai chế độ.
- Token Haiku được ghi vào `api_usage_counters` (provider `anthropic_fast`, ngày UTC).

## Chất lượng nghĩa (12 từ thử)

Haiku (lần chạy 2; lần chạy 1 cho kết quả gần giống, khác vài nghĩa phụ vì không đặt được `temperature`) so với chế độ google (kết quả P3 sau các chỉnh sửa):

| Từ | Chế độ google | Chế độ haiku (kèm loại từ) |
|---|---|---|
| run | chạy | chạy (verb); quản lý (verb); chuyến đi (noun) |
| light | ánh sáng; đốt lửa; nhẹ | ánh sáng (noun); nhẹ (adj); nhẹ nhàng (adj); bật (verb) |
| bank | ngân hàng; bờ | ngân hàng (noun); bờ (noun); gửi tiền (verb) |
| bat | con dơi; đánh bóng; gậy bóng chày | con dơi (noun); cây gậy (noun); đánh bóng (verb) |
| match | cuộc thi đấu; trận đấu; phù hợp | trận đấu (noun); que diêm (noun); phù hợp (verb); tương xứng (verb) |
| spring | mùa xuân; nhảy; lò xo; suối | mùa xuân (noun); lò xo (noun); nhảy (verb); suối nước (noun) |
| right | phải; bên phải; đúng vậy; đúng | đúng (adj); phải (adj); quyền (noun); ngay (adv) |
| lead | chỉ huy; chì; dẫn đầu | dẫn dắt (verb); chì (noun); sự dẫn đầu (noun); vai chính (noun) |
| fair | hội chợ; công bằng; khá | công bằng (adj); đẹp (adj); hội chợ (noun); khá (adv) |
| close | đóng; gần; kết thúc | đóng (verb); gần (adj); thân thiết (adj); gần gũi (adv) |
| address | địa chỉ | địa chỉ (noun); bài diễn văn (noun); giải quyết (verb) |
| minute | phút; biên bản | phút (noun); tí xíu (adj) |

**Đánh giá (người đọc):** có ít nhất 2 nghĩa khác nhau và đúng: **google 10/12, haiku 12/12**.
- Haiku sửa đúng hai từ Google hỏng: `address` (địa chỉ, bài diễn văn, giải quyết) và `run` (chạy, quản lý, chuyến đi); thêm các nghĩa Google bỏ sót như `match` → "que diêm", `lead` → "vai chính", `minute` → "tí xíu".
- Mỗi nghĩa có loại từ, và ít gloss sai theo kiểu "định nghĩa này nhưng gloss của nghĩa khác" (lỗi chính của kỹ thuật tiền tố).
- Lỗi còn lại của Haiku: vài nghĩa gần trùng ("nhẹ" và "nhẹ nhàng", "gần" và "gần gũi"), thỉnh thoảng nghĩa lạ ("ảnh hưởng" cho `colour`, "liên tiếp" cho `running`). Kết quả thay đổi giữa các lần chạy.
- **Từ không có thật:** `qwxz` → Haiku trả mảng rỗng (đúng ý "không phải từ tiếng Anh"), Google chỉ lặp lại `qwxz`. **Từ vay mượn:** `taxi` → "xe taxi", "đi taxi". Dạng biến `running` → "sự chạy", "đang chạy".

## Phát hiện khi chạy thật qua đường production (`scripts/smoke/lookup-live.ts`, `LOOKUP_FAST_TRANSLATOR=haiku`)

Chạy dịch vụ tra từ thật (DB Neon + Google + Haiku + Free Dictionary) cho `ubiquitous` và `run`:

- **Lỗi thiết kế đã sửa.** Lần đầu, kết nối DB nguội mất 1,7 giây, Haiku chạm hạn chót 3 giây và Google fallback **không còn thời gian**, nên `ubiquitous` trả về **không có bản dịch** (`translation_vi: null`). Test mock không thấy lỗi này. Cách sửa: Haiku chỉ được dùng tới (hạn chót trừ 500 ms); còn ít hơn thế thì bỏ qua Haiku và gọi Google ngay (`fallback_reason: "no_time"`). Có test cho cả hai nhánh.
- **Sau khi sửa**, `ubiquitous` ra bản dịch Google sau ~2,8 giây (hai lần đều `translator: "google_fallback"`, lý do `timeout`: Haiku không kịp phần thời gian còn lại ~1,8 giây). `run` được Haiku trả lời trong ~2,1 giây (`chạy; điều hành; vận hành`).
- Với cấu hình mặc định (timeout 2500 ms, hạn chót 3000 ms), **chế độ haiku thực tế thường rơi về Google hoặc dùng gần hết hạn chót**, và bước 2 (dịch định nghĩa) hay bị bỏ vì hết thời gian (`step2: skipped_no_time`). Chế độ google trên cùng các từ mất ~0,3 đến 0,6 giây.
- Token Haiku được ghi vào `api_usage_counters` đúng như thiết kế (provider `anthropic_fast`: 667 token vào và 88 token ra cho lần gọi thành công).

## Khuyến nghị

1. **Giữ `google` làm mặc định cho production.** Haiku tốt hơn rõ về chất lượng (12/12 so với 10/12, có loại từ) nhưng chậm hơn ~16 lần ở p50 (1,7 đến 1,9 giây so với 0,1 giây) và có đuôi dài (một lần chạy đo được p95 tới 9 giây). Với thao tác "chạm một từ khi đang đọc", tổng thời gian ~1,9 giây ở p50 là quá chậm so với ~0,3 giây.
2. **Haiku không giúp được điểm nghẽn thật: Free Dictionary** (chỉ 8/20 tra cứu lấy được dữ liệu; kéo p95 của cả hai chế độ lên ~3 giây). Nên xử lý sớm bằng dữ liệu Wiktionary cục bộ (P4) để Free Dictionary không còn nằm trên đường găng.
3. **Cách dùng Haiku hợp lý hơn: làm nền (P6).** Mục từ làm giàu bởi Haiku sẽ thay bản tạm sau lần tra đầu, nên không cần trả giá độ trễ ở đường nhanh.
4. **Nếu vẫn muốn bật `haiku` ở production:** tăng `LOOKUP_UPSTREAM_TIMEOUT_MS` lên khoảng 4000 và `LOOKUP_TOTAL_DEADLINE_MS` lên khoảng 5000 để tỉ lệ rơi dự phòng thấp; cân nhắc `LOOKUP_TRANSLATE_DEFINITIONS=false` để tiết kiệm hạn mức Google; chấp nhận lần tra đầu tiên sau mỗi lần khởi động chậm ~2,5 giây (nên gọi làm nóng khi khởi động nếu bật). Giữ nguyên cơ chế tự rơi về Google.
