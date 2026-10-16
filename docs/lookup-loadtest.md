# WordyGo · Tải, hiệu năng truy vấn và máy chủ giả (P7)

Đo ngày 15/10/2026; mục 2.6 (kịch bản D, sau khi việc gửi job chạy sau response) đo ngày 16/10/2026 · Node v24.14, Windows 11 · DB: Neon ở Singapore (`ep-divine-field-…ap-southeast-1`), **gọi từ máy dev, không cùng vùng với DB** · Đặc tả: `docs/lookup-spec.md` §5 F6, F7, F8, §11, §12.

> **Đọc phần 0 trước.** DB dev nằm xa máy chạy (một câu `SELECT 1` mất **72 ms**; pool mặc định 10 kết nối cho ~**56 câu truy vấn/giây**). Mỗi lần tra tốn khoảng 4 đến 5 câu truy vấn, nên môi trường này chặn ở khoảng **11 lần tra mỗi giây**, rất xa mức của một máy chủ đặt cạnh DB. Các số tuyệt đối về độ trễ dưới đây phản ánh **DB từ xa**, không phản ánh mã. Phần mã (single-flight, giới hạn F6, bộ nhớ, số request ra ngoài) được kiểm tra riêng và không phụ thuộc vào điều đó.

## 0. Tóm tắt

| Câu hỏi | Kết quả |
|---|---|
| Single-flight: 200 request đồng thời cùng một từ mới | **Đúng 1 request Google và 1 request Free Dictionary** (mục 2.2). Kịch bản chính (nguồn chậm 10 s) và mọi vòng đo ở mục 2.1 đều cho đúng 1 chuyến bay cho từ chung khi DB không làm các request đến rời rạc |
| Giới hạn F6 (`LOOKUP_MISS_RATE_LIMIT_PER_MIN=20`) | **20 lần miss được nhận, 5 lần sau bị 429** `LOOKUP_RATE_LIMITED`, `Retry-After: 60`; request bị từ chối **không tới** Free Dictionary; người dùng khác không bị ảnh hưởng (mục 2.3) |
| p50 / p95 | Phụ thuộc DB: **2,0 đến 3,0 s / 2,0 đến 3,0 s** với tải mà DB từ xa chịu được (45 request/vòng); 8,8 đến 13 s với đúng tải đề bài (250 request/vòng) vì **hàng chờ kết nối DB** (mục 2.1). Thời gian riêng của các nguồn ngoài: ~0,4 s (bước 1) |
| p50 / p95 khi việc gửi job chạy SAU response (kịch bản D, 16/10/2026) | **855 đến 880 ms / 893 đến 902 ms**, so với **1.275 / 1.426 ms** của mã cũ đo trong cùng điều kiện (gửi job thật vào pg-boss, 30 từ mới, nguồn ngoài giả trễ 300 ms). Mức giảm bằng đúng thời gian một lần gửi (320 đến 410 ms). Chi tiết ở mục 2.6 |
| Heap trước và sau | **Không tăng**: 36,7 → 38,9 → 37,6 MB (2 vòng × 250 request); thay đổi từ −1,0 đến +1,7 MB trong ba lần chạy đo (mục 2.4) |
| Lỗi tìm thấy khi đo | **Hai lỗi thật** (đã vá, có test): bộ làm sạch từ bậc hai (một thân 1 MB chặn máy chủ hàng chục phút), và truy vấn F4 / S0 không dùng được chỉ mục `lower()` (42 đến 56 ms mỗi lần tra ở 200.000 mục từ). Chi tiết ở `docs/lookup-audit.md` mục 4 |
| EXPLAIN | Mọi truy vấn trên đường tra dưới 1 ms; sau khi sửa F4 và S0, **dùng đủ** `lower(headword)`, `lower(lemma)`, `lower(form_value)`, chỉ mục `word` của `ref_wiktionary_en`. **Không cần migration chỉ mục mới** (mục 3) |

## 1. Công cụ

### 1.1 Máy chủ giả (`scripts/mock-upstream/server.ts`)

Một máy chủ HTTP cục bộ giả lập ba dịch vụ, trả dữ liệu từ fixture của P2/P3 (`tests/fixtures/lookup/`); từ không có fixture thì được tổng hợp từ mục `hello`. **Chỉ dùng cho dev và test**: lắng nghe `127.0.0.1`, trả 403 cho peer không phải loopback, từ chối khởi động khi `NODE_ENV=production`, nằm trong `scripts/` (bị `tsconfig.json` loại khỏi bản build; có test), không giữ khóa API.

```bash
npm run mock:upstream -- --port 4010
```

Trỏ ứng dụng vào nó bằng ba biến **đã có** (không biến mới), ví dụ trong một shell tạm, không sửa `.env`:

```bash
GOOGLE_TRANSLATE_BASE_URL=http://127.0.0.1:4010/language/translate/v2
FREE_DICTIONARY_BASE_URL=http://127.0.0.1:4010/api/v2/entries/en
DATAMUSE_BASE_URL=http://127.0.0.1:4010
```

| Giả lập | Đường dẫn |
|---|---|
| Google Cloud Translation v2 | `POST /language/translate/v2` (cần header `X-Goog-Api-Key`, thiếu thì 400 như thật) |
| Free Dictionary | `GET /api/v2/entries/en/:word` |
| Datamuse | `GET /words?rel_syn=<w>` hoặc `rel_ant=<w>`, `max` |
| Điều khiển (không bị đếm, không bị trễ) | `GET /__health` · `GET /__stats` · `GET` và `POST /__control` · `POST /__reset` (`?keep=control` giữ hành vi và xóa bộ đếm, `?keep=stats` ngược lại) |

`POST /__control` nhận JSON (từng khóa thay thế khóa cũ; `null` xóa):

```json
{
  "google": { "mode": "status", "status": 429, "retryAfter": 2, "latencyMs": 300 },
  "fd": { "mode": "html" },
  "datamuse": { "errorRate": 0.3, "errorStatus": 503 },
  "rules": [ { "provider": "fd", "words": ["qzq*", "run"], "behavior": { "mode": "not_found" } } ],
  "unknownWord": "synthesize",
  "aliases": { "zorp": "hello" },
  "seed": 1
}
```

| Hành vi (`mode`) | Ý nghĩa |
|---|---|
| `ok` (mặc định) | trả theo fixture |
| `status` + `status` (+ `retryAfter`) | trả mã lỗi bất kỳ, ví dụ 500, 503, 429 có hoặc không có `Retry-After` |
| `hang` | không bao giờ trả lời (socket mở cho tới khi client bỏ) |
| `drop` | cắt kết nối không trả lời (lỗi mạng cho client) |
| `html` | trang HTML thay vì JSON (lỗi CDN của Free Dictionary), mặc định 404 |
| `invalid_json` | 200 với thân không phải JSON |
| `short_array` | Google trả thiếu một phần tử |
| `not_found` | Free Dictionary trả 404 JSON "No Definitions Found" |
| `latencyMs`, `jitterMs` | độ trễ cố định và ngẫu nhiên trước khi trả lời |
| `errorRate`, `errorStatus`, `seed` | tỉ lệ 5xx ngẫu nhiên, lặp lại được theo `seed` |
| `failFirst` | N request đầu thất bại rồi trở lại bình thường |
| `echoKey` | Google lặp lại khóa API trong thông báo lỗi (để thử xem có chỗ nào in khóa ra không) |

`rules` ghi đè theo từ (khớp chính xác hoặc tiền tố kết thúc bằng `*`; `provider: "*"` là mọi nhà cung cấp); luật đầu tiên khớp thắng mặc định của nhà cung cấp. `GET /__stats` trả: tổng, và với mỗi nhà cung cấp: số request, số request đồng thời cao nhất, mã trả về, số request theo từ, số request treo; Google còn có số request "đầu từ" và "định nghĩa", số ký tự; mọi nhà cung cấp có `keyInUrl` (khóa nằm trong URL: phải là 0) và `keyHeaderSeen`.

Dùng từ test: `startMockUpstream()` trả về `{ url, env, stats(), setControl(), reset(), close() }` (xem `tests/helpers/lookupApp.ts`, chương trình khởi động ứng dụng thật trỏ vào nó, kèm một **lá chắn mạng** làm `fetch` từ chối mọi máy chủ không phải loopback). Test của chính máy chủ giả: `tests/e2e/mockServer.test.ts`.

### 1.2 Kịch bản tải (`scripts/loadtest/lookup-burst.ts`)

Không thêm thư viện: `fetch` của Node, máy chủ giả trong tiến trình cha, ứng dụng Express thật chạy như **tiến trình con** (`app-runner.ts`, khởi động với `--expose-gc` để đo heap sau khi thu gom rác) trỏ vào DB trong `.env`. Dữ liệu thử (264 người dùng `lt-<mã>-N@example.com`, một ebook) được tạo và xóa khi xong; bộ đếm ký tự Google thật được khôi phục. Từ thử đều là `qzq<mã>…`.

```bash
npm run loadtest:lookup                                  # đúng đề bài: 200 + 50 từ, 10 s, trễ 300 ms, 2 vòng
npm run loadtest:lookup -- --same 30 --distinct 15       # tải nhỏ hơn
npm run loadtest:lookup -- --deadline 60000              # nới LOOKUP_TOTAL_DEADLINE_MS của ứng dụng trong kịch bản A
npm run loadtest:lookup -- --skip-slow --json out.json   # bỏ kịch bản B (chờ ~20 s), ghi thêm JSON
npm run loadtest:lookup -- --only-send                   # chỉ kịch bản D (khoảng 1 đến 2 phút, phần lớn là pg-boss tạo schema riêng)
npm run loadtest:lookup -- --skip-send                   # bỏ kịch bản D
```

| Kịch bản | Làm gì | Kiểm tra (in PASS/FAIL; mã thoát 1 nếu có FAIL) |
|---|---|---|
| **A** nền | 200 request cùng một từ mới **cùng lúc**, cộng 50 từ khác nhau rải đều trong 10 s, nguồn ngoài trễ 300 ms, lặp `--rounds` vòng | mọi request 200 và đầy đủ; mọi request ra ngoài thuộc đúng một chuyến bay (FD = đầu từ = định nghĩa = số chuyến bay); 200 = chuyến bay + người nhập chung; mỗi từ khác chỉ tới Free Dictionary đúng 1 lần; heap không tăng bất thường |
| **B** single-flight | 200 request cùng một từ mới, trong khi chuyến bay duy nhất kéo dài 10 s (mọi request tới trong lúc đó); `LOOKUP_TRANSLATE_DEFINITIONS=false` để "một request Google" là nghĩa đen | Free Dictionary nhận **đúng 1**, Google nhận **đúng 1**; log của ứng dụng: 1 chuyến bay + 199 người nhập chung |
| **D** trả lời và gửi job | `--send` từ mới (mặc định 30) lần lượt từng từ, `ENRICHMENT_ENABLED=true` với bộ gửi pg-boss THẬT trong schema riêng `lt_<mã>` (không worker nên không job nào được xử lý), nguồn ngoài giả trễ `--latency` ms | mọi câu 200 đầy đủ và `enrichment.status = "queued"`; mọi từ có hàng trong sổ job (việc gửi nền có chạy); mọi lần gửi nền ra `queued`; thời gian trả lời nhỏ hơn "trả lời cộng thời gian gửi". Dọn xong: hàng sổ job, ô đếm job của ngày (`api_usage_counters`), schema `lt_<mã>` |
| **C** F6 | một người dùng hỏi 25 từ mới cùng lúc | đúng 20 được nhận, 5 bị 429 với `Retry-After` nguyên từ 1 đến 60; request bị từ chối không tới nguồn ngoài; request tiếp theo vẫn 429; người dùng khác không bị ảnh hưởng |

Tiến trình cha còn lấy mẫu hàng chờ của pool DB (`waitingCount`) mỗi 400 ms và đợi pool "xả" (các câu `INSERT word_lookups` / `words_looked_up` chạy ngầm) giữa các giai đoạn.

## 2. Kết quả tải

### 2.1 Kịch bản A, đúng đề bài: 200 cùng một từ + 50 từ khác, trễ nguồn 300 ms, 2 vòng

**Lần 1: ứng dụng với cấu hình mặc định (`LOOKUP_TOTAL_DEADLINE_MS=3000`)**

| | số request | p50 | p95 | max | mã trả về |
|---|---|---|---|---|---|
| vòng 1, cùng một từ | 200 | 9.229 ms | 9.258 ms | 9.259 ms | 503 × 200 |
| vòng 1, 50 từ khác | 50 | 6.575 ms | 9.498 ms | 9.733 ms | 200 × 19, 503 × 31 |
| vòng 2, tất cả | 250 | 8.764 ms | 9.865 ms | 10.868 ms | 200 × 16, 503 × 234 |

Hàng chờ kết nối DB đạt đỉnh **396 request**; theo log của ứng dụng, việc cục bộ (truy vấn từ điển) mất p50 **2.855 ms**, p95 **6.173 ms**. Hạn chót 3 s tính từ **đầu** lần tra (đúng spec §5) đã cạn trước khi tới bước gọi nguồn ngoài, nên **máy chủ giả không nhận request nào** và hầu hết trả 503 `TRANSLATION_UNAVAILABLE`. Đây là hỏng **có kiểm soát** (đúng ma trận §6, không treo, không 500) nhưng là **quá tải DB**, không phải lỗi logic.

**Lần 2: cùng tải, `--deadline 60000` (để hàng chờ DB không làm hết hạn chót)**

| | p50 | p95 | max | mã trả về |
|---|---|---|---|---|
| vòng 1: cùng một từ (200) | 10.565 ms | 10.589 ms | 10.591 ms | 200 × 200 |
| vòng 1: 50 từ khác | 8.528 ms | 12.712 ms | 13.038 ms | 200 × 50 |
| vòng 1: tất cả (250) | 10.564 ms | 11.000 ms | 13.038 ms | 200 × 250 |
| vòng 2: tất cả (250) | 13.001 ms | 13.020 ms | 13.113 ms | 200 × 250 |

Mọi kiểm tra đều đạt: **1 chuyến bay + 199 người nhập chung** cho từ chung ở cả hai vòng (máy chủ giả: 1 Free Dictionary, 1 Google đầu từ, 1 Google định nghĩa), mỗi từ khác chạm Free Dictionary đúng 1 lần. Thời gian dài là **hàng chờ DB** (đỉnh 388 đến 407), không phải nguồn ngoài (bước 1 của chuyến bay: p50 0,4 s ở tải nhẹ, 0,5 đến 2,1 s ở tải nặng, nguồn giả trễ 300 ms).

**Lần 3: tải mà DB từ xa chịu được (30 cùng một từ + 15 từ khác trong 10 s, cấu hình mặc định)**

| | p50 | p95 | max | mã trả về | hàng chờ DB cao nhất |
|---|---|---|---|---|---|
| vòng 1, tất cả (45) | 3.021 ms | 3.027 ms | 3.287 ms | 200 × 45 | 52 |
| vòng 2, tất cả (45) | 2.041 ms | 2.049 ms | 2.094 ms | 200 × 45 | 50 |

Cả hai vòng: 1 chuyến bay + 29 người nhập chung; việc cục bộ p50 183 ms. Từ khác (15) p50 1,1 s.

**Độ trễ trong một môi trường thật.** Mỗi lần tra tốn ~4 đến 5 câu truy vấn nhỏ (xác thực JWT, F4, tra ref, hai lần ghi chạy ngầm). Nếu ứng dụng đặt cạnh DB (khoảng 1 đến 2 ms mỗi câu, pool 10 kết nối): ~5.000 đến 6.500 câu/giây, tức hàng trăm lần tra mỗi giây trước khi pool đầy. Khi đó độ trễ một lần tra "từ mới" gần bằng bước 1 + bước 2 của nguồn ngoài (0,3 + 0,3 s trong thử nghiệm này, 0,4 đến 0,6 s với Google và Free Dictionary thật, xem `docs/lookup-api.md`), vì phần cục bộ chỉ còn vài mili giây. **Đây là ước tính từ số đo ở trên, chưa đo trực tiếp.**

**Khuyến nghị (không làm trong P7, ghi để bạn quyết):**
1. Triển khai ứng dụng cùng vùng với Neon (Railway Singapore) hoặc dùng endpoint pooled; đo lại bằng chính kịch bản này.
2. Khi hàng chờ DB dài, hệ thống **xếp hàng thay vì từ chối sớm**: không có giới hạn đồng thời hay "bỏ sớm khi đã quá hạn chót ở bước cục bộ". Một bộ giới hạn đồng thời (ví dụ 50 lần tra đang chạy, vượt thì 503 ngay) sẽ giữ độ trễ của những người còn lại thấp. Cần quyết định vì đổi hành vi dưới tải.
3. Pool mặc định của `pg` là 10. Sau khi ở cùng vùng, cân nhắc nâng (`new Pool({ max })` trong `config/db.ts`, hiện không cấu hình được; thêm biến môi trường là ngoài phạm vi của prompt này).

### 2.2 Kịch bản B, single-flight: 200 request cùng một từ trong lúc một chuyến bay kéo dài 10 s

| | kết quả |
|---|---|
| request | 200, mọi request trả **200 đầy đủ** (không `partial`) |
| thời gian | 18.437 ms toàn bộ (10 s của chuyến bay + hàng chờ DB); p50 18.406 ms |
| máy chủ giả nhận | **Free Dictionary 1 request, Google 1 request** cho từ chung |
| log của ứng dụng | **1 chuyến bay (`shared:false`) + 199 người nhập chung (`shared:true`)** |

Một lần chạy riêng trước đó (cùng kịch bản, DB đang rảnh hơn): 32.108 ms và cùng kết quả 1 / 1. Test đơn vị tương ứng: `tests/lookup/lookupService.test.ts` ("50 simultaneous lookups of one word make ONE Google call and ONE Free Dictionary call").

Vì sao cần chuyến bay dài để chứng minh: single-flight chỉ gộp những request **đang chạy cùng lúc ở bước gọi nguồn ngoài**. Khi hàng chờ DB rải các request ra hàng giây (kịch bản A, 300 ms mỗi chuyến), các request đến muộn đúng là bắt đầu một chuyến bay mới (đã thấy 2 chuyến bay ở lần 1). Điều bảo đảm là **mỗi chuyến bay chỉ gọi mỗi nguồn đúng một lần** (kiểm tra ở kịch bản A: FD = đầu từ = định nghĩa = số chuyến bay) và **không có bộ nhớ đệm**: spec F7 cấm đệm kết quả.

### 2.3 Kịch bản C, giới hạn F6

20 lần miss đầu của một người dùng được nhận (cả 20 đều 200), 5 lần sau bị **429 `LOOKUP_RATE_LIMITED`** với `Retry-After: 60`; request bị từ chối không tới Free Dictionary; lần miss tiếp theo của cùng người dùng vẫn 429; người dùng khác trả 200. (Kiểm tra đủ đường HTTP cả ở `tests/e2e/lookup.e2e.test.ts` với `LOOKUP_MISS_RATE_LIMIT_PER_MIN=3`: tra từ có trong từ điển không bị tính.)

### 2.4 Bộ nhớ

Heap sau hai lần thu gom rác ép buộc (`--expose-gc`), ứng dụng con:

| Lần chạy | trước | sau vòng 1 | sau vòng 2 | thay đổi |
|---|---|---|---|---|
| 250 request/vòng, hạn chót 3 s | 36,7 MB | 38,9 MB | 37,6 MB | **+0,9 MB** |
| 250 request/vòng, hạn chót 60 s | 36,7 MB | 37,6 MB | 35,7 MB | **−1,0 MB** |
| 45 request/vòng | 36,7 MB | 38,1 MB | 38,4 MB | **+1,7 MB** (vòng cuối +0,3) |

RSS 112 đến 142 MB, tăng nhẹ rồi phẳng. Ngưỡng của kịch bản: tổng tăng dưới 40 MB và vòng cuối dưới 15 MB. Bộ nhớ có giới hạn theo thiết kế: bộ đếm tra từ giữ vòng đệm 500 độ trễ và vài khóa cố định; bộ giới hạn F6 quét người dùng cũ khi vượt 5.000; single-flight xóa khóa khi chuyến bay xong; `LookupMetrics` có test 1.000.000 mẫu giữ nguyên kích thước.

### 2.5 Điều thấy thêm khi chạy, ngoài phạm vi tra từ

* **Khởi động nguội + dồn dập.** Lần chạy đầu (chưa làm ấm pool) cho 200 request: nhiều request mất ~30 s, có cả 401 và 503. Mở đồng thời hơn mười kết nối TLS mới tới Neon làm Neon chậm/hủy. Kịch bản làm ấm pool (`app-runner.ts`, tin nhắn `warm`) trước khi đo; trên thực tế sau mỗi lần triển khai nên có bước làm ấm hoặc tăng dần.
* **`requireApiAuth` biến mọi lỗi DB thành `401 INVALID_TOKEN`** (`middlewares/apiAuth.ts`, khối `catch`). Khi DB chậm hoặc rớt kết nối, ứng dụng di động thấy "token không hợp lệ", dễ hiểu thành đăng xuất. Nên trả 503 cho lỗi không phải JWT. Không sửa ở đây vì đổi hành vi của mọi endpoint.

### 2.6 Kịch bản D: thời gian trả lời khi việc gửi job và ghi `word_lookups` chạy sau response (16/10/2026)

**Vì sao.** Lần nghiệm thu 15/10/2026 cho p95 nhóm C, D, E, H là **3.756 ms**, vượt `LOOKUP_TOTAL_DEADLINE_MS + 500` = 3.500 ms. Hạn chót 3.000 ms chỉ bao truy vấn cục bộ và các cuộc gọi ra ngoài; việc gửi job (một giao dịch pg-boss, khoảng 0,4 giây với DB ở Singapore) và việc ghi `word_lookups` nằm sau hạn chót mà vẫn trước response. Từ spec 1.5 hai việc đó chạy **sau** response (`docs/lookup-spec.md` mục 5 F11, F12). `LOOKUP_TOTAL_DEADLINE_MS` và biên 500 ms không đổi.

**Cách đo.** 30 từ mới, từng từ một (tuần tự, để số đo là chi phí của mã và của các vòng gọi DB, không phải hàng chờ kết nối), `ENRICHMENT_ENABLED=true`, bộ gửi pg-boss thật trong schema riêng, nguồn ngoài giả trễ 300 ms, DB là Neon ở Singapore gọi từ máy dev. Cột "mã cũ" là kết quả đo THẲNG: đặt tạm tệp `services/lookup/lookupService.ts` của commit HEAD vào cây làm việc, chạy `npm run loadtest:lookup -- --only-send --send 30`, rồi trả tệp mới về chỗ cũ.

| | n | p50 | p95 | max |
|---|---|---|---|---|
| **Mã cũ** (gửi job TRƯỚC response), đo thẳng | 30 | 1.275 ms | 1.426 ms | 1.601 ms |
| **Mã mới**, lần chạy 1 | 30 | **855 ms** | **893 ms** | 917 ms |
| mã mới, lần 1, cộng thời gian gửi (`enqueue_ms` trong log `lookup_enrich`) = người dùng đã phải chờ bao lâu nếu việc gửi đứng trước | 30 | 1.270 ms | 1.303 ms | 1.327 ms |
| riêng việc gửi job, lần 1 | 30 | 410 ms | 425 ms | 439 ms |
| **Mã mới**, lần chạy 2 (bản cuối, có gộp các lần gửi cùng từ) | 30 | **880 ms** | **902 ms** | 934 ms |
| mã mới, lần 2, cộng thời gian gửi | 30 | 1.206 ms | 1.243 ms | 1.253 ms |
| riêng việc gửi job, lần 2 | 30 | 320 ms | 349 ms | 354 ms |

Đọc: p50 giảm khoảng 400 ms (−31 đến −33%) và p95 khoảng 520 ms (−37%), khớp với thời gian một lần gửi. Hai cách ước (đo thẳng mã cũ, và "mã mới cộng thời gian gửi") cho cùng một con số trong sai số của Neon (1.275 so với 1.206 đến 1.270). Mọi kiểm tra của kịch bản đạt (30 câu 200 đầy đủ, `enrichment.status = "queued"`, 33 hàng sổ job cho 33 từ kể cả 3 từ làm ấm, mọi lần gửi nền `queued`), cả hai lần chạy của mã mới.

**Trên nghiệm thu thật** (nguồn ngoài thật, Free Dictionary chập chờn khiến nhiều từ chạm hết hạn chót 3.000 ms): p95 của C, D, E, H là **3.389 ms** và **3.432 ms** ở hai lần chạy ngày 16/10, nằm trong giới hạn 3.500 ms (trước đó 3.756 ms). Phần vượt hạn chót của câu chậm nhất giảm từ ~756 ms xuống ~390 đến 430 ms, tức bớt đúng một lần gửi job; còn lại là truy vấn cục bộ, xác thực và HTTP. Xem `docs/lookup-acceptance-report.md`.

**Kiểm tra không thụt lùi ở tải** (`--same 30 --distinct 15 --skip-slow`, cấu hình mặc định, 16/10/2026, bản cuối): 21 trên 21 kiểm tra đạt. 30 cùng một từ cộng 15 từ khác: p50 1.529 / 1.508 ms, p95 1.535 / 1.512 ms (hai vòng); hàng chờ DB cao nhất 50 và 49; 1 chuyến bay + 29 người nhập chung, Free Dictionary và Google mỗi nơi nhận đúng 1 request cho từ chung ở cả hai vòng; F6 đúng 20 nhận và 5 bị 429; heap +1,6 MB sau hai vòng (vòng cuối +0,3 MB). Con số này **không so sánh được** với mục 2.1 lần 3 (3.021 / 2.041 ms): hôm đó và hôm nay DB ở xa chậm khác nhau, và kịch bản A chạy với `ENRICHMENT_ENABLED=false` nên không có việc gửi job; chỉ kết luận được là không có hồi quy (kiểm tra đạt, hàng chờ DB không tăng).

**Điều cần biết.** Trước đây việc gửi job nằm trong request nên số request chạy việc đó cùng lúc bị chặn bởi số request đang chạy. Nay không còn chặn: một đợt tra dồn dập tạo ra các lần gửi cùng lúc, tranh kết nối với những lần tra tiếp theo. Hai biện pháp có trong mã: (1) mỗi tiến trình chỉ chạy **một** lần gửi cho mỗi từ tại một thời điểm (trăm request chung một chuyến bay không còn thành trăm giao dịch pg-boss; hàng đợi vốn chỉ nhận một job mỗi từ), (2) khi tắt gọn (SIGTERM) tiến trình chờ tối đa 10 giây cho các việc nền đang chạy xong (`app.ts`, bước `lookup_background`). Chưa có giới hạn tổng số việc nền chạy cùng lúc: đó là mục "bộ giới hạn đồng thời" của khuyến nghị 2 ở mục 2.1, vẫn để bạn quyết.

## 3. EXPLAIN (ANALYZE, BUFFERS)

`npx tsx scripts/loadtest/explain-lookup.ts [--scale 200000]` (chỉ đọc: mọi câu chạy trong giao dịch `READ ONLY` rồi ROLLBACK; 3 lần chạy mỗi câu, lấy lần thứ 3). **Không có DB staging riêng**: số liệu trên chính DB dev (`dictionary_entries` 852 dòng, `word_forms` 1.607, `ref_wiktionary_en` **189.456**, `ref_word_frequency` **193.844**, `word_enrichment_jobs` 7).

### 3.1 Trạng thái hiện tại

| Truy vấn | thời gian thực thi | chỉ mục dùng |
|---|---|---|
| **F4** theo headword | 0,57 ms | `idx_dict_headword_lower`, `idx_dict_lemma_lower`, `idx_word_forms_value_lower`, `dictionary_entries_pkey` |
| **F4** qua `word_forms` | 0,62 ms | như trên |
| **F4** miss | 0,19 ms (6 buffer) | như trên |
| **F4b** thăm dò "bảng ref có dữ liệu" (cache 5 phút) | 0,04 ms | quét tuần tự `LIMIT 1` (đúng ý: dừng ở dòng đầu) |
| **F4b** tìm lemma của dạng biến (`children`) | 0,05 ms | `idx_ref_wikt_en_word` |
| **F4b** từ lạ | 0,05 ms | `idx_ref_wikt_en_word` |
| F11 "từ đáng tin" (ref_wiktionary_en / ref_word_frequency) | 0,05 / 0,05 ms | `idx_ref_wikt_en_word` / `ref_word_frequency_pkey` |
| **S0** đã có mục từ (headword / form / không có) | 0,13 / 0,11 / 0,08 ms | `idx_dict_headword_lower`, `idx_dict_lemma_lower`, `idx_word_forms_value_lower` |
| S1 dòng Wiktionary / tần suất | 0,05 / 0,04 ms | `idx_ref_wikt_en_word` / `ref_word_frequency_pkey` |
| enqueuer: mục từ đã tồn tại | 0,11 ms | ba chỉ mục `lower()` (BitmapOr) |
| enqueuer: hàng đang hoạt động | 0,05 ms | quét tuần tự bảng 7 dòng (có ép tắt quét tuần tự thì dùng `idx_word_enrichment_jobs_status_created`) |

Kế hoạch của F4 sau khi sửa (`F4-miss`): `Unique → Sort → Append` của **ba** `Index Scan` (`idx_dict_headword_lower`, `idx_dict_lemma_lower`, `idx_word_forms_value_lower`), rồi `Index Scan using dictionary_entries_pkey` chỉ cho dòng thắng; các truy vấn con của `FULL_ENTRY_SQL` ("never executed" khi không có kết quả).

### 3.2 Phát hiện: F4 và S0 không dùng được `lower(headword)` và `lower(lemma)`

Trước khi sửa, F4 và S0 viết điều kiện là `LOWER(headword) = $1 OR LOWER(lemma) = $1 OR id IN (SELECT … word_forms …)`. PostgreSQL không thể dùng chỉ mục cho một nhánh `OR` chứa sub-plan băm, nên **đọc toàn bộ bảng cho mỗi lần tra** (kể cả ép `enable_seqscan = off` vẫn chỉ quét `idx_dict_published`, không dùng hai chỉ mục `lower()`). Ở 852 dòng chưa thấy (0,44 đến 0,80 ms), nhưng nó là **vách đứng** khi từ điển lớn lên nhờ làm giàu tự động. Đo trên bảng TEMP 200.000 mục từ + 200.000 dạng từ, có chỉ mục `lower()` và đã `ANALYZE`:

| hình dạng truy vấn | theo headword | qua form | từ không có | cách đọc |
|---|---|---|---|---|
| `OR` ba điều kiện (cũ) | 41,7 ms | 55,5 ms | 41,3 ms | quét tuần tự toàn bộ mục từ |
| `UNION` ba tra cứu theo chỉ mục (nay) | **0,13 ms** | **0,10 ms** | **0,08 ms** | chỉ dùng chỉ mục |

(Tái tạo: `npx tsx scripts/loadtest/explain-lookup.ts --scale 200000`.) Đã sửa `lookupLocal` (`services/lookup/localLookup.ts`) và `findExistingEntry` (`services/enrichment/persist.ts`) thành `e.id IN (SELECT id … lower(headword) … UNION SELECT id … lower(lemma) … UNION SELECT entry_id … lower(form_value) …)`: **cùng dòng, cùng thứ tự ưu tiên** (headword, lemma, form), test hiện có không đổi và có thêm test ghim hình dạng (`tests/lookup/localLookup.test.ts`). Trên dữ liệu thật F4 miss giảm từ 31 buffer xuống 6.

### 3.3 Có cần migration chỉ mục mới không?

**Không.** Mọi chỉ mục spec §2 yêu cầu đã có từ migration 33 và nay đều được dùng:

| Chỉ mục | Dùng bởi |
|---|---|
| `idx_dict_headword_lower` (`lower(headword)`) | F4, S0, enqueuer |
| `idx_dict_lemma_lower` (`lower(lemma)`) | F4, S0, enqueuer |
| `idx_word_forms_value_lower` (`lower(form_value)`) | F4, S0, enqueuer |
| `idx_ref_wikt_en_word` (`word`) | F4b, F11, S1 |
| `ref_word_frequency_pkey` (`word`) | F11, S1 |
| `idx_ref_wikt_en_lemma_of` (`lemma_of` một phần) | **không truy vấn nào của tra từ lọc theo `lemma_of`** (F4b lọc `word = $1 AND lemma_of IS NOT NULL`, đi qua chỉ mục `word`); giữ lại theo spec §2 |
| `idx_word_enrichment_jobs_active_word` (duy nhất một phần) | ràng buộc "một hàng hoạt động mỗi từ"; bảng quá nhỏ để trình lập kế hoạch chọn nó |

## 4. Cách chạy lại

```bash
npx tsx scripts/loadtest/explain-lookup.ts --scale 200000   # EXPLAIN + so sánh hình dạng truy vấn ở 200.000 mục từ
npm run loadtest:lookup -- --skip-slow                      # tải, khoảng 2 phút
npm run loadtest:lookup                                     # cả kịch bản B (single-flight), thêm ~30 s
```
