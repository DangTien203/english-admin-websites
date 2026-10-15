# WordyGo · Sổ tay vận hành tra từ và làm giàu từ điển (P7)

Cập nhật 15/10/2026 · Dành cho người trực: khi tra từ chậm, báo 503, hàng đợi đứng, hết ngân sách. Thiết kế: `docs/lookup-spec.md` · Hàng đợi: `docs/lookup-queue.md` · Kiểm toán và rủi ro: `docs/lookup-audit.md` · Đo tải: `docs/lookup-loadtest.md`.

## 1. Công tắc khẩn (spec §11.8)

Cấu hình được đọc và **đóng băng một lần khi khởi động** (`config/lookup.ts`): đổi biến môi trường xong phải **khởi động lại** tiến trình (Railway: đổi biến rồi redeploy).

| Muốn | Đặt | Hiệu lực |
|---|---|---|
| Tắt đường tra qua dịch vụ ngoài (Google, Free Dictionary, Haiku) | `TRANSLATION_FALLBACK_ENABLED=false` | Từ không có trong từ điển: `404 ENTRY_NOT_FOUND`, **0 request ra ngoài**. Từ có trong từ điển vẫn trả bình thường |
| Ngừng gửi job làm giàu mới | `ENRICHMENT_ENABLED=false` | Phản hồi tra từ có `enrichment.status = "disabled"`. Job đang chờ vẫn nằm trong hàng đợi. Worker riêng vẫn xử lý (cờ này chỉ chặn việc gửi) |
| Ngừng xử lý job | `ENRICHMENT_WORKER_ENABLED=false` (ở dịch vụ chạy worker) | Worker không đăng ký; job nằm yên. Dịch vụ API không tự chạy worker nữa |
| Tắt Google nhưng giữ Free Dictionary | để trống `GOOGLE_TRANSLATE_API_KEY` | Google coi như tắt: bản tạm thiếu nghĩa tiếng Việt (`partial`, `missing: ["translation_vi"]`). Cảnh báo một lần khi khởi động |
| Ngừng chi tiêu Anthropic ngay | xóa hoặc thu hồi `ANTHROPIC_API_KEY` ở bảng điều khiển Anthropic | Job dừng với `failed / config_error` (không thử lại). Khi nhà cung cấp tự chặn vì hết hạn mức: `skipped / budget` |

## 2. Quan sát

### 2.1 Ảnh chụp sức khỏe

```bash
npm run health:snapshot        # JSON, chỉ đọc
```

Trả về (`services/lookup/health.ts`, `LookupHealthService.getSnapshot()`; chưa mở qua HTTP, P8 làm):

| Trường | Ý nghĩa |
|---|---|
| `breakers` | `google_translate`, `free_dictionary`, `datamuse`, `anthropic` (job), `anthropic_fast` (đường tra nhanh, mạch riêng): `closed` / `open` / `half_open`, số lỗi liên tiếp |
| `google` | ký tự đã dùng trong tháng (UTC), trần `GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT`, còn lại |
| `anthropic` | token trong tháng: job làm giàu, và đường tra nhanh (cộng các ngày của tháng) |
| `jobs` | số job hôm nay so với `ENRICHMENT_MAX_JOBS_PER_DAY`; số job theo trạng thái |
| `queue` | độ sâu hàng đợi pg-boss: đang chờ, đang chạy, hàng chết (đếm trực tiếp, không khởi động pg-boss); `null` nếu chưa từng cài pg-boss |
| `recentFailures` | 20 job lỗi gần nhất (`failed`, và `skipped / budget`): từ, mã `reason`, thời điểm, số lần thử. Không có người dùng hay ebook |
| `lookups`, `counters` | **trong bộ nhớ của tiến trình đang chạy**: số lần tra theo `source` và `outcome`, tỉ lệ `partial`, p50 / p95 / max của 500 lần tra gần nhất; bộ đếm job và hàng đợi. Chạy bằng dòng lệnh thì hai phần này trống |

Một phần lỗi (ví dụ DB trả lỗi) chỉ làm phần đó thành `{ "error": … }`, phần còn lại vẫn có.

### 2.2 Log có cấu trúc

Một dòng JSON mỗi sự kiện (`console.*`). Khóa API được che trước khi in (`utils/redact.ts`).

| `evt` | Mức | Khi nào | Trường đáng chú ý |
|---|---|---|---|
| `lookup` | info | mỗi lần tra | `word`, `outcome` (`hit`, `temporary`, `not_found`, `unavailable`, `rate_limited`), `source`, `partial`, `latency_ms`, `local_ms`, `google_ms`, `fd_ms`, `step2_ms`, `google` / `fd` (`ok`, `error:timeout`, `error:http_5xx`, `error:breaker_open`, `error:local_rate_limit`, `error:budget_monthly_chars`, …), `shared` (nhập chung một chuyến bay), `enrichment_status` |
| `upstream_config_error` | **error** | nhà cung cấp trả 400/401/403 | `provider`, `http_status`, `where` → **sai khóa hoặc thiếu quyền, sửa cấu hình** |
| `upstream_budget_exceeded` | **error** | nhà cung cấp hết hạn mức chi tiêu | `provider`, `reason` |
| `breaker` | warn khi mở, info khi đổi khác | mạch ngắt đổi trạng thái | `provider`, `scope` (`fast_path`), `from`, `to` |
| `enrich` | info / error | mỗi job xong | `status`, `reason`, `stages_ms`, `input_tokens`, `output_tokens`, `attempt` |
| `enrich_retry`, `enrich_retry_after_wait` | warn | job sẽ được thử lại (có chờ `Retry-After` của nhà cung cấp, tối đa 60 s) | `attempt`, `retry_count`, `wait_ms` |
| `enrich_dead_letter` | error | job vào hàng chết | `row_status_before`, `reason_before` |
| `enrich_stale`, `enrich_reconcile` | warn | dọn hàng treo | `markedStale`, `checked`, `stillLive` |
| `pg_pool_error`, `pg_client_error` | error | DB cắt một kết nối (rảnh, hoặc đang trong giao dịch) | `code` (`57P01` = máy chủ ngắt), `error` |
| `enrich_enqueue_failed` | error | gửi job lỗi (pg-boss hoặc DB) | `error` |

## 3. Chẩn đoán theo triệu chứng

| Triệu chứng | Kiểm tra | Nguyên nhân thường gặp và cách xử lý |
|---|---|---|
| Nhiều `503 TRANSLATION_UNAVAILABLE` | `lookup` log: `google` và `fd` cùng `error:*` | Cả hai nguồn lỗi. Nếu `error:timeout` ở mọi lần kèm `local_ms` lớn: **DB chậm ăn hết hạn chót 3 s** (xem `docs/lookup-loadtest.md` mục 2.1) → kiểm tra DB / pool, `health:snapshot`. Nếu `error:breaker_open`: xem dưới |
| Nhiều bản tạm `partial` | `lookups.partial.rate`; `missing` trong phản hồi | `missing` có `translation_vi` → Google lỗi hoặc hết ngân sách ký tự; có `pos, definition_en, ipa, audio_url` → Free Dictionary lỗi hoặc không có từ. Phản hồi vẫn đúng hợp đồng |
| Một mạch ngắt `open` | `breakers`; log `breaker` | Nguồn đó lỗi liên tiếp `UPSTREAM_BREAKER_FAILURE_THRESHOLD` lần. Sau `UPSTREAM_BREAKER_RESET_MS` tự thử lại một request (nửa mở) và đóng nếu khỏe. Mở **ngay** khi: 400/401/403 (sai khóa), hết hạn mức chi tiêu của nhà cung cấp |
| `google.remaining` về 0 | `health:snapshot` | Hết `GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT`: bản tạm thiếu nghĩa tiếng Việt, **không gọi Google**, mạch không mở. Nâng trần hoặc đợi sang tháng UTC mới |
| Free Dictionary `local_rate_limit` | log `fd: error:local_rate_limit` | Hết `FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN` (bucket nội bộ, mỗi tiến trình một bucket) |
| `429 LOOKUP_RATE_LIMITED` | phản hồi có `Retry-After` | Một người dùng tra quá `LOOKUP_MISS_RATE_LIMIT_PER_MIN` từ chưa có trong từ điển mỗi phút (bộ nhớ từng tiến trình: nhiều bản sao thì giới hạn nhân lên) |
| Job không chạy | `queue.main.waiting` tăng, `active` 0 | Không có worker: kiểm tra `ENRICHMENT_WORKER_ENABLED`, tiến trình `npm run worker`; worker từ chối khởi động nếu thiếu 30 chủ đề (`topics_not_seeded`, chạy `docs/seed-topics.sql`) |
| `skipped / budget` | `recentFailures`; log `upstream_budget_exceeded` | Anthropic báo hết hạn mức chi tiêu. Nâng hạn mức ở Anthropic; job bị bỏ qua **không tự thử lại**: gửi lại bằng `enrich:redrive` (mục 4) |
| `failed / config_error` | log `enrich` | Sai khóa Anthropic (401/403) hoặc cấu hình. Sửa rồi redrive |
| `failed / upstream_error` kèm `dead_letter` | `queue.deadLetter` | Hết lần thử (mặc định 4 lần chạy). Xem mục 4 |
| Hàng `queued`/`running` quá 30 phút mà không có job | `enrich:status` | Tiến trình chết giữa chừng. Bộ dọn chạy **mỗi 10 phút** trên worker đặt chúng thành `failed / stale` (mục 5) |
| `pg_pool_error` / `pg_client_error` | `code`, `error` | DB (Neon) cắt kết nối. **Không làm sập tiến trình**; câu truy vấn đang chạy lỗi một lần rồi kết nối mới được mở. Nếu dồn dập: kiểm tra Neon (đang ngủ/khởi động lại, hết kết nối) |

## 4. Hàng chết (DLQ) và gửi lại (`enrich:redrive`)

Job hết số lần thử (`ENRICHMENT_JOB_RETRY_LIMIT` + 1 lần chạy) được pg-boss chép sang `dictionary.enrich_word.dlq`. Worker của hàng chết (mỗi 30 s) đặt hàng sổ còn hoạt động thành `failed / dead_letter` rồi **hoàn tất** job đó, nên `boss.redrive()` của pg-boss (chỉ chuyển job còn chờ) không còn gì để chuyển. Lệnh dưới đây đọc dữ liệu job còn lưu (mặc định 7 ngày) và **gửi lại từ đó qua đúng enqueuer của đường tra** (giữ các chốt: đã có mục từ, đã có hàng hoạt động, trần ngày, `singletonKey`). Hàng `failed` cũ giữ làm lịch sử; hàng mới được tạo.

```bash
npm run enrich:redrive                                    # CHẠY THỬ (mặc định): liệt kê, không gửi gì
npm run enrich:redrive -- --word ubiquitous,serendipity   # chỉ các từ này
npm run enrich:redrive -- --id <id job trong DLQ>[,<id>]  # chỉ các job này
npm run enrich:redrive -- --reason upstream_error         # chỉ job có hàng sổ mang mã này
npm run enrich:redrive -- --limit 50                      # nhìn tối đa N job chết, mới nhất trước (mặc định 20, tối đa 500)
npm run enrich:redrive -- --confirm --word ubiquitous     # gửi thật (cần ENRICHMENT_ENABLED=true)
```

* **Chạy thử là mặc định**; `--confirm` mới gửi. `--dry-run` cùng `--confirm` bị từ chối.
* **Chỉ gửi những gì đã chọn** (`--word`, `--id`, `--reason`, `--limit`). Không có bộ lọc nào thì xét 20 job chết mới nhất; mỗi từ chỉ xét job chết **mới nhất** của nó.
* Bảng kết quả cho từng job: `SEND AGAIN` hoặc `skip: <lý do>`:

| Lý do bỏ qua | Ý nghĩa |
|---|---|
| `entry_exists` | từ đã có mục từ (làm tay hoặc job khác): không cần |
| `active_row` | đang có hàng `queued`/`running` cho từ đó |
| `ledger_not_failed` | hàng sổ của job không còn `failed` (đã `succeeded`, v.v.) |
| `newer_dead_letter` | có job chết mới hơn của cùng từ, nó quyết định |
| `reason_filter` | không khớp `--reason` |
| `bad_payload` | dữ liệu job không có từ |

* Gửi chạm trần ngày (`ENRICHMENT_MAX_JOBS_PER_DAY`) thì dừng và nói rõ. Chạy lại vào ngày UTC sau.
* Cần một worker đang chạy ở đâu đó để xử lý job mới.
* Quy trình đề nghị: (1) tìm nguyên nhân gốc (mục 3) và sửa; (2) chạy thử; (3) đọc bảng; (4) `--confirm` với bộ lọc hẹp; (5) `npm run enrich:status -- --word <w>` xem kết quả.

Truy vấn xem trực tiếp: `docs/lookup-queue.md` mục 10 (`pgboss.job` theo `name = 'dictionary.enrich_word.dlq'`).

## 5. Dọn hàng treo (`reconcileStaleJobs`, mỗi 10 phút)

Worker (vai trò `worker` của pg-boss, `schedule: true`) đăng ký lịch cron `*/10 * * * *` vào hàng `dictionary.enrich_word.reconcile`; mỗi lần tới giờ có một job chạy `reconcileStaleJobs`: hàng `queued`/`running` quá 30 phút mà pg-boss không còn job sống nào được đặt `failed / stale`. **Mỗi lúc chỉ một nơi chạy**, nhờ ba lớp độc lập:

1. pg-boss giành quyền đánh giá cron trong DB (`trySetCronTime`), nhiều tiến trình cũng chỉ tạo một job mỗi lần;
2. hàng có chính sách `exclusive`: lần tới giờ sau không tạo job nếu lần trước chưa xong;
3. mỗi lần chạy lấy khóa tư vấn `pg_try_advisory_xact_lock(hashtextextended('enrich:reconcile', 0))` trong giao dịch; không lấy được thì bỏ qua (log `enrich_reconcile_skipped`).

Chỉ một worker dùng **đúng schema pg-boss mà job được gửi vào** (`PGBOSS_SCHEMA`) mới được dọn; chạy nhầm schema sẽ coi mọi hàng là mồ côi. Thử bằng tay: `docs/lookup-queue.md` mục 7.

## 6. Dừng và triển khai

* `SIGTERM` / `SIGINT` (Railway gửi khi triển khai lại): ngừng nhận kết nối mới, ngừng lấy job, chờ job đang chạy tối đa 30 s, đặt hàng còn chạy về `queued`, đóng pool. Job không mất; lần chạy bị ngắt vẫn tính vào số lần thử.
* Tiến trình bị giết đột ngột (OOM, mất điện): hàng còn `running`, job pg-boss còn `active` đến hết `expireInSeconds` (tối thiểu 300 s); pg-boss của worker khác phát hiện, đưa về `retry` và xử lý lại. Nếu job pg-boss biến mất hẳn, bộ dọn mục 5 đóng hàng sổ. Kiểm chứng: `npm run test:chaos` (`tests/chaos/process.chaos.test.ts`).
* Không chạy hai bản ứng dụng với `ENRICHMENT_WORKER_ENABLED=true` và schema pg-boss khác nhau cho cùng một DB (job nằm ở schema này sẽ bị bộ dọn của schema kia coi là mồ côi).

## 7. Khóa API

* Khóa chỉ nằm trong biến môi trường; **Google nhận khóa qua header `X-Goog-Api-Key`, không bao giờ trong URL**. Lỗi của nhà cung cấp, log và phản hồi được che khóa (`utils/redact.ts`; test `tests/security/keySecrecy.test.ts`).
* Thấy khóa trong log: xoay khóa ngay ở nhà cung cấp, cập nhật biến môi trường, triển khai lại; rồi báo để thêm mẫu che còn thiếu vào `utils/redact.ts`.
* In khóa cho người đọc: chỉ bốn ký tự cuối (`maskKey`).
* Ngoài phạm vi tra từ vẫn còn hai chỗ đặt khóa Google trong URL (`services/translationService.ts`, `services/ttsService.ts`): xem `docs/lookup-audit.md` mục 5.

## 8. Công cụ dev và test

| Lệnh | Việc |
|---|---|
| `npm test` | toàn bộ test thường (không gồm chaos) |
| `npm run test:chaos` | kịch bản chịu lỗi (breaker mở/đóng, 429, hết ngân sách, Datamuse sập, DB rớt kết nối, dừng/giết tiến trình, cron thật); hơn hai phút, dùng Postgres thật và pg-boss trong schema riêng, máy chủ giả, SDK Anthropic giả |
| `npm run mock:upstream -- --port 4010` | máy chủ giả Google / Free Dictionary / Datamuse (`docs/lookup-loadtest.md` mục 1.1) |
| `npm run loadtest:lookup` | tải: single-flight, F6, p50 / p95, heap (`docs/lookup-loadtest.md`) |
| `npx tsx scripts/loadtest/explain-lookup.ts --scale 200000` | EXPLAIN các truy vấn trên đường tra |
| `npm run health:snapshot` | ảnh chụp sức khỏe |
| `npm run enrich:status / enqueue / redrive / run / review` | xem hàng sổ / gửi một từ / gửi lại hàng chết / chạy đường ống / duyệt mục từ tự tạo |

Các test và công cụ trên **không gọi dịch vụ thật** (máy chủ giả trên 127.0.0.1; khóa giả; trong test, `fetch` toàn cục từ chối mọi máy chủ không phải loopback) nhưng dùng **DB dev trong `.env`**. Dữ liệu thử đặt tên `qzq<mã>…` / `e2e-<mã>-…` / `lt-<mã>-…` và được xóa khi xong; bộ đếm ký tự Google thật được khôi phục. Một lần chạy hỏng giữa chừng có thể để lại dòng `qzq%`, người dùng `e2e-%` / `lt-%` hoặc schema `pgboss_test_*`: xóa tay.

## 9. Giới hạn đã biết

* Bộ giới hạn F6, bucket Free Dictionary, single-flight, mạch ngắt và bộ đếm tra từ nằm **trong bộ nhớ từng tiến trình**: nhiều bản sao ứng dụng thì giới hạn nhân lên, mạch ngắt không đồng bộ.
* Không có giới hạn đồng thời ở đường tra: dưới tải quá mức, DB chậm làm cả hàng đợi chờ rồi đồng loạt 503 (`docs/lookup-loadtest.md` mục 2.1).
* `Retry-After` của nhà cung cấp chỉ được chờ tối đa 60 s trong worker; lâu hơn thì phần còn lại do backoff của pg-boss (30 s, gấp đôi) đảm nhận.
* Số đếm trong `queue` của ảnh chụp sức khỏe là đếm trực tiếp trong bảng `pgboss.job`, gồm cả job đã hoàn tất còn lưu (`byState`).
