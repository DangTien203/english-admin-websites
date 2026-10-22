# WordyGo · Sổ tay vận hành tra từ và làm giàu từ điển (P7, P7b)

Cập nhật 15/10/2026 · Dành cho người trực: khi tra từ chậm, báo 503, hàng đợi đứng, hết ngân sách. Thiết kế: `docs/lookup-spec.md` · Hàng đợi: `docs/lookup-queue.md` · Kiểm toán và rủi ro: `docs/lookup-audit.md` · Đo tải: `docs/lookup-loadtest.md`.

## 1. Công tắc khẩn (spec §11.8)

Cấu hình được đọc và **đóng băng một lần khi khởi động** (`config/lookup.ts`): đổi biến môi trường xong phải **khởi động lại** tiến trình (Railway: đổi biến rồi redeploy).

| Muốn | Đặt | Hậu quả | Khởi động lại? |
|---|---|---|---|
| Tắt đường tra qua dịch vụ ngoài (Google, Free Dictionary, Haiku) | `TRANSLATION_FALLBACK_ENABLED=false` | Từ không có trong từ điển: `404 ENTRY_NOT_FOUND`, **0 request ra ngoài**. Từ có trong từ điển vẫn trả bình thường. Không còn bản tạm, nên cũng không còn job mới (job được gửi từ đường tra) | **Có**, dịch vụ API |
| Ngừng gửi job làm giàu mới | `ENRICHMENT_ENABLED=false` | Phản hồi tra từ có `enrichment.status = "disabled"`. Job đang chờ vẫn nằm trong hàng đợi và vẫn được worker xử lý (cờ này chỉ chặn việc **gửi**). `enrich:enqueue` và `enrich:redrive --confirm` cũng từ chối | **Có**, dịch vụ API |
| Ngừng xử lý job | `ENRICHMENT_WORKER_ENABLED=false` (ở **mọi** dịch vụ chạy worker) | Worker không đăng ký; job nằm yên trong hàng đợi, không mất; việc gửi job vẫn tiếp tục nếu `ENRICHMENT_ENABLED=true`. Dịch vụ API không tự chạy worker nữa. Dùng khi nạp lại Wiktionary (mục 11.1) | **Có**, từng dịch vụ có worker |
| Chặn việc tự công khai mục từ mới | `ENRICHMENT_PUBLISH_POLICY=review` | Mục từ do job tạo luôn `published = false`, chờ duyệt (`npm run enrich:review`). **`review` cũng là mặc định khi không đặt biến (hoặc để trống) từ spec 1.5**; các bản trước mặc định `auto`. `auto` công khai ngay mục từ đủ tầng A và chỉ có hiệu lực khi được đặt RÕ trong môi trường của worker. **Bản mã cũ (ví dụ một triển khai từ xa chưa được triển khai lại) vẫn mặc định `auto`**: muốn chắc chắn, đặt `ENRICHMENT_PUBLISH_POLICY=review` tường minh ở mọi nơi có worker, đừng chỉ dựa vào mặc định. Giá trị có hiệu lực là của **tiến trình worker thực hiện job**, không phải của dịch vụ gửi job | **Có**, worker |
| Tắt Google nhưng giữ Free Dictionary | để trống `GOOGLE_TRANSLATE_API_KEY` | Google coi như tắt: bản tạm thiếu nghĩa tiếng Việt (`partial`, `missing: ["translation_vi"]`). Cảnh báo một lần khi khởi động | **Có**, dịch vụ API |
| Ngừng chi tiêu Anthropic ngay | xóa hoặc thu hồi `ANTHROPIC_API_KEY` ở bảng điều khiển Anthropic | Job dừng với `failed / config_error` (không thử lại). Khi nhà cung cấp tự chặn vì hết hạn mức: `skipped / budget`. Thu hồi ở nhà cung cấp có hiệu lực **ngay**, không cần khởi động lại; xóa biến thì cần | Thu hồi: **không**. Xóa biến: **có**, worker |

Mọi biến trên đều đóng băng lúc khởi động, nên cột cuối luôn là "có" cho thay đổi bằng biến môi trường; chỉ việc thu hồi khóa ở phía nhà cung cấp là tức thì. **Nhiều tiến trình dùng chung một DB thì mỗi tiến trình có cấu hình riêng**: kiểm danh sách worker đang nối vào (`pgboss.instance`, mục 10.4) trước khi tin rằng một công tắc đã có tác dụng.

## 2. Quan sát

### 2.1 Ảnh chụp sức khỏe

```bash
npm run health:snapshot        # JSON, chỉ đọc
```

Trả về (`services/lookup/health.ts`, `LookupHealthService.getSnapshot()`; từ P8 cũng có ở `GET /lookup/api/health` và trang `/lookup/health`, xem `docs/lookup-admin.md`):

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
| `lookup` | info | mỗi lần tra | `word`, `outcome` (`hit`, `temporary`, `not_found`, `unavailable`, `rate_limited`), `source`, `partial`, `latency_ms`, `local_ms`, `google_ms`, `fd_ms`, `step2_ms`, `google` / `fd` (`ok`, `error:timeout`, `error:http_5xx`, `error:breaker_open`, `error:local_rate_limit`, `error:budget_monthly_chars`, …), `shared` (nhập chung một chuyến bay), `enrichment_status` (quyết định đã đưa vào response: `disabled`, `skipped`, `queued`; `deferred` sau một 503; từ spec 1.5). `latency_ms` là thời gian tới khi trả lời |
| `lookup_enrich` | info | lần gửi job NỀN của một lần tra xong (từ spec 1.5; response chỉ nói `queued`, đây mới là kết quả thật) | `word`, `status` (`queued`, `already_queued`, `skipped`), `reason` (ví dụ `daily_cap`, `unknown_word` sau một 503), `delayed_s` (60 sau sự cố), `enqueue_ms` |
| `lookup_background_error` | **error** | một việc chạy nền sau response ném lỗi: gửi job (`task: enrich`) hoặc ghi `word_lookups` (`task: word_lookups`). Response KHÔNG bị đổi; lần tra sau của từ đó tự thử gửi lại job | `task`, `word`, `error` (đã che khóa, tối đa 200 ký tự) |
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
| Từ mới được tra mà không thấy job trong `/lookup/jobs` | log `lookup_enrich` của từ đó và `lookup_background_error` | Từ spec 1.5 việc gửi job chạy sau response, nên response luôn nói `queued` kể cả khi không có job. `lookup_enrich` cho biết thật: `already_queued` (đã có job), `skipped / daily_cap` (hết trần ngày), hoặc không có dòng nào + `lookup_background_error` (`task: enrich`, pg-boss / DB lỗi). Lần tra kế tiếp của từ đó tự gửi lại |
| Job không chạy | `queue.main.waiting` tăng, `active` 0 | Không có worker: kiểm tra `ENRICHMENT_WORKER_ENABLED`, tiến trình `npm run worker`; worker từ chối khởi động nếu thiếu 30 chủ đề (`topics_not_seeded`, chạy `docs/seed-topics.sql`) |
| `skipped / budget` | `recentFailures`; log `upstream_budget_exceeded` | Anthropic báo hết hạn mức chi tiêu. Nâng hạn mức ở Anthropic; job bị bỏ qua **không tự thử lại** và **không nằm trong hàng chết**, nên `enrich:redrive` không thấy nó: gửi lại từng từ bằng `enrich:enqueue` (mục 10.3) |
| `failed / config_error` | log `enrich` | Sai khóa Anthropic (401/403) hoặc cấu hình. Sửa rồi gửi lại bằng `enrich:enqueue` (job này cũng không vào hàng chết) |
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
| `npm run enrich:draft -- --word <từ>` | chạy S1 đến S4, in bản nháp, **không ghi DB** (xem nguồn nào nhận ra từ) |
| `npm run refdata:wiktionary / refdata:verify` | nạp lại và kiểm dữ liệu tham chiếu (mục 11.1) |
| `npm run check:env-example` | kiểm `.env.example` khớp schema `config/lookup.ts` (cũng chạy đầu `npm test`, nên `npm test` đỏ ngay nếu thêm biến mà quên ghi vào ví dụ) |
| `npm run seed:lookup-test -- --staging` | dữ liệu thử cho nghiệm thu (mục 12) |
| `npm run acceptance:lookup -- --staging` | nghiệm thu 30 từ, ghi `docs/lookup-acceptance-report.md` (mục 12) |
| `npx tsx scripts/dev/cleanup-auto-entries.ts` | **chạy thử**: liệt kê các mục từ `[auto]` (đúng tiêu chí màn `/lookup/review`), số hàng sẽ xóa ở từng bảng liên quan, số mục đang published, mục bị bỏ qua vì còn bài học / từ đồng nghĩa của mục khác / từ đã lưu… trỏ tới. Chỉ thêm `--confirm` mới xóa (một giao dịch, in số hàng đã xóa); không bao giờ đụng mục không phải `[auto]`. Chi tiết: `docs/lookup-admin-notes.md` mục 12 |
| `npm run enrich:seed-oxford -- --file <tệp> [--sample N] [--limit N] [--confirm]` | nạp từ Oxford 5000 chưa có qua đường ống làm giàu; chạy thử là mặc định (mục 13.3) |
| `npm run enrich:publish -- [--cefr A1,A2] [--limit 500] [--confirm]` | xuất bản mục từ `[auto]` đủ điều kiện bằng dòng lệnh; chạy thử là mặc định (mục 13.7) |
| `npm run oxford:apply-cefr -- --file <tệp> [--dry-run]` | đặt `cefr_level` của mục từ `[auto]` theo mức thấp nhất của Oxford (mục 13.6); **áp dụng ngay nếu không có `--dry-run`** |
| `npm run admin:create -- --email <e> --name <n>` | thêm MỘT `super_admin` với mật khẩu ngẫu nhiên in ra một lần (hoặc `ADMIN_PASSWORD`); không xóa gì, từ chối e-mail đã có |

Các test và công cụ trên **không gọi dịch vụ thật** (máy chủ giả trên 127.0.0.1; khóa giả; trong test, `fetch` toàn cục từ chối mọi máy chủ không phải loopback) nhưng dùng **DB dev trong `.env`**. Dữ liệu thử đặt tên `qzq<mã>…` / `e2e-<mã>-…` / `lt-<mã>-…` và được xóa khi xong; bộ đếm ký tự Google thật được khôi phục. Một lần chạy hỏng giữa chừng có thể để lại dòng `qzq%`, người dùng `e2e-%` / `lt-%` hoặc schema `pgboss_test_*`: xóa tay.

## 9. Giới hạn đã biết

* Bộ giới hạn F6, bucket Free Dictionary, single-flight, mạch ngắt và bộ đếm tra từ nằm **trong bộ nhớ từng tiến trình**: nhiều bản sao ứng dụng thì giới hạn nhân lên, mạch ngắt không đồng bộ.
* Không có giới hạn đồng thời ở đường tra: dưới tải quá mức, DB chậm làm cả hàng đợi chờ rồi đồng loạt 503 (`docs/lookup-loadtest.md` mục 2.1).
* `Retry-After` của nhà cung cấp chỉ được chờ tối đa 60 s trong worker; lâu hơn thì phần còn lại do backoff của pg-boss (30 s, gấp đôi) đảm nhận.
* Số đếm trong `queue` của ảnh chụp sức khỏe là đếm trực tiếp trong bảng `pgboss.job`, gồm cả job đã hoàn tất còn lưu (`byState`).


---

## 10. Triệu chứng, nguyên nhân, cách xử lý (P7b)

Cách xem nhanh trước khi làm bất cứ việc gì: `npm run health:snapshot` (mạch ngắt, ký tự Google, token, job, độ sâu hàng đợi, 20 lỗi job gần nhất), rồi log JSON (mục 2.2). Mọi thay đổi biến môi trường cần **khởi động lại** (mục 1).

### 10.1 Google 403 hoặc hết hạn mức

| | |
|---|---|
| **Dấu hiệu** | Log `upstream_config_error` với `provider: "google_translate"` và `http_status` 403 (khóa sai trả **400**, đã kiểm chứng ở `docs/lookup-api-notes.md` mục 2). `health:snapshot`: mạch `google_translate` **open** ngay từ lỗi đầu tiên (lỗi cấu hình mở mạch tức thì). Người dùng: bản tạm `partial` với `missing: ["translation_vi"]`; nếu Free Dictionary cũng không biết từ thì 503. Không có dòng nào để lại trong từ điển (bản tạm không bao giờ được ghi) |
| **Nguyên nhân thường gặp** | Khóa sai, bị thu hồi hoặc hết hạn; Cloud Translation API chưa bật cho dự án; dự án chưa bật thanh toán; khóa bị giới hạn theo API hoặc theo IP / referrer không khớp máy chủ. Hết quota của Google: thân và mã `reason` thật **chưa kiểm chứng** (không có bằng chứng thật), nên chưa biết nó trông thế nào ở log; cứ thấy 403 thì xử lý như trên |
| **Xử lý** | (1) Mở Google Cloud Console → *APIs & Services*: Cloud Translation API phải *Enabled*; *Credentials*: kiểm tra khóa và các giới hạn của nó; *Billing*: dự án phải gắn tài khoản thanh toán. (2) Nếu đã xoay khóa: mục 11.3. (3) Sau khi sửa phía Google, mạch chỉ tự đóng sau `UPSTREAM_BREAKER_RESET_MS` (mặc định 30 s) và một request thử thành công; muốn đóng ngay thì khởi động lại tiến trình. (4) Kiểm: tra một từ chưa có trong từ điển, phản hồi phải có `translation_vi` |
| **Hết trần nội bộ** (khác với trên) | `GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT`: log `google: error:budget_monthly_chars`, `health:snapshot` `google.remaining = 0`. Google **không được gọi**, mạch **không** mở. Nâng trần (cần khởi động lại) hoặc đợi sang tháng UTC mới. Xem số đã dùng: SQL ở 11.4 |
| **Tắt Google chủ động** | để trống `GOOGLE_TRANSLATE_API_KEY` (mục 1) |

### 10.2 Free Dictionary: 429, treo, trang HTML 404

| | |
|---|---|
| **Dấu hiệu** | Trong log `lookup`, trường `fd`: `error:rate_limited` (429 từ nhà cung cấp), `error:local_rate_limit` (hết bucket nội bộ `FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN`), `error:timeout`, `error:bad_response` (trang HTML 404), `error:breaker_open`. Người dùng thấy bản tạm `partial` với `missing` có `pos, definition_en, ipa, audio_url`; nhóm từ nhiều nghĩa mất `senses` và nghĩa thứ hai, thứ ba |
| **Quan sát thật** | Dịch vụ rất kém ổn định. Từ lúc làm P2 (`docs/lookup-api-notes.md` mục 1.3): từ có thật như `run`, `ran` nhận **404 là trang HTML** (Cloudflare cache một trang 404 sai, `Age` khoảng 10 ngày) và từ rác nhận 522; coi 404 thân HTML là `bad_response`, không phải "từ không có". Trong nghiệm thu 15/10/2026: 8 trong 9 từ thử trực tiếp treo quá 8 s, `london` trả trang HTML 404. Trong lần nghiệm thu, 11 trên 16 lần tra từ chưa có trong từ điển bị `error:timeout` (2,5 đến 2,9 s). **Năm lần lỗi liên tiếp mở mạch `free_dictionary` trong 30 s**, và trong 30 s đó mọi từ mới đều thành `partial` mà không hỏi Free Dictionary nữa (log `fd: error:breaker_open`). Từ rác (`asdfghjk`) cũng treo, nên theo ma trận §6 (không G, FDerr) trả **503**, không phải 404 |
| **Nguyên nhân** | Phía dịch vụ ngoài. Header giới hạn tốc độ của nó không đáng tin (`docs/lookup-api-notes.md` mục 1.4). 429 thật **chưa từng gặp** nên thân và `Retry-After` thật chưa kiểm chứng |
| **Xử lý** | Không có gì phải sửa nếu chỉ vài từ: bản tạm vẫn có nghĩa tiếng Việt từ Google và job nền vẫn chạy (job dùng Wiktionary cục bộ trước, chỉ hỏi Free Dictionary khi Wiktionary không có dòng nào; lỗi tạm của nó làm job thử lại). Nếu kéo dài nhiều giờ: (a) đừng chỉnh `UPSTREAM_BREAKER_*` để "cho nó chịu lỗi", vì mạch mở là hành vi đúng; (b) báo cáo cho nhà cung cấp; (c) cân nhắc chấp nhận bản tạm thiếu `senses` trong lúc chờ. `local_rate_limit`: nâng `FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN` (mỗi tiến trình có một bucket riêng) |

### 10.3 Anthropic hết ngân sách

| | |
|---|---|
| **Dấu hiệu** | Log `upstream_budget_exceeded` với `provider: "anthropic"` và `reason: "spend_limit"` (mức error); hàng job `skipped / budget`; mạch `anthropic` **open** ngay. Các job sau trong lúc mạch mở nhận `breaker_open` và được thử lại theo backoff (30 s, 60 s, 120 s...), cuối cùng `failed / upstream_error` nếu nhà cung cấp vẫn chưa mở lại |
| **Nguyên nhân** | Anthropic từ chối vì hết hạn mức chi tiêu: `enforced_spend_limit_reached` (429) hoặc HTTP 400 "You have reached your specified API usage limits" |
| **Xử lý** | (1) Nâng giới hạn hoặc nạp tiền ở console Anthropic. (2) Đợi mạch tự thử lại (≤ `UPSTREAM_BREAKER_RESET_MS`) hoặc khởi động lại worker. (3) **Gửi lại các từ bị `skipped / budget`** (job đó đã hoàn tất, không nằm trong hàng chết, nên `enrich:redrive` **không** thấy nó): lấy danh sách rồi gửi từng từ bằng `enrich:enqueue`: |

```sql
SELECT DISTINCT word FROM word_enrichment_jobs w
 WHERE status = 'skipped' AND reason = 'budget'
   AND NOT EXISTS (SELECT 1 FROM dictionary_entries e WHERE lower(e.headword) = w.word OR lower(e.lemma) = w.word)
 ORDER BY word;
```
```bash
npm run enrich:enqueue -- --word <từ>      # lặp cho từng từ; bỏ qua từ đã có mục từ, đã có job, hoặc chạm trần ngày
```
Chi phí để biết trước khi gửi lại hàng loạt: khoảng $0,0007 đến $0,0015 mỗi từ (mục 11.4 và `docs/lookup-enrichment.md` mục 17).

### 10.4 Hàng đợi ứ

| | |
|---|---|
| **Dấu hiệu** | `health:snapshot` → `queue.main.waiting` tăng mà `active` bằng 0 hoặc đứng yên; `enrich:status` có nhiều hàng `queued` cũ |
| **Kiểm theo thứ tự** | (1) **Có worker nào đang chạy không, và của ai?** `SELECT name, host, pid, started_on, heartbeat_on, stopped_on FROM pgboss.instance ORDER BY started_on DESC LIMIT 8;` (`stopped_on` có giá trị = đã dừng gọn; `heartbeat_on` cũ hơn vài phút mà `stopped_on` trống = tiến trình bị giết). **Mọi worker nối vào cùng DB đều nhận job**, kể cả bản triển khai trên máy chủ khác: cấu hình (nhất là `ENRICHMENT_PUBLISH_POLICY`) và phiên bản mã của worker nào nhận job quyết định kết quả, không phải của máy bạn đang gõ lệnh. Cột `host` cho biết máy. Kiểm tra `ENRICHMENT_WORKER_ENABLED` (mục 1) và log khởi động của worker (`topics_not_seeded` làm worker thoát mã 1: chạy `docs/seed-topics.sql`). (2) **Mạch `anthropic` có mở không?** (mục 10.3); job `breaker_open` quay lại hàng chờ với backoff. (3) **Có job `startAfter` chưa tới giờ không?** Job gửi sau lỗi 503 được hoãn 60 s: `SELECT min(start_after) AS som_nhat, count(*) FROM pgboss.job WHERE name = 'dictionary.enrich_word' AND state IN ('created','retry') AND start_after <= now();` cho số job đã đến giờ nhưng chưa ai nhận. (4) **Trần ngày** `ENRICHMENT_MAX_JOBS_PER_DAY`: SQL ở 11.4, mục `jobs/ngày`; chạm trần thì job mới không được tạo (`daily_cap`), không ứ |
| **Xử lý** | Worker chết: khởi động lại; job `active` mồ côi tự được pg-boss thử lại sau `expireInSeconds` (tối thiểu 300 s). Hàng sổ `queued`/`running` quá 30 phút mà pg-boss không còn job sống: bộ dọn 10 phút đặt `failed / stale` (mục 5). Ứ vì chậm: tăng `ENRICHMENT_WORKER_CONCURRENCY` (mặc định 2; mỗi job ~10 s, hai job song song ≈ 12 job/phút) hoặc chạy thêm tiến trình worker (an toàn, pg-boss dùng `SKIP LOCKED`). Tăng đồng thời cũng tăng chi tiêu Anthropic theo cùng tỉ lệ |

### 10.5 Job vào hàng lỗi chết (DLQ)

| | |
|---|---|
| **Cách xem** | trang `/lookup/health` (20 lỗi gần nhất, hàng lỗi chết) và `/lookup/jobs` (lọc theo trạng thái, lý do; nút **Thử lại** cho `upstream_error`, `budget`, `dead_letter`, `stale`, `queue_error`, `daily_cap`: `docs/lookup-admin.md` mục 2.3); hoặc `npm run health:snapshot` → `queue.deadLetter` và `recentFailures`; hoặc SQL: |

```sql
-- job trong hàng chết (mới nhất trước)
SELECT id, data->>'word' AS tu, source_retry_count, source_output, created_on
  FROM pgboss.job WHERE name = 'dictionary.enrich_word.dlq' ORDER BY created_on DESC LIMIT 20;
-- hàng sổ tương ứng
SELECT word, status, reason, attempts, finished_at FROM word_enrichment_jobs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT 20;
```
Worker của hàng chết ghi log `enrich_dead_letter` và đặt hàng sổ còn hoạt động thành `failed / dead_letter`. Lý do thường gặp: `upstream_error` sau 4 lần chạy (Free Dictionary treo với từ lạ, Anthropic 5xx/529 kéo dài, DB bị ngắt).

| | |
|---|---|
| **Chạy lại** | (1) **Tìm nguyên nhân gốc và sửa trước** (mục 3 và 10.1 đến 10.3), nếu không job sẽ chết lại. (2) Một từ: `npm run enrich:enqueue -- --word <từ>` (cần `ENRICHMENT_ENABLED=true`; qua đúng enqueuer của đường tra, nên từ đã có mục từ, đã có job hoạt động hoặc chạm trần ngày thì được bỏ qua và nói rõ). (3) Nhiều từ: `npm run enrich:redrive` (chạy thử là mặc định, `--confirm` mới gửi; mục 4). (4) Xem kết quả: `npm run enrich:status -- --word <từ>` |
| **Lưu ý** | Hàng `failed` cũ giữ làm lịch sử; gửi lại tạo hàng mới. Chỉ `enrich:redrive` đọc hàng chết; **job `skipped / budget` và `failed / config_error` không nằm ở đó** (worker đã hoàn tất chúng): dùng `enrich:enqueue` (mục 10.3) |

### 10.6 Mục từ tự tạo bị sai

Mục từ do job tạo có `admin_note` bắt đầu bằng `[auto]` (nguồn, model, id job, tầng B còn thiếu, ghi chú của Haiku). Duyệt: `npm run enrich:review -- --unpublished` hoặc `-- --word <từ>`.

| Việc | Cách làm |
|---|---|
| **Ẩn** (nhanh nhất, đảo ngược được) | Đặt `published = false` **và ghi `entry_edit_history`** để biết ai ẩn và vì sao. Trang `/lookup/review` (P8) làm việc này bằng nút **Ẩn** và ghi lịch sử giúp bạn (`docs/lookup-admin.md` mục 3.3); SQL dưới đây là cách làm tay tương đương (một giao dịch): |

```sql
BEGIN;
UPDATE dictionary_entries SET published = FALSE
 WHERE id = '<id mục từ>' AND published = TRUE;
INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value)
VALUES ('<id mục từ>', NULL, 'published', 'true', 'false');
COMMIT;
```
Sau khi ẩn, đường tra không còn trả mục từ đó: nó quay về bản tạm, và job gửi cho từ đó dừng ở S0 (`skipped / exists`, vì mục từ vẫn tồn tại). Bật lại bằng SQL tương tự (đảo `true` / `false`).

| Việc | Cách làm |
|---|---|
| **Xóa hẳn để làm lại** | Chỉ mục từ do job tạo: `DELETE FROM dictionary_entries WHERE id = '<id>' AND admin_note LIKE '[auto]%';` (mọi bảng con xóa theo; `word_enrichment_jobs.entry_id` thành NULL). Rồi `npm run enrich:enqueue -- --word <từ>` hoặc `npm run enrich:run -- --word <từ>`. Chi tiết: `docs/lookup-enrichment.md` mục 15 |
| **Sửa một trường** | `UPDATE` trực tiếp rồi ghi `entry_edit_history` với `field_name` là tên cột, `old_value`, `new_value`. Không sửa `admin_note` (nó là dấu vết của job) |

## 11. Quy trình

### 11.1 Nạp lại Wiktionary (`ref_wiktionary_en`)

Khi nào: dump mới, đổi `--top-n`, hoặc dữ liệu hỏng. **Tại sao phải dừng worker:** `--reset` làm `TRUNCATE ref_wiktionary_en` rồi nạp dần trong 15 đến 30 phút. Trong lúc đó bảng chỉ có một phần dữ liệu: một job đọc nó sẽ thấy "không có dòng Wiktionary" cho từ thật (bỏ qua bước dạng biến, quyết định `variant_form` / dạng biến sai, hoặc đi hỏi Free Dictionary vô ích), và đường tra mất bước F4b cho các dạng biến chưa nạp tới.

1. **Dừng worker.** Đặt `ENRICHMENT_WORKER_ENABLED=false` ở **mọi** dịch vụ đang chạy worker (dịch vụ worker riêng, và dịch vụ API nếu nó tự chạy worker), khởi động lại. Job mới vẫn được gửi và nằm trong hàng đợi (nếu muốn ngừng cả việc gửi: `ENRICHMENT_ENABLED=false`).
2. **Đợi job đang chạy xong:** `npm run enrich:status` → `running = 0`.
3. **Chạy ngoài giờ cao điểm**, từ máy có `.env` trỏ đúng DB (các lệnh `refdata:*` **từ chối chạy khi `NODE_ENV=production`**; dòng `target:` in `host/tên database` để kiểm):
   ```bash
   # chỉ khi muốn nạp lại tần suất (thường không cần): npm run refdata:wordfreq:export && npm run refdata:wordfreq
   npm run refdata:wiktionary -- --top-n 150000 --reset      # ~15 đến 30 phút; Ctrl-C dừng gọn, rồi chạy lại với --reset
   npm run refdata:verify                                    # phải 11/11 PASS (WARN chỉ cảnh báo)
   ```
   Nạp bản thử trước nếu đổi tham số: `-- --dry-run`. Chi tiết: `docs/lookup-refdata.md` mục 3.
4. **Bật lại worker:** `ENRICHMENT_WORKER_ENABLED=true`, khởi động lại.
5. **Kiểm:** `npm run enrich:status` (hàng `queued` bắt đầu chạy), `npm run enrich:draft -- --word ran` (S1 cho `ran` phải ra `onlyFormRows`, `expectedLemma run`), và một lần tra dạng biến (`ran`) trả `matched_form`.

### 11.2 Datamuse yêu cầu khóa từ 2027

Điều đọc được trên `https://www.datamuse.com/api/` (15/10/2026): phần đầu trang nói từ **1/2/2027** mọi request cần khóa, tối đa 100.000 request mỗi ngày mỗi khóa; mục *Usage limits* của chính trang đó lại nói đến **1/1/2027**; cách gửi khóa (header hay tham số, tên gì) **không được nêu**. Trang cũng dặn: ứng dụng công khai nên ghi nhận Datamuse trong tài liệu của ứng dụng (xem `docs/lookup-attribution.md`).

Hiện trạng trong mã:
* `DATAMUSE_API_KEY` được đọc, nhưng hàm `applyDatamuseAuth` (`services/upstream/datamuseClient.ts`) **cố ý rỗng**: chưa có tài liệu nên chưa đoán tên tham số. (Đọc lại trang chính thức ngày 16/10/2026: vẫn không nói cách gửi khóa, xem `docs/lookup-attribution.md` mục 4.) Có khóa trong biến môi trường **chưa** làm khóa được gửi đi.
* Từ 1/1/2027 mỗi lần khởi động có cảnh báo `DATAMUSE_API_KEY is empty and today is on/after 2027-01-01`.
* Datamuse chỉ cho **ứng viên** đồng / trái nghĩa. Datamuse lỗi hoặc từ chối thì `relations()` không ném lỗi: job vẫn `succeeded`, chỉ thiếu ứng viên (đã chứng minh bằng chaos test `upstream.chaos.test.ts`).

Việc cần làm trước 1/1/2027:
1. Xin khóa qua biểu mẫu liên hệ trên trang Datamuse (trang ghi người dùng hiện tại cần liên hệ; mô tả ứng dụng).
2. Khi Datamuse công bố cách gửi khóa: viết vào `applyDatamuseAuth` (nơi duy nhất), sửa `tests/lookup/datamuseClient.test.ts`, đặt `DATAMUSE_API_KEY`, triển khai lại.
3. Nếu chưa có khóa kịp: đặt `DATAMUSE_ENABLED=false` để ngừng gọi (không lỗi, không mở mạch); chất lượng đồng / trái nghĩa chỉ còn từ Wiktionary và Haiku.

### 11.3 Xoay khóa API

Khóa chỉ nằm trong biến môi trường, được đọc một lần khi khởi động: **đổi xong phải khởi động lại mọi dịch vụ dùng khóa đó** (API và worker; Railway: đổi biến rồi redeploy cả hai). Không dán khóa vào chat, log hay `admin_note`; khi cần in thì chỉ 4 ký tự cuối (`maskKey`).

| Khóa | Dùng ở đâu | Các bước |
|---|---|---|
| `GOOGLE_TRANSLATE_API_KEY` | đường tra nhanh (dịch từ, dịch định nghĩa) của dịch vụ API | (1) Tạo khóa mới ở Google Cloud Console → *Credentials*, giới hạn theo *Cloud Translation API*. (2) Đặt biến, redeploy. (3) Tra một từ chưa có trong từ điển: phải có `translation_vi`; `npm run health:snapshot` mạch `google_translate` `closed`. (4) **Sau cùng** mới thu hồi khóa cũ. Nếu mạch đã mở vì khóa cũ bị thu hồi trước: khởi động lại để đóng ngay |
| `ANTHROPIC_API_KEY` | worker (làm giàu) và API nếu `LOOKUP_FAST_TRANSLATOR=haiku` | (1) Tạo khóa mới ở console Anthropic. (2) Đặt biến ở dịch vụ worker (và API nếu dùng chế độ haiku), redeploy. (3) `npm run enrich:run -- --word <từ> --dry-run` (tốn vài phần trăm xu) hoặc đợi job kế tiếp: phải không có `config_error`. (4) Thu hồi khóa cũ. Thu hồi khóa cũ **trước** là cách ngừng chi tiêu ngay (mục 1) nhưng job đang chạy sẽ `failed / config_error` |
| `DATAMUSE_API_KEY` | worker (ứng viên đồng / trái nghĩa) | chưa dùng được (mục 11.2) |
| `JWT_SECRET`, `SESSION_SECRET` | ngoài tra từ | đổi `JWT_SECRET` làm mọi token đang cấp mất hiệu lực; không thuộc quy trình này |

Thấy khóa trong log: xoay ngay, rồi báo để thêm mẫu che vào `utils/redact.ts` (mục 7).

### 11.4 SQL theo dõi chi phí

Mọi kỳ trong `api_usage_counters` tính theo **UTC**. Chạy bằng `psql "$DATABASE_URL"`. Mọi câu dưới đây đã chạy thử trên DB dev (15/10/2026).

```sql
-- Token Anthropic của job làm giàu theo THÁNG (input gồm cả token ghi và đọc cache)
SELECT period AS thang, unit, used FROM api_usage_counters
 WHERE provider = 'anthropic' ORDER BY period DESC, unit;

-- Token Anthropic của đường tra nhanh (chế độ haiku) theo NGÀY
SELECT period AS ngay, unit, used FROM api_usage_counters
 WHERE provider = 'anthropic_fast' ORDER BY period DESC, unit LIMIT 14;

-- Ký tự Google theo THÁNG và phần trăm so với trần (đổi 450000 nếu đã đổi GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT)
SELECT period AS thang, used AS ky_tu, round(used * 100.0 / 450000, 1) AS phan_tram_tran
  FROM api_usage_counters WHERE provider = 'google_translate' AND unit = 'chars' ORDER BY period DESC;

-- Job đã gửi theo NGÀY so với trần ENRICHMENT_MAX_JOBS_PER_DAY
SELECT period AS ngay, used AS job_da_gui FROM api_usage_counters
 WHERE provider = 'enrichment' AND unit = 'jobs' ORDER BY period DESC LIMIT 14;

-- Kết quả job 7 ngày gần nhất
SELECT (created_at AT TIME ZONE 'UTC')::date AS ngay, status, coalesce(reason, '-') AS reason, count(*) AS so_job
  FROM word_enrichment_jobs WHERE created_at > now() - interval '7 days'
 GROUP BY 1, 2, 3 ORDER BY 1 DESC, 4 DESC;

-- Token và chi phí ƯỚC TÍNH theo ngày, từ hàng job (giả định 7.859 token system prompt được ĐỌC từ cache mỗi job;
-- giá $0,10 vào / $0,50 ra / $0,01 đọc cache mỗi triệu token, xem services/enrichment/pricing.ts và PHẢI xác minh lại)
SELECT (finished_at AT TIME ZONE 'UTC')::date AS ngay,
       count(*) FILTER (WHERE input_tokens > 0) AS job_goi_haiku,
       sum(input_tokens) AS vao, sum(output_tokens) AS ra,
       round(((sum(input_tokens) - 7859.0 * count(*) FILTER (WHERE input_tokens > 0)) * 0.10
              + sum(output_tokens) * 0.50
              + 7859.0 * count(*) FILTER (WHERE input_tokens > 0) * 0.01) / 1000000, 5) AS usd_uoc_tinh
  FROM word_enrichment_jobs WHERE finished_at IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 14;

-- Mục từ tự tạo: đã duyệt (published) và chưa
SELECT published, count(*) FROM dictionary_entries WHERE admin_note LIKE '[auto]%' GROUP BY 1;
```
Đối chiếu: tổng `sum(input_tokens)` theo ngày từ hàng job phải khớp mức tăng của `api_usage_counters` cùng kỳ (nghiệm thu 15/10: 140.284 vào, 16.672 ra, hai nguồn trùng nhau). Google chỉ có số ký tự; số tiền xem ở bảng thanh toán của Google Cloud.

## 12. Nghiệm thu 30 từ (`npm run acceptance:lookup`)

Một lệnh chạy 30 từ thử qua máy chủ thật, chờ các job nền, và in bảng **đạt / không đạt / bỏ qua** (báo cáo lưu ở `docs/lookup-acceptance-report.md`). Chỉ chạy trên staging, là **DB dev duy nhất trong `.env`** (chưa có người dùng thật). Các bước:

1. **Chuẩn bị dữ liệu** (một lần, chạy lại được): `npm run seed:lookup-test -- --staging`. Từ chối chạy nếu thiếu `--staging` hoặc `NODE_ENV=production`; in tên DB (host / database / user, không có mật khẩu) để bạn xác nhận. Việc nó làm: người dùng thử `lookup-acceptance@example.com` với mật khẩu ngẫu nhiên, một ebook có một chương và một đoạn văn; ghi `.acceptance.local.json` (**git-ignored**, giữ mật khẩu thử; chạy seed lần nữa thì đổi mật khẩu và ghi lại); tạo các mục từ gốc còn thiếu cho nhóm A và B (`run`, `go`, `child`, `light`, `bank`) bằng đúng đường ống `enrich:run`, rồi đặt `published = true` **chỉ cho những từ đó** và ghi `entry_edit_history`; mục từ có sẵn nhưng `published = false` mà không do job tạo thì **không đụng tới**. Cuối cùng in bảng tiền đề của từng từ và kế hoạch chạy.
2. **Khởi động ứng dụng** với `ENRICHMENT_ENABLED=true` (cùng tiến trình xử lý job khi `ENRICHMENT_WORKER_ENABLED=true`, hoặc chạy thêm `npm run worker`), `ENRICHMENT_PUBLISH_POLICY=review`, đủ `GOOGLE_TRANSLATE_API_KEY` và `ANTHROPIC_API_KEY`: `npm run dev` (hoặc `npx tsx app.ts`). Script nghiệm thu đọc cùng `.env` nên hai bên phải cùng cấu hình. Từ spec 1.5 mặc định đã là `review`, nhưng một dòng `ENRICHMENT_PUBLISH_POLICY=auto` **tường minh** trong `.env` vẫn thắng mặc định: kiểm tra `.env`, hoặc đặt biến trong chính shell chạy cả máy chủ lẫn script (dotenv không ghi đè biến đã có trong shell), ví dụ `ENRICHMENT_ENABLED=true ENRICHMENT_PUBLISH_POLICY=review npm run dev`.
3. **Giữ staging yên lặng** trong lúc chạy: nhóm A và B được chấm bằng "bộ đếm ký tự Google không đổi", mọi lần tra khác trên DB này làm nhiễu. **Xem ai đang nối vào DB**: `SELECT name, host, started_on, heartbeat_on, stopped_on FROM pgboss.instance ORDER BY started_on DESC LIMIT 8;`. Mọi worker còn sống (`stopped_on` trống, `heartbeat_on` mới) đều nhận job của lần nghiệm thu, kể cả một bản triển khai trên máy chủ khác, và dùng cấu hình riêng của nó (`ENRICHMENT_PUBLISH_POLICY` mặc định là `review` khi không đặt, từ spec 1.5; worker chạy bản mã cũ vẫn mặc định `auto` cho tới khi được triển khai lại hoặc được đặt biến tường minh). Lần nghiệm thu 15/10/2026 chạy khi có một worker từ xa như vậy cùng nối vào DB dev (xem mục 7 của báo cáo).
4. **Chạy:**
   ```bash
   npm run acceptance:lookup -- --staging --base-url http://localhost:3000
   npm run acceptance:lookup -- --staging --only C,H --wait-minutes 15     # chỉ một số nhóm (A B C D E F H)
   ```
   `--wait-minutes` (mặc định 10) là thời gian chờ job nền. **Mã thoát**: 0 = không có "không đạt" và mọi từ đều có kết luận; 1 = có "không đạt" (hoặc ký tự Google đổi, hoặc p95 vượt); **3 = không có "không đạt" nhưng còn từ "không đánh giá được: nguồn ngoài lỗi"** (đừng đọc là đạt; mục 12.2). Thứ tự chạy là A, B, C, D, **H**, E, F (không phải thứ tự của đề bài: H trước E và F, mục 12.2). Mất khoảng 2 phút cộng thời gian job (~10 s mỗi job, hai job song song). Đăng nhập chỉ một lần (giới hạn 5 lần mỗi 15 phút mỗi IP). Script tự giãn các lần tra từ chưa có trong từ điển để không chạm `LOOKUP_MISS_RATE_LIMIT_PER_MIN` (gặp 429 thì chờ `Retry-After` rồi thử lại một lần và ghi chú).
5. **Đọc kết quả.** *Bỏ qua* = tiền đề sai (ví dụ nhóm C, D, H mà từ đã có mục từ, kể cả mục từ `published = false`; xem mục 5 của báo cáo), **không phải lỗi**; nhóm C và H có từ dự phòng thay (C: nostalgia, gregarious, lucid; H: trunk, rack, pawn, bark, crane, pitch, seal, bolt, stalk, jam). *Không đạt* kèm nguyên nhân từng dòng ở mục 4 của báo cáo. *Không đánh giá được: nguồn ngoài lỗi* ở mục 4.1 (mục 12.2).
6. **Dọn dẹp** (tùy chọn): `npm run acceptance:lookup -- --staging --cleanup` (thêm `--dry-run` để chỉ liệt kê). Nó **in tên DB và bắt gõ lại đúng tên database** mới xóa; gõ sai thì không xóa gì. Chỉ xóa mục từ có `admin_note` bắt đầu `[auto]`, `headword` là một trong các từ đã chạy và **tạo sau khi lần chạy bắt đầu** (`.acceptance.state.json`), cùng các hàng job của những từ đó từ thời điểm ấy. Mục từ cũ hơn lần chạy (kể cả mục từ seed tạo cho nhóm A và B) và các dòng `word_forms` thêm vào mục từ có sẵn thì giữ lại. Từ chối nếu còn job `queued` / `running`.

Kỳ vọng từng nhóm (cũng là bảng trong `tests/acceptance/evaluate.test.ts`):

| Nhóm | Từ | Đường nhanh | Job nền |
|---|---|---|---|
| A, có sẵn | run, bank, light | 200, `source=dictionary`, không có `temporary` | không có job |
| B, dạng biến | ran, running, went, children, banks, lights | 200, `source=dictionary`, `matched_form` là chính từ gõ; ký tự Google không đổi trên A và B | không có job; sau vài giây có dòng `word_forms` cho dạng đó |
| C, từ mới phổ biến | serendipity, ubiquitous, ephemeral, podcast, quarantine, procrastinate | 200, `translation`, `temporary`, `translation_vi` khác null và khác từ gốc, `enrichment.status=queued` | `succeeded`; có mục từ; tầng A đủ; `meaning_vi` không rỗng; `published` theo chính sách |
| D, vay mượn | karaoke, sushi, tsunami | 200, `translation` (không phải 404), `translation_vi` khác null | `succeeded` |
| E, tên riêng | london, microsoft, shakespeare | 200, `translation` | `rejected / proper_noun`; không có mục từ |
| F | asdfghjk, xinchao | 404 `ENTRY_NOT_FOUND` | không có job |
| F | recieve | 200 hoặc 404 | không có mục từ `recieve`; job nếu có thì `skipped / variant_form` |
| H, nhiều nghĩa | batter, mole, sage, tick, bass, fawn | 200, `translation`, `senses` có từ 2 phần tử khác loại từ hoặc khác `gloss_vi`, `meanings_vi` từ 3 phần tử | `succeeded`; mục từ có từ 2 sense; `meaning_vi` có từ 2 nghĩa |
| Chung | | p95 của C, D, E, H không quá `LOOKUP_TOTAL_DEADLINE_MS` + 500 ms | |

### 12.1 Kết quả lần chạy đầu (15/10/2026, DB dev, `ENRICHMENT_PUBLISH_POLICY=review`)

**18 đạt, 10 không đạt, 6 bỏ qua** (28 từ chạy). Chi tiết từng từ: `docs/lookup-acceptance-report.md`. Mười dòng không đạt, và vì sao:

| Từ | Nguyên nhân (đã đối chiếu với log máy chủ `lookup`) | Loại |
|---|---|---|
| microsoft, shakespeare | 503. Google trả bản dịch giống hệt từ gốc (không dùng được) và Free Dictionary **treo** (`fd: error:timeout`), nên ma trận §6 "không G, FDerr" cho 503. Kỳ vọng "partial vì Free Dictionary 404" không xảy ra vì dịch vụ này không trả 404 JSON. Job vẫn `rejected / proper_noun` đúng | dịch vụ ngoài, khác kỳ vọng |
| asdfghjk, xinchao | 503 thay vì 404, cùng nguyên nhân: Free Dictionary treo với từ rác (`docs/lookup-api-notes.md` mục 1.3). Không job, đúng | dịch vụ ngoài, khác kỳ vọng |
| batter, mole, sage, tick, trunk, fawn (nhóm H, 6 từ) | `senses = 0`, `meanings_vi` có 1 phần tử: Free Dictionary không trả dữ liệu. Sáu từ này tra liền sau nhóm E và F, nơi 5 lần treo liên tiếp (microsoft, shakespeare, asdfghjk, xinchao, recieve) **đã mở mạch `free_dictionary`**, nên cả sáu ghi `fd: error:breaker_open`. Chạy riêng lại nhóm H sau khi mạch đóng (rack, pawn): vẫn không đạt (`rack`: timeout 2,5 s; `pawn`: mạch mở lại). Job nền của cả 6 từ H **đạt** (mục từ có 3 đến 6 sense). Chưa chứng minh được điều kiện H đạt khi Free Dictionary khỏe | dịch vụ ngoài (và thứ tự nhóm) |
| p95 nhóm C, D, E, H = 3.756 ms (> 3.500) | Hạn chót 3.000 ms chỉ bao các cuộc gọi ra ngoài. Sau đó còn gửi job (F11: giao dịch pg-boss, ~0,5 s với DB ở Singapore) rồi ghi `word_lookups`, và request HTTP còn qua xác thực + kiểm tra đoạn văn (~0,15 s). Log: `latency_ms` của dịch vụ lên 3.600 (local 154 + chờ Free Dictionary 2.857 + ~0,6 s phần sau hạn chót), thêm ~0,15 s ở HTTP. Chỉ xảy ra khi Free Dictionary treo hết hạn chót; lúc nó trả lời, các nhóm này mất 1,0 đến 1,7 s | thiết kế hiện tại; cần bạn quyết (xem báo cáo cuối của P7b) |

Điều đạt: A và B (9/9, mỗi lần tra ~0,2 s, **ký tự Google không đổi: 2.883 trước và sau**, mọi dạng biến đã có dòng `word_forms`), C, D (7/7 job), E (3/3 `rejected / proper_noun`), `recieve` (`skipped / variant_form`, không mục từ), 12/12 job nhóm C, D, H `succeeded` và `published = false`.

### 12.2 Khi Free Dictionary lỗi: cách chấm (bản vá 16/10/2026)

Lần chạy đầu cho thấy hai thứ không phải lỗi của mã vẫn bị ghi "không đạt": nhóm H (Free Dictionary đã bị mạch ngắt mở bởi E và F) và các ca 503 của E, F (Free Dictionary treo). Bộ nghiệm thu nay xử lý như sau; **đặc tả mục 6 không đổi và không được sửa để hợp thức hóa kết quả**.

1. **Thăm dò trước khi chạy.** Gọi THẲNG Free Dictionary 3 lần liền, **mỗi lần một từ thông dụng khác nhau** (`house`, `water`, `tree`; không qua máy chủ, để không làm mạch ngắt của máy chủ nhích). Không dùng một từ mẫu duy nhất như `hello`: ngày 16/10/2026 dịch vụ trả `hello` trong 0,2 s (CDN của họ có sẵn) trong khi mọi từ khác treo quá 8 giây, nên một lần thăm dò bằng `hello` gọi một dịch vụ đã chết là khỏe. **Khỏe** chỉ khi cả 3 lần trả 200 với danh sách mục từ không rỗng trong `LOOKUP_UPSTREAM_TIMEOUT_MS`. Kết quả 3 lần được in và ghi vào báo cáo (mục 1.1). Thăm dò lại sau mỗi lần chờ mạch ngắt và sau lượt tra. Nếu lần thăm dò ĐẦU không khỏe, **nhóm H không được chạy**: lượt tra không chấm được, và mỗi lần chạy để lại một mục từ cho từng từ (job không cần Free Dictionary) nên chỉ làm hao từ và hỏi thêm một dịch vụ đang chập chờn. Các từ của nó nằm ở mục 4.1 của báo cáo với lý do "chưa chạy" và được giữ nguyên cho lần chạy lại. Nhóm E và F vẫn chạy.
2. **Nhãn mới: "không đánh giá được: nguồn ngoài lỗi"** (không phải đạt, không phải không đạt). Áp cho: (a) nhóm H khi Free Dictionary không khỏe lúc tra (thăm dò trước đó hoặc sau lượt tra không khỏe, hoặc mạch ngắt có vẻ đang mở) mà từ không có sense; ngoài ra, mỗi từ H trả về không có sense còn được **hỏi lại đúng từ đó** sau lượt tra: Free Dictionary có dữ liệu cho từ ấy (nghĩa là máy chủ không nhận được gì lúc tra: timeout, phản hồi hỏng, mạch ngắt) hoặc vẫn không trả lời thì không đánh giá được; nếu nó trả **404** cho từ đó thì từ H chọn không hợp và vẫn là không đạt (ba từ thông dụng của lần thăm dò có thể khỏe trong khi các từ chưa nằm trong bộ nhớ đệm của họ thì treo, đã thấy ngày 16/10/2026); (b) **mọi ca 503 `TRANSLATION_UNAVAILABLE` của nhóm E, F, H**. Lý do (b): theo ma trận mục 6, "không G, FDerr → 503" là cách DUY NHẤT ra 503; từ rác như `asdfghjk`, `xinchao` không có bản dịch của Google nên câu trả lời phải chờ Free Dictionary, và khi nó treo thì máy chủ KHÔNG được bịa ra 404 mà phải trả 503. Vậy 503 ở đó là hành vi **đúng** (**đạt có ghi chú**); chỉ kỳ vọng của nhóm (E: 200, F: 404) là không kiểm tra được. Báo cáo ghi câu này mỗi lần.
3. Mọi lỗi khác vẫn là "không đạt" dù Free Dictionary ra sao (sai mã HTTP, sai `source`, thiếu bản dịch, job sai). Một dòng có phần nhanh "không đánh giá được" nhưng phần job "không đạt" vẫn là **không đạt**.
4. **Thứ tự và mạch ngắt.** Nhóm H chạy trước E và F (E, F là hai nhóm làm Free Dictionary treo). Giữa hai nhóm, nếu `UPSTREAM_BREAKER_FAILURE_THRESHOLD` lần tra liên tiếp cuối cùng đều cho thấy Free Dictionary lỗi (503, hoặc nhóm C, D, H trả bản tạm thiếu `pos`) thì máy chủ có vẻ đã ngắt mạch: script chờ `UPSTREAM_BREAKER_RESET_MS` (cộng 2 s đệm) tính từ lần lỗi cuối, thăm dò lại, rồi mới sang nhóm kế. Thời gian chờ được ghi vào báo cáo.
5. **Chạy lại riêng.** Báo cáo và console in đúng lệnh, chỉ gồm các nhóm còn dòng chưa đánh giá được (theo thứ tự chạy), ví dụ `npm run acceptance:lookup -- --staging --only H,E,F --base-url http://localhost:3000`. Nhóm H đã chạy để lại mục từ cho từng từ (job không cần Free Dictionary) nên các từ đó thành "bỏ qua: đã có mục từ"; script lấy từ dự phòng kế tiếp (có 10 từ dự phòng cho H). **Không dùng `--cleanup`** nếu bạn không muốn xóa dữ liệu.

### 12.3 Kết quả sau bản vá (16/10/2026, DB dev, `ENRICHMENT_PUBLISH_POLICY=review`)

Ba lần chạy liên tiếp với mã mới (gửi job và ghi `word_lookups` sau response) và công cụ nghiệm thu mới. Nguồn ngoài hỏng cả ngày nên đây **không phải** lần chạy 30 từ đầy đủ. Bảng và phân tích: `docs/lookup-acceptance-report.md` mục 7.

| Lần chạy | Mã | Chạy | Đạt | Không đạt | Không đánh giá được | p50 / p95 nhóm C, D, E, H |
|---|---|---|---|---|---|---|
| 15/10 (P7b) | cũ: gửi job trước response; Free Dictionary đã mở mạch ở E, F nên hỏng H | 28 từ (6 bỏ qua) | 18 | 10 | (chưa có nhãn) | 1.0 đến 1.7 s khi nguồn khỏe; **p95 3.756 ms, vượt 3.500** |
| 16/10 lần 1 | mới: gửi job và ghi `word_lookups` SAU response; công cụ đã có nhãn "không đánh giá được" cho 503 của E, F | 15 từ (27 bỏ qua) | 6 | 5 (nhóm H: `senses = 0`) | 4 (503 của E, F) | 3.075 ms / **3.389 ms**, trong giới hạn |
| 16/10 lần 2 | thêm hỏi lại ĐÚNG từ H sau lượt tra | 15 từ (34 bỏ qua) | 5 | 0 | 10 (6 H, 2 E, 2 F) | 834 ms / **3.432 ms**, trong giới hạn |
| 16/10 lần 3 (báo cáo ở trên) | thêm thăm dò bằng 3 từ khác nhau; nhóm H không chạy khi nguồn không khỏe | 9 từ (40 bỏ qua) | 5 | 0 | 10 (6 H chưa chạy, 2 E, 2 F) | 616 ms / **3.396 ms**, trong giới hạn |

* **p95 đã nằm trong giới hạn**: 3.389, 3.432 và 3.396 ms so với 3.756 ms trước vá (giới hạn 3.500 ms), kể cả khi nhiều câu chạm hết hạn chót vì Free Dictionary treo. Phần vượt hạn chót của câu chậm nhất giảm từ ~756 ms xuống ~390 đến 430 ms.
* **Free Dictionary hỏng thật** (`curl` trực tiếp: `hello` và `house` nhanh nhờ CDN, mọi từ khác treo hoặc trả 404). Vì thế nhóm H và 503 của E, F là "không đánh giá được: nguồn ngoài lỗi"; 503 của từ rác là hành vi đúng của mục 6 (đạt có ghi chú).
* Đã sửa công cụ qua ba lần chạy: lần 1 cho thấy thăm dò bằng `hello` gọi một dịch vụ đã chết là khỏe, nên nay thăm dò bằng ba từ khác nhau, hỏi lại đúng từ H không có sense, và không chạy H khi nguồn không khỏe.
* Còn thiếu để chạy đủ 30 từ (cần bạn quyết, mục 7 của báo cáo): nhóm C, D đã có mục từ từ lần 15/10 (cần `--cleanup`, bị cấm ở đợt này); `run`, `go`, `light` đang `published = false` (cần `seed:lookup-test`, sẽ xuất bản lại chúng); nhóm H dùng hết 6 từ mỗi lần chạy.

## 13. Nạp Oxford 5000 (`enrich:seed-oxford`, `oxford:apply-cefr`, `enrich:publish`)

Mục tiêu: mọi từ của danh sách Oxford 5000 chưa có trong từ điển đi qua đường ống làm giàu P6 **như một job bình thường** (cùng enqueuer, cùng trần ngày, cùng worker). Báo cáo của đợt nạp: `docs/lookup-oxford-seed-report.md` (sinh bằng `--report`).

**Quy tắc cứng.**

* Oxford chỉ cho **danh sách từ, loại từ và mức CEFR**. Định nghĩa và ví dụ của Oxford là tài sản của OUP và **không được đưa vào** (trình đọc không giữ chúng, có test). IPA và audio của Oxford cũng không được đưa vào; chúng chỉ được ĐẾM để báo cáo độ phủ.
* Không sửa, không xóa mục từ nào đã có (845 mục không phải `[auto]` và 3 mục `[auto]` cũ). Từ đã có trong `dictionary_entries` (kể cả `published = false`), trong `word_forms` hoặc đang trong hàng đợi thì không gửi.
* Không tự đặt `ENRICHMENT_PUBLISH_POLICY=auto`, không tự xuất bản. Mục từ mới luôn chờ duyệt.
* Mỗi giai đoạn dừng và chờ người dùng xem báo cáo.

### 13.1 File Oxford

`P:\Personal\WordyGo_Full\oxford_5000.json` có dạng `{ id, value: { word, type, level, phonetics: { us, uk }, us: { mp3, ogg }, uk: { mp3, ogg }, examples } }` (không có `definition`, mức CEFR nằm ở `level`). Dạng phẳng của `docs/reference/import-oxford.mjs` (`word, type, cefr, phon_br, phon_n_am`) cũng được đọc. Trình đọc (`services/enrichment/oxford/list.ts`) lấy **chỉ** `word`, `type`, `level`:

* chữ thường; các dòng trùng gộp thành MỘT từ với tập loại từ và mức CEFR **thấp nhất** (5.948 dòng, 4.958 từ khác nhau, 990 dòng thừa của 883 từ, 343 từ có nhiều mức); dòng có mức trống không tính là một mức;
* chạy bộ làm sạch của đường tra cứu (`normalizeWord`): 9 cụm nhiều từ (`according to`, `ice cream`, `used to`…) bị từ chối và được liệt kê; từ có gạch nối hoặc dấu nháy (`well-being`, `o'clock`) hợp lệ.

### 13.2 Trước khi nạp

| Việc | Cách kiểm | Ghi chú |
|---|---|---|
| `ENRICHMENT_ENABLED=true` | `--confirm` tự kiểm | Đặt trong môi trường **của lệnh** và của worker. `.env` của dự án đang là `false` |
| 30 chủ đề trong `tags` | `--confirm` tự kiểm (`loadTopicIds`) | Thiếu thì chạy `docs/seed-topics.sql` |
| `ENRICHMENT_PUBLISH_POLICY=review` | `--confirm` tự kiểm | `auto` bị từ chối trừ khi có thêm `--allow-auto`. `.env` của dự án đang là `auto`: **ghi đè bằng biến môi trường của lệnh và của worker, không sửa `.env`** |
| Có đúng một worker, của máy bạn | `--confirm` tự kiểm bảng `pgboss.instance` (không dừng, nhịp tim trong 3 phút) | Có worker của máy khác (kể cả máy chủ triển khai) thì từ chối: worker đó cũng nhận job, với cấu hình và mã của nó |
| So chi phí ước tính với trần chi tiêu hằng tháng của Anthropic | bạn tự làm | Lệnh nhắc trước khi gửi |
| Bảng giá còn đúng | `services/enrichment/pricing.ts` (`PRICING_CHECKED_ON`) | Là bảng nhập tay, ước tính chứ không phải hóa đơn |

### 13.3 Công cụ 1: `enrich:seed-oxford`

```bash
# chạy thử (MẶC ĐỊNH): in số từ, nguồn loại, ước tính chi phí / thời gian / số ngày, các kiểm tra
npm run enrich:seed-oxford -- --file "P:\Personal\WordyGo_Full\oxford_5000.json" --sample 50
npm run enrich:seed-oxford -- --file "<file>" --only-cefr A1,A2 --offset 0 --limit 500
# gửi thật (chỉ khi có --confirm; kiểm tra trước, một kiểm tra hỏng thì không gửi gì)
ENRICHMENT_ENABLED=true ENRICHMENT_PUBLISH_POLICY=review npm run enrich:seed-oxford -- --file "<file>" --sample 50 --confirm
# gửi lại các từ của LẦN GỬI GẦN NHẤT mà job chưa thành mục từ (chạy thử trước, rồi --confirm)
npm run enrich:seed-oxford -- --file "<file>" --retry-last-run
# báo cáo (đọc DB, trạng thái local, log của worker); ghi docs/lookup-oxford-seed-report.md
npm run enrich:seed-oxford -- --file "<file>" --report --worker-log <log của worker> [--from-run N]
```

Tùy chọn: `--limit N`, `--offset N`, `--only-cefr A1,A2`, `--sample N` (mẫu phân tầng, thay `--limit`/`--offset`), `--retry-last-run` (chỉ các từ của lần gửi gần nhất; không đi cùng bốn tùy chọn chọn từ trước), `--dry-run`, `--confirm`, `--report`, `--worker-log <tệp>`, `--from-run N` (chỉ với `--report`: báo cáo từ lần gửi thứ N trở đi), `--allow-auto`. **Tùy chọn lạ bị từ chối với mã 2** (gõ nhầm `--confirmed` không chạy thành xác nhận); `--dry-run` cùng `--confirm` bị từ chối.

* **Loại**: từ đã có mục từ (headword hoặc lemma), đã là dạng biến trong `word_forms`, đang `queued`/`running`; và từ mà job gần nhất đã **kết thúc hẳn không để lại mục từ** (`rejected`, `skipped` với `variant_form` hoặc `lemma_mismatch`, hoặc `failed / invalid_output` đã xảy ra **hai lần**) để không tốn token cho cùng một kết quả. Lần `invalid_output` đầu tiên **không** đóng từ: từ được gửi thêm đúng một lần nữa (Haiku không tất định), và dòng chạy thử ghi "GỬI LẠI n từ" kèm lý do. Job `succeeded` mà mục từ đã bị xóa (ví dụ bởi `scripts/dev/cleanup-auto-entries.ts`) thì từ được gửi lại. Job `failed` vì `upstream_error`, `budget`, `config_error`, `dead_letter`, `stale` cũng được gửi lại.
* **Thứ tự gửi**: mức CEFR tăng dần, rồi tần suất (`ref_word_frequency.rank`, hạng 1 trước, thiếu hạng sau), rồi chữ cái. `--only-cefr` giữ một số mức; `--offset` và `--limit` cắt danh sách đã sắp.
* **Mẫu phân tầng** (`--sample 50`): mỗi mức có từ nhận phần bằng nhau (50 từ, 5 mức = 10 từ mỗi mức), phần dư cho mức thấp, mức thiếu từ nhường phần cho mức khác; trong một mức các loại từ lần lượt (loại lớn nhất trước), trong một loại từ chọn theo băm cố định (cùng kết quả mọi lần chạy, không phải `Math.random`). Từ không có mức CEFR không nằm trong mẫu.
* **Dừng và chạy tiếp**: gặp `daily_cap` thì dừng ngay và nói còn bao nhiêu từ; chạy lại lệnh vào ngày UTC sau (hoặc sau khi nâng `ENRICHMENT_MAX_JOBS_PER_DAY`) thì tiếp tục từ chỗ dừng, không tạo job trùng (từ đã gửi nằm trong hàng đợi hoặc đã thành mục từ nên bị loại). Ba lỗi liên tiếp của enqueuer (hàng đợi hoặc DB hỏng) cũng dừng.
* **Ước tính**: chi phí = trung bình thật của các hàng `word_enrichment_jobs` đã gọi Haiku (từ 5 hàng trở lên; giả định 7.859 token system prompt đọc từ cache mỗi job, công thức ở mục 11.4), nếu chưa đủ thì **0,00085 USD/từ và ghi rõ là ước tính**; thời gian = **đồng hồ treo tường** mỗi từ đo từ các đợt trước (khoảng cách trung vị giữa hai job `succeeded` xong liên tiếp khi worker bận, 30 ngày gần nhất, ở độ song song của đợt đó; KHÔNG dùng `finished_at - created_at` vì nó gồm cả thời gian chờ trong hàng đợi và từng cho ra "52 giây/từ" cho một đợt 50 job nạp cùng lúc); chưa có lịch sử thì 10 giây công việc mỗi từ chia cho `ENRICHMENT_WORKER_CONCURRENCY`; số ngày theo `ENRICHMENT_MAX_JOBS_PER_DAY` trừ số đã dùng hôm nay (UTC). Không tính lần thử lại: số thật ở báo cáo.
* **Trạng thái local**: mỗi lần `--confirm` ghi `.oxford-seed.local.json` (git bỏ qua): các từ đã gửi, cách chọn, kích thước DB và bộ đếm token **trước khi gửi**, ước tính. `--report` cần tệp này để biết đợt nạp nào thuộc về mình. Không chứa khóa hay đường dẫn.

### 13.4 Ba giai đoạn

| Giai đoạn | Lệnh | Dừng và hỏi bạn khi |
|---|---|---|
| 1. Thử 50 từ phân tầng | `--sample 50 --confirm` | luôn dừng sau đợt này và báo cáo |
| 2. 500 từ | `--limit 500 --confirm` (sau khi giai đoạn 1 được duyệt; **500 từ đầu theo thứ tự CEFR rồi tần suất đều là A1 thông dụng nhất, lát cắt khó nhất**). Xong lượt đầu: `--retry-last-run` (chạy thử, rồi `--confirm`) gửi lại các từ chưa thành mục từ đúng một lần; báo cáo bằng `--report --from-run N`. Nâng `ENRICHMENT_MAX_JOBS_PER_DAY` (ví dụ 1500) ở lệnh gửi **và trả lại sau**; `ENRICHMENT_WORKER_CONCURRENCY=4` ở worker (tăng nếu không có 429). Thêm 30 từ ngẫu nhiên để xem | `invalid_output` quá 5%, chi phí trung bình quá 2 lần ước tính, hoặc quá 3 lỗi 429 / hết ngân sách liên tiếp |
| 3. Phần còn lại | mỗi lệnh tối đa 1000 từ (`--limit 1000 --confirm`), sau mỗi lô một báo cáo ngắn | cùng tiêu chí |

`--report` in ba chỉ số dừng khẩn cấp ở mục 2 và 4 của báo cáo. Hàng `skipped / budget` không nằm trong hàng chết: xem mục 10.3.

### 13.5 Bật và tắt worker trong lúc nạp

Worker thăm dò hàng đợi mỗi 5 giây nên giữ Neon thức và tốn giờ CU: **chỉ bật trong lúc nạp, tắt khi xong**.

```bash
# bật (cửa sổ riêng; ghi đè cấu hình của .env bằng biến môi trường của tiến trình)
ENRICHMENT_ENABLED=true ENRICHMENT_PUBLISH_POLICY=review npm run worker > worker.log 2>&1
# xong khi không còn job: npm run enrich:status  (hoặc SELECT … FROM word_enrichment_jobs WHERE status IN ('queued','running'))
```

Tắt: `Ctrl+C` (tắt gọn: chờ job đang chạy, SHUTDOWN_GRACE_MS 30 giây). Nếu tiến trình chạy nền và không có cửa sổ, trên Windows `taskkill /PID <pid> /T /F` là **tắt cứng** (không có SIGTERM): chỉ làm khi hàng đợi đã trống, và chỉ với PID **của chính bạn** (tìm bằng dòng lệnh chứa `worker.ts`); dòng `pgboss.instance` của nó vẫn có `stopped_on` trống nhưng nhịp tim cũ, nên sau 3 phút không còn được coi là đang chạy. Kiểm tra: `SELECT name, host, pid, heartbeat_on, stopped_on FROM pgboss.instance ORDER BY started_on DESC LIMIT 5;`.

### 13.6 Công cụ 2: `oxford:apply-cefr`

```bash
npm run oxford:apply-cefr -- --file "<file>" --dry-run    # xem trước: số mục sẽ đổi và ma trận Haiku × Oxford
npm run oxford:apply-cefr -- --file "<file>"              # áp dụng
```

Khác hai công cụ kia, lệnh này **áp dụng ngay khi không có `--dry-run`**. Chỉ đụng mục từ có `admin_note` bắt đầu bằng `[auto]` mà headword nằm trong file; mức mới là mức **thấp nhất** của từ trong Oxford. Mỗi mục đổi mức được ghi một dòng `entry_edit_history` (`field_name = 'cefr_level'`, `admin_id` NULL, giá trị cũ và mới) và được nối ` · [oxford-cefr]` vào `admin_note`; mục Haiku đã trùng mức chỉ được đánh dấu (không có gì để ghi lịch sử). Mục đã có dấu thì bị bỏ qua: **chạy lại không đổi gì**. Toàn bộ trong một giao dịch, các hàng được khóa và kiểm lại. `[oxford-cefr]` là một phần riêng của `admin_note` (`utils/autoEntryNote.ts`), không bị đọc nhầm thành ghi chú của Haiku nên không đổi kết quả xuất bản hàng loạt. Ma trận đọc mức Haiku từ lịch sử nên vẫn đúng sau khi đã áp.

### 13.7 Công cụ 3: `enrich:publish`

```bash
npm run enrich:publish                                   # chạy thử (MẶC ĐỊNH): ai sẽ được xuất bản, ai bị giữ và vì sao
npm run enrich:publish -- --cefr A1,A2 --limit 500       # chạy thử một lát cắt
npm run enrich:publish -- --cefr A1,A2 --limit 500 --confirm
```

Dùng đúng tiêu chí của nút xuất bản hàng loạt ở `/lookup/review` (`docs/lookup-admin.md` mục 3.4): mục từ `[auto]`, chưa xuất bản, đủ tầng A, không có ghi chú của Haiku thuộc nhóm "cần xem". Không sao chép luật: dùng chính `tierAMissing`, `tierAFactsFor`, `parseAutoNote`, `blockingReviewNotes`, và có test đối chiếu với `eligible_for_bulk_publish` của API. Thứ tự: mức CEFR rồi chữ cái; `--cefr` lọc theo `cefr_level` của mục từ (nên chạy `oxford:apply-cefr` trước); `--limit` mặc định 500. Mỗi mục xuất bản được ghi `entry_edit_history` (`field_name = 'published'`, `admin_id` NULL, `old_value` `false`, `new_value` `true (cli)`). Một giao dịch; các hàng được khóa và luật được áp lại lên đúng những hàng đã khóa, nên mục từ vừa bị sửa hoặc vừa được người khác xuất bản bị bỏ qua và được báo. **Không bao giờ tự xuất bản**: không có `--confirm` thì không có gì được ghi. Công cụ này dùng `services/lookup/reviewNotes.ts` (nhóm ghi chú của P9).

### 13.8 Báo cáo và câu SQL tự kiểm tra

`docs/lookup-oxford-seed-report.md`: kết quả theo trạng thái / lý do; từ bị bỏ qua; token và chi phí thực (hàng sổ và bộ đếm, kể cả lần thử lại) so với ước tính; thời gian (từ log worker nếu có `--worker-log`); phân bố CEFR (ma trận Oxford × Haiku); phân bố chủ đề; mục thiếu IPA, audio, ví dụ; dung lượng DB trước và sau, kèm kích thước dữ liệu thật của các hàng mới (dung lượng trên đĩa không tăng khi hàng mới dùng lại chỗ trống); 30 từ ngẫu nhiên kèm nghĩa; 10 mục từ đầy đủ; các câu SQL. Phần giữa hai dấu `BEGIN GENERATED` / `END GENERATED` được ghi lại mỗi lần; phần "Ghi chú các giai đoạn" viết tay sau dấu kết thúc được giữ.

### 13.9 Giới hạn đã biết

* `ought` bị `skipped / variant_form` vì các dòng Wiktionary của nghĩa trợ động từ mang thẻ `dialectal`/`formal`, và quy tắc "mọi dòng là phi chuẩn thì bỏ" coi cả từ là phi chuẩn (dương tính giả của quy tắc ở S2, không phải của công cụ nạp). Từ như vậy cần tạo tay hoặc sửa quy tắc.
* `invalid_output` (bản nháp vẫn sai sau một lần sửa) xảy ra ở khoảng 4% số từ của giai đoạn 1 (`into`, `theirs`). Haiku không tất định: cùng từ có thể qua ở lần chạy khác (`into` qua khi chạy lại bằng `enrich:run --dry-run`). Công cụ gửi lại mỗi từ **một lần** (mục 13.3, `--retry-last-run`); hỏng hai lần thì coi là kết thúc, và cần xử lý tay (`enrich:enqueue`, hoặc sửa gốc: xem nguyên nhân ở mục 2 của báo cáo).
* Từ rất nhiều nghĩa (giới từ, trạng từ, đại từ thông dụng như `out`, `into`, `right`, `off`, `still`) dễ vi phạm `schema_too_big` (hơn 6 sense), cả ở bản đầu lẫn sau khi sửa. Từ càng thông dụng càng nhiều nghĩa trong Wiktionary, nên 500 từ A1 đầu bảng (sắp theo tần suất) là lát cắt khó nhất của danh sách.
* Từ `invalid_output` được giải thích bằng `issues` / `first_issues` (mã validator và đường dẫn trường, không có nội dung bản nháp) trong dòng log `enrich` của worker; `--report --worker-log` tổng hợp theo luật và theo loại từ. Worker cũ (trước P10) không ghi trường này.
* Ước tính chi phí giả định 7.859 token system prompt được đọc từ cache và dùng bảng giá nhập tay; hàng sổ chỉ lưu token của lần chạy cuối của mỗi job. Số tiền đúng là hóa đơn của Anthropic.
* Mỗi từ gửi qua enqueuer thật mất khoảng 0,6 giây với DB ở xa (50 từ trong 29 giây); một lệnh 1000 từ cỡ 10 phút.
