# WordyGo · Kiểm toán đối chiếu đặc tả tra từ (P7)

Ngày 15/10/2026 · Đối chiếu `docs/lookup-spec.md` (v1.3) mục 4 đến 6, 11, 12, 13 với toàn bộ mã P2 đến P6b, bằng cách **đọc mã và chạy**: mỗi dòng "Đạt" có test chạy thật làm bằng chứng (cột cuối). Mục thiếu hoặc lệch được **vá ngay trong P7** (đánh dấu "đã vá"); mục cần bạn quyết nằm ở mục 5.

Chú giải trạng thái:

* **Đạt**: đúng spec, có test.
* **Đạt, đã vá**: thiếu hoặc lệch so với spec, đã sửa trong P7 (ghi rõ sửa gì).
* **Đạt, chấp nhận lệch**: lệch có lý do chính đáng, ghi lý do.
* **Ngoài P7**: thuộc prompt khác.

Quy ước test: `e2e` = `tests/e2e/lookup.e2e.test.ts` (ứng dụng thật qua HTTP, Postgres thật, máy chủ giả); `chaos` = `tests/chaos/*` (`npm run test:chaos`); `loadtest` = `scripts/loadtest/lookup-burst.ts`.

## 1. Mục 4 đến 6: hợp đồng API, đường nhanh, ma trận

| Mục | Yêu cầu | Trạng thái | Tệp và hàm | Bằng chứng, ghi chú |
|---|---|---|---|---|
| 4.1 | 200 `dictionary`; 200 `translation` (bản tạm); 400; 404 `ENTRY_NOT_FOUND`; 429 `LOOKUP_RATE_LIMITED` kèm `Retry-After`; 503 | Đạt | `routes/api/ebooks.ts` (`POST /:id/lookup`) | e2e: từng mã qua HTTP, kể cả `Retry-After` nguyên từ 1 đến 60 và 11 chuỗi `INVALID_WORD` |
| 4.2 | Trường mới của bản tạm (`temporary`, `headword`, `ipa`, `meanings_vi`, `senses`, `partial`, `missing`, `attribution`, `enrichment`…) | Đạt, chấp nhận lệch | `services/lookup/merge.ts` `composeTemporary` | Spec đặt tên `pos: string[]` nhưng `pos` cũ là **chuỗi** (app cũ đọc); nên danh sách là `pos_list` và `phonetic` giữ cùng `ipa` (đã ghi ở `docs/lookup-api.md`). e2e kiểm tra từng trường |
| 4.3 | `matched_form` khi khớp qua `word_forms` hoặc dạng biến | Đạt | `routes/api/ebooks.ts`, `localLookup.ts` | e2e: qua `word_forms` và qua `ref_wiktionary_en` (có ghi lại dạng vào `word_forms`) |
| 4.4 | `Cache-Control: no-store` cho mọi bản tạm; bản tạm không vào bảng từ điển hay cache | Đạt | `routes/api/ebooks.ts` | e2e: 200 tạm, 404, 429, 503 đều `no-store`, mục từ thì không; không câu SQL nào nhắc `word_translation_cache`, không có dòng nào cho từ thử |
| 4.5 | Ghi phản hồi cuối vào `docs/lookup-api.md` | Đạt | `docs/lookup-api.md` | hợp đồng không đổi ở P7; test "tương thích ngược" ghim các trường cũ (`tests/fixtures/lookup/response-contract.json`): **chỉ được thêm trường** |
| F1 | Làm sạch từ, sai thì 400 | Đạt, đã vá | `services/wordTranslationService.ts` `normalizeWord`, `stripEdges` | **Lỗi bậc hai** trong regex cắt dấu câu hai đầu (mục 4.1). Vá bằng vòng lặp tuyến tính, kết quả giống hệt (so với bản regex cũ trên 2.300 chuỗi ngẫu nhiên). `tests/security/wordFuzz.test.ts` |
| F2 | `paragraph_id` phải thuộc ebook | Đạt | `routes/api/ebooks.ts` | `tests/lookup/lookupRoute.test.ts` |
| F3 | Tăng `words_looked_up` chạy ngầm | Đạt | `routes/api/ebooks.ts` | `lookupRoute.test.ts` (đúng một lần mỗi lần tra, mọi kết cục) |
| F4 | Tra `published=true` theo headword, lemma, `word_forms` | Đạt, đã vá | `services/lookup/localLookup.ts` `lookupLocal` | Truy vấn dùng `OR` nên **không dùng được chỉ mục `lower()`** (42 đến 56 ms mỗi lần tra ở 200.000 mục từ). Đổi thành `UNION` ba tra cứu chỉ mục (0,1 ms), cùng kết quả và thứ tự. `docs/lookup-loadtest.md` mục 3 |
| F4b | Dạng biến qua `ref_wiktionary_en`, ghi ngầm `word_forms`; bảng rỗng thì bỏ qua | Đạt | `resolveViaForms`, `recordForm`, `WordLookupService.isRefPopulated` | e2e: 0 request ra ngoài, dòng `word_forms` được ghi, lần hai là F4 |
| F5 | `TRANSLATION_FALLBACK_ENABLED=false`: 404, `not_found` | Đạt | `WordLookupService.lookup` | e2e: 404, `word_lookups not_found`, **0 request** tới máy chủ giả, từ điển vẫn trả lời |
| F6 | Giới hạn theo người dùng, 429 + `Retry-After` | Đạt | `services/lookup/rateLimiter.ts` | e2e (`LOOKUP_MISS_RATE_LIMIT_PER_MIN=3`: lần thứ 4 bị từ chối trước khi ra ngoài; tra từ điển không bị tính; người khác không bị ảnh hưởng); loadtest C (20 nhận, 5 bị 429). Giới hạn nằm trong bộ nhớ từng tiến trình |
| F7 | Single-flight theo từ, không cache | Đạt | `services/lookup/singleFlight.ts` | loadtest B: 200 request, **đúng 1 request Google và 1 request Free Dictionary**; kịch bản A: mỗi chuyến bay gọi mỗi nguồn đúng một lần. `lookupService.test.ts` ("50 simultaneous lookups…") |
| F8 | Bước 1 song song, mỗi nguồn timeout `LOOKUP_UPSTREAM_TIMEOUT_MS` | Đạt | `services/lookup/upstream.ts` `fetchUpstream` | e2e hạn chót; `lookupService.test.ts` |
| F9 | Bước 2: tối đa N sense, một request Google `từ: định nghĩa`, tách tại `:` | Đạt | `senseSelection.ts`, `upstream.ts` `runStep2` | e2e (full: mọi sense có `definition_vi` và `gloss_vi`); `senseSelection.test.ts` với phản hồi Google thật |
| F10 | Gộp theo ma trận mục 6 | Đạt | `merge.ts` `mergeOutcome` | mục "Ma trận" bên dưới |
| bộ dịch nhanh | `LOOKUP_FAST_TRANSLATOR` google / haiku, dự phòng 500 ms, mạch riêng | Đạt | `fastTranslator.ts`, `haikuFastTranslator.ts`, `services/upstream/index.ts` | các test P3b hiện có; P7 thêm `anthropic_fast` vào ảnh chụp sức khỏe. P7 **không** chạy Haiku thật |
| F11 | Gửi job nếu `ENRICHMENT_ENABLED` và từ đáng tin | Đạt | `WordLookupService.planEnrichment` + `sendJob` (chạy nền sau response từ spec 1.5) | e2e: job gửi cho từ có Free Dictionary, không gửi khi nguồn không biết từ, `startAfterSeconds: 60` sau sự cố; các trạng thái khác của enqueuer và lỗi enqueuer không làm hỏng phản hồi: `lookupService.test.ts` (nhóm F11) |
| F12 | Ghi `word_lookups` (`dictionary`, `translation`, `not_found`) | Đạt | `WordLookupService.recordLookup` (chạy nền sau response từ spec 1.5) | e2e: kết quả đúng ở từng ca của ma trận; `lookupService.test.ts` (nhóm "F11 / F12 run after the response") |
| hạn chót | Tổng không vượt `LOOKUP_TOTAL_DEADLINE_MS`; hết hạn thì trả phần đã có `partial` | Đạt | `fetchUpstream` (hạn chót tính từ **đầu** lần tra) | e2e: nguồn chậm 6 s → 200 `partial` trong ~3 s; cả hai chậm → 503 trong ~3 s. Cảnh báo: DB chậm ăn hạn chót (`docs/lookup-loadtest.md` mục 2.1) |
| Ma trận §6 | 6 dòng + "không bao giờ điền `translation_vi` bằng chính từ vừa tra" | Đạt | `merge.ts` `decide`, `mergeOutcome` | e2e **mỗi dòng một ca**: F và G → 200 đầy đủ; F không G → partial, `translation_vi: null`; G và FD404; G và FDerr → partial thiếu `pos, definition_en, ipa, audio_url`; không G và FD404 → 404, `not_found`, **không** gửi job (kể cả từ mà dữ liệu ref biết); không G và FDerr → 503, `not_found`, job với `startAfterSeconds: 60` cho từ đáng tin, không gửi cho từ lạ |

## 2. Mục 11: chịu lỗi

| Mục | Yêu cầu | Trạng thái | Tệp và hàm | Bằng chứng, ghi chú |
|---|---|---|---|---|
| 11.1 | Mọi cuộc gọi ngoài có `AbortSignal.timeout`; đường nhanh thử lại tối đa 1 lần cho lỗi mạng, chỉ khi còn hạn chót; job nền thử lại theo pg-boss | Đạt | `services/upstream/http.ts` `fetchWithTimeout`, `withRetry`; client Anthropic dùng `timeout` của SDK và `maxRetries: 0` | `tests/lookup/http.test.ts`; chaos (nguồn treo → hết thời gian); không có `fetch(` trần nào trong `services/lookup`, `services/upstream`, `services/enrichment` |
| 11.2 | Breaker riêng từng nhà cung cấp (google, free_dictionary, datamuse, anthropic); mở sau N lỗi liên tiếp, nửa mở sau `RESET_MS`; 404 FD không phải lỗi; mở ngay khi hết hạn mức của nhà cung cấp hoặc lỗi cấu hình; không mở vì `monthly_chars` | Đạt | `services/upstream/circuitBreaker.ts` (`classifyOutcome`), `services/upstream/index.ts` (cộng một mạch riêng cho đường nhanh Haiku) | chaos `upstream`: mở đúng ở ngưỡng, các request sau **không gọi Google**, nửa mở để đúng một request thử, thử hỏng thì mở lại, thử tốt thì đóng; chaos `anthropic`: mở ngay vì hết hạn mức chi tiêu; hết ngân sách ký tự thì mạch **đóng** |
| 11.3 | 429 tôn trọng `Retry-After`; 400/401/403 là lỗi cấu hình, không thử lại, **log mức error**, mở breaker | Đạt, đã vá | `lookupService.ts` `reportConfigProblems`; `enrichmentWorker.ts` | Job đã log mức error; **đường tra nhanh không**: lỗi cấu hình chỉ hiện ở dòng info. Nay phát `upstream_config_error` (và `upstream_budget_exceeded`) bằng `console.error`. e2e kiểm tra |
| 11.4 | Anthropic 429 có `retry-after`: **chờ** rồi thử lại qua pg-boss; `enforced_spend_limit_reached` hoặc HTTP 400 "You have reached your specified API usage limits": `skipped / budget`, **không** thử lại, log error | Đạt, đã vá | `enrichmentWorker.ts` `retryAfterWaitMs`, `onError`; `anthropicEnrichClient.ts` `classifyAnthropicError` | Phần "chờ" **thiếu**: worker chỉ ném lỗi, lần thử lại theo backoff của pg-boss bất kể `Retry-After`. Nay chờ `min(Retry-After, 60 s)` (dừng sớm khi tiến trình tắt, không chờ ở lần cuối). chaos `anthropic`: lần gọi thứ hai cách lần đầu ≥ 2 s; cả hai dạng hết hạn mức → `skipped / budget`, gọi đúng 1 lần, job `completed`, hàng chết trống, log `error` |
| 11.5 | Token bucket `FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN`; hết lượt coi là FDerr | Đạt | `services/upstream/tokenBucket.ts`, `freeDictionaryClient.ts` | chaos: bucket 3 → request thứ tư trở đi không ra ngoài, `fd: error:local_rate_limit`, mạch không mở |
| 11.6 | Đặt chỗ ký tự Google trong `api_usage_counters` trước khi gọi; vượt trần thì không gọi, coi như Google lỗi | Đạt | `services/upstream/apiUsage.ts` `reserve` / `release`, `googleTranslateClient.ts` | chaos: 999/1000 → bản tạm thiếu nghĩa tiếng Việt, máy chủ giả nhận **0** request Google, bộ đếm không đổi; hoàn lại ký tự khi Google từ chối (`googleTranslateClient.test.ts`) |
| 11.7 | Trần `ENRICHMENT_MAX_JOBS_PER_DAY`; vượt thì `daily_cap` | Đạt, chấp nhận lệch | `services/queue/pgBossEnqueuer.ts` (bước d) | chaos qua HTTP: từ thứ ba `enrichment: { status: "skipped", reason: "daily_cap" }`, không có hàng sổ cho nó. Spec nói "job skipped": thực tế **không tạo job** (đặt chỗ, hàng sổ và job pg-boss cùng một giao dịch, nên không có gì phải hoàn lại); dấu vết là log `enrich_daily_cap` và bộ đếm `enqueue.skipped.daily_cap` |
| 11.8 | Tắt khẩn: `TRANSLATION_FALLBACK_ENABLED`, `ENRICHMENT_ENABLED`, `ENRICHMENT_WORKER_ENABLED`; worker dừng gọn | Đạt | `config/lookup.ts`, `services/queue/runtime.ts`, `boss.ts` `stopBoss`, `shutdown.ts` | e2e (cờ tra), `runtime.test.ts`; chaos `process`: dừng lịch sự → hàng về `queued`, worker khác hoàn tất; `SIGKILL` → pg-boss tự thử lại sau khi hết hạn. "offWork với wait" được hiện thực bằng `boss.stop({ graceful })` (đã ghi ở `docs/lookup-queue.md` mục 1.3) |

## 3. Mục 12 và 13

| Mục | Yêu cầu | Trạng thái | Tệp và hàm | Bằng chứng, ghi chú |
|---|---|---|---|---|
| 12.1 | Log có cấu trúc: tra `{evt:'lookup', word, outcome, source, partial, latency_ms, google_ms, fd_ms, enrichment_status}`; job `{evt:'enrich', …}`; token vào `api_usage_counters` ngay sau mỗi lần gọi Haiku | Đạt | `lookupService.ts` `logLookup`; `enrichmentWorker.ts`; `enrichment/usage.ts` | e2e kiểm tra đủ trường và dòng log không chứa nội dung trả về; `tests/queue/enrichmentWorker.test.ts` |
| 12.2 | Bộ đếm: số lần tra theo source và outcome, tỉ lệ partial, breaker, ký tự Google trong tháng, job theo trạng thái, token | Đạt, đã vá | **mới** `services/lookup/metrics.ts` (`LookupMetrics`), `services/lookup/health.ts` (`LookupHealthService.getSnapshot()`) | **Thiếu**: chỉ có bộ đếm của lớp hàng đợi. Nay thêm bộ đếm tra từ (theo source × outcome, tỉ lệ partial, p50 / p95 / max của 500 lần gần nhất; bộ nhớ có giới hạn) và ảnh chụp sức khỏe (mạch ngắt từng nhà cung cấp kể cả đường nhanh, ký tự Google và trần, token Anthropic của tháng, job hôm nay và trần, job theo trạng thái, độ sâu hàng đợi pg-boss, 20 lỗi job gần nhất không có dữ liệu người dùng, các bộ đếm). `tests/health/*` (25 test, một phần trên DB thật). `npm run health:snapshot`. Chưa mở qua HTTP (P8) |
| 12.3 | Làm sạch đầu vào; test chuỗi có khoảng trắng, số, ký tự điều khiển, quá dài, Unicode lạ | Đạt, đã vá | `normalizeWord` | Test cũ `normalizeWord.test.ts` + mới `wordFuzz.test.ts`: 300 chuỗi ngẫu nhiên có hạt giống cố định, 2.000 chuỗi so với bản cũ, 48 chuỗi nguy hiểm (`../`, `%00`, NUL, Unicode đảo chiều, vô hình, toàn chiều rộng, mẫu SQL, `__proto__`…), 9 chuỗi triệu ký tự trong < 1 s, và 150 + 48 request qua HTTP: luôn 400 hoặc từ đã chuẩn hóa, **không bao giờ 500**, và chỉ từ an toàn tới nguồn ngoài. **Lỗi bậc hai** đã vá (mục 4.1) |
| 12.4 | Nội dung nguồn và từ người dùng là dữ liệu: bọc trong `<data>`, system prompt dặn không làm theo, đầu ra qua schema + zod | Đạt, đã vá | `services/enrichment/haiku/user-message.ts` `escapeForDataBlock`; `haikuFastTranslator.ts`; `draft.ts` | Bản cũ chỉ chặn `<data` và `</data`; nay còn `< /data>`, `<//data>`, xuống dòng, ký tự độ rộng 0, BOM giữa `<` và `data` (một lớp ký tự, tuyến tính). `tests/security/promptInjection.test.ts` (49): 16 cách viết thẻ, mọi trường nguồn (Wiktionary, Free Dictionary, Datamuse) chứa lệnh và thẻ → vẫn đúng một khối `<data>`; trả lời "tuân lệnh" (văn bản, JSON lạ, đoạn markdown, lemma khác, nghĩa dài) → bị từ chối sau đúng một lần sửa; system prompt không đổi theo từ |
| 12.5 | Không ghi khóa API vào log, lỗi, response; khi in thì che, chỉ 4 ký tự cuối | Đạt, đã vá | **mới** `utils/redact.ts` (`redactSecrets`, `maskKey`); áp ở `UpstreamError`, `queue/log.ts` (`logEvent`, `errMessage`), log tra từ, log mạch / Datamuse | Lớp thứ nhất đã tốt: Google nhận khóa qua header `X-Goog-Api-Key`, lỗi mạng được viết lại không chép thông báo gốc. **Thêm lớp thứ hai** (nhà cung cấp lặp lại khóa trong thông báo lỗi, URL chứa `key=`, `x-api-key`, `sk-ant-…`, `AIza…`, mật khẩu trong chuỗi kết nối). `tests/security/keySecrecy.test.ts` (27): lỗi mạng chứa URL có khóa, Google trả 400 lặp khóa, SDK Anthropic lặp khóa → mọi dòng console, mọi phản hồi (trạng thái, header, thân), mọi hàng của `word_lookups`, `word_enrichment_jobs`, `api_usage_counters`, `entry_edit_history`, `user_reading_progress`, `admin_note` đều sạch; máy chủ giả xác nhận khóa **chỉ** đi qua header. Còn hai chỗ **ngoài tra từ** đặt khóa trong URL: mục 5 |
| 12.6 | Phân quyền admin | Ngoài P7 | | P8 |
| 13.1 | Unit test: sanitizer, ma trận gộp (có ca lỗi cũ), tách `từ: định nghĩa`, single-flight, breaker, token bucket, parser FD, client Google, hợp đồng Haiku, validator, bộ gom nghĩa, ghi DB idempotent | Đạt | | `normalizeWord.test.ts` + `wordFuzz.test.ts`; `merge.test.ts`, `lookupService.test.ts`; `senseSelection.test.ts`; `lookupService.test.ts` (F7) + loadtest B; `circuitBreaker.test.ts`; `tokenBucket.test.ts`; `freeDictionaryClient.test.ts` (fixture thật); `googleTranslateClient.test.ts`; `anthropicEnrichClient.test.ts`, `draft.test.ts`, `prompt.test.ts`, `haikuFastTranslator.test.ts`; `validators.test.ts`; `assemble.test.ts` (vòng tròn `meaning_vi`); `persist.integration.test.ts` |
| 13.2 | Integration trên Postgres thật: migration chạy 2 lần không lỗi; job 2 lần → 1 mục từ; 10 job cùng từ → 1 mục từ; dạng biến chỉ thêm `word_forms` | Đạt, đã vá | | **Thiếu** test migration. Nay `tests/migrations/foundation.integration.test.ts`: migration 33 chạy hai lần liền trong giao dịch rồi ROLLBACK (đối tượng tạo ra không đổi), `createRefTables` hai lần, và `npm run db:migrate` hai lần như tiến trình thật (mọi migration bị bỏ qua, không lỗi). Ba ý còn lại đã có: `persist.integration.test.ts` ("the same job again", "10 parallel jobs", "ran and running") |
| 13.3 | Không test nào phụ thuộc mạng thật hoặc khóa API | Đạt, đã vá | `tests/helpers/lookupApp.ts` | **Lệch**: `ebooks.test.ts` ("TRANSLATION_FALLBACK_ENABLED off") đặt `process.env` trong test, nhưng cấu hình đã đóng băng lúc khởi động nên cờ **vẫn bật** và test gọi Google / Free Dictionary **thật** bằng khóa trong `.env` (kết quả `503`, mục 6). Đã sửa. Mọi test mới dùng máy chủ giả + khóa giả + **lá chắn mạng** (`fetch` toàn cục từ chối mọi máy chủ không phải loopback; có test) |
| 13.4 | Typecheck, lint, test xanh; không TODO ẩn; docs cập nhật; báo cáo | Đạt | | Dự án chưa có ESLint. `grep TODO` chỉ còn `TODO(datamuse-key)` đã ghi công khai ở `docs/lookup-api-notes.md` mục 3. Báo cáo cuối của prompt |

## 3b. Các mục khác đã đọc lại (hàng đợi, làm giàu)

| Mục | Trạng thái | Ghi chú |
|---|---|---|
| §7 hàng đợi `exclusive`, `singletonKey`, DLQ tạo trước, retry với backoff, dữ liệu job nhỏ | Đạt | `services/queue/boss.ts`, `pgBossEnqueuer.ts`; `docs/lookup-queue.md`; `queue.integration.test.ts` |
| §8 S0 đến S7, §9, §10 | Đạt | S0 và `findExistingEntry` đã sửa cùng hình dạng truy vấn như F4 (cùng lỗi không dùng chỉ mục); `pipeline*.test.ts`, `persist.integration.test.ts` |
| Chỗ gắn cuối của P5 (`reconcileStaleJobs` "chưa gắn lịch") | Đạt, đã vá | Nay chạy mỗi 10 phút, một nơi một lúc (`docs/lookup-runbook.md` mục 5) |

## 4. Lỗi thật tìm thấy khi kiểm toán và chạy (đã vá, có test)

| # | Mức | Phát hiện | Cách vá | Test |
|---|---|---|---|---|
| 1 | **Cao** | **Bộ làm sạch từ bậc hai** (`normalizeWord`, `STRIP_RE`): chuỗi `"a" + 100.000 khoảng trắng + "a"` chặn máy chủ **~9 giây**; thân JSON tối đa 1 MB (≈ 900.000 ký tự) ⇒ **hàng chục phút** chiếm vòng lặp sự kiện của cả API chỉ bằng **một request có xác thực** | `stripEdges` tuyến tính, hành vi giống hệt | `wordFuzz.test.ts` (triệu ký tự < 1 s; 900.000 khoảng trắng qua HTTP < 5 s) |
| 2 | **Cao** | **Kết nối bị DB cắt khi client đang được dùng làm sập tiến trình.** pg-pool gỡ listener lỗi của nó khỏi client trong lúc client được `pool.connect()` giao ra; code dùng `connect()` (ghi mục từ, enqueuer, mô hình dữ liệu…) không có listener nào. Neon cắt kết nối giữa một giao dịch ⇒ sự kiện `error` không ai nghe ⇒ ngoại lệ không bắt được. Khi chưa có `pool.on('error')` ở `config/db.ts` thì cả kết nối rảnh cũng vậy (đã ghi từ P5, `docs/lookup-queue.md` mục 12.5) | `config/poolErrors.ts` (`attachPoolErrorHandlers`: `pool.on('error')` + `client.on('error')` trên sự kiện `connect`), dùng cho pool chính và pool `REFDATA_DATABASE_URL`; log `pg_pool_error` / `pg_client_error` | `tests/db/poolError.test.ts` (giết kết nối thật; **không có bản vá thì test lỗi với "Unhandled error"**), `tests/chaos/db.chaos.test.ts` |
| 3 | Trung bình | F4 và S0 viết `OR` ba điều kiện nên không dùng được `lower(headword)` / `lower(lemma)`: đọc toàn bảng mỗi lần tra (42 đến 56 ms ở 200.000 mục từ) | `UNION` ba tra cứu chỉ mục | `localLookup.test.ts`, EXPLAIN ở `docs/lookup-loadtest.md` mục 3 |
| 4 | Trung bình | Lỗi cấu hình 400/401/403 ở đường tra nhanh chỉ hiện ở dòng info, không có log mức error (spec §11.3) | `reportConfigProblems` | e2e, `keySecrecy` |
| 5 | Trung bình | Worker không chờ `Retry-After` (spec §11.4) | `retryAfterWaitMs` | `enrichmentWorkerRetryAfter.test.ts`, chaos |
| 6 | Trung bình | Không có bộ đếm tra từ / ảnh chụp sức khỏe (spec §12.2) | `LookupMetrics`, `LookupHealthService` | `tests/health/*` |
| 7 | Thấp | `escapeForDataBlock` chỉ chặn hai cách viết thẻ | biến thể có khoảng trắng, `/`, ký tự độ rộng 0 | `promptInjection.test.ts` |
| 8 | Thấp | Chưa có lớp che khóa thứ hai (spec §12.5) | `utils/redact.ts` | `keySecrecy.test.ts` |
| 9 | Thấp | Test cũ gọi dịch vụ thật (mục 6) | sửa fixture | |
| 10 | Thấp | Bộ dọn hàng treo chưa được gắn lịch (P5 để lại) | lịch pg-boss 10 phút + khóa tư vấn | `reconcileSchedule*.test.ts`, `schedule.chaos.test.ts` |

## 5. Việc cần bạn quyết, và rủi ro còn lại

1. **Quá tải DB làm cả hàng đợi 503 cùng lúc.** Đường tra không có giới hạn đồng thời; DB chậm hoặc ở xa thì request xếp hàng chờ kết nối (đo được đỉnh ~400 request chờ) và khi tới bước gọi nguồn ngoài thì hạn chót 3 s đã hết. Đề xuất: (a) đặt ứng dụng cùng vùng với Neon, (b) một bộ giới hạn đồng thời cho lần tra (vượt thì 503 ngay), (c) cho phép chỉnh kích thước pool (hiện cố định mặc định 10, không có biến môi trường; thêm biến là ngoài phạm vi prompt này). Số đo: `docs/lookup-loadtest.md`.
2. **`requireApiAuth` biến mọi lỗi DB thành `401 INVALID_TOKEN`** (`middlewares/apiAuth.ts`, khối `catch`). Khi DB rớt, ứng dụng di động thấy "token không hợp lệ" (đã gặp 401 trong lúc đo tải). Nên trả 503 cho lỗi không phải JWT. Đổi hành vi của mọi endpoint nên không tự sửa.
3. **Khóa Google nằm trong URL ở hai chỗ ngoài tra từ**: `services/translationService.ts` (dịch đoạn văn) và `services/ttsService.ts` (TTS). Thông báo lỗi của chúng không chép URL nên chưa lộ, nhưng nên chuyển sang header `X-Goog-Api-Key` như client mới. Ngoài ra `services/wordTranslationService.ts` còn mã **chết** (`callGoogleTranslate`, `translateWord`, bảng `word_translation_cache`) mà không route nào gọi nữa, cũng đặt khóa trong URL: khuyến nghị xóa (giữ `normalizeWord` và `stripEdges`), nhưng spec §3 đã dặn giữ bảng để quay lui.
4. **Giới hạn tốc độ TTS** (`routes/api/dictionary.ts:317`): `express-rate-limit` báo `ERR_ERL_KEY_GEN_IPV6` (keyGenerator dùng IP mà không qua `ipKeyGenerator`) nên người dùng IPv6 có thể đổi địa chỉ để né giới hạn. Ngoài tra từ.
5. **`npm audit --omit=dev`: 20 lỗ hổng** (1 thấp, 5 trung bình, 12 cao, 2 nghiêm trọng). **Thư viện mới của tính năng này sạch**: `pg-boss` 12.37.1 và ba phụ thuộc của nó (`cron-parser`, `rrule-temporal`, `serialize-error`) không có phát hiện nào; `zod` không có. Hai mục nghiêm trọng: `proxy-addr` ≤ 2.0.7 (qua `express`; giả mạo IP khi `trust proxy` và mạng con IPv4-mapped IPv6; dự án đặt `app.set('trust proxy', 1)` và dựa vào IP cho giới hạn tốc độ) và `sanitize-html` ≤ 2.17.6 (qua `sbd`). Mức cao có `multer`, `epub2` (qua `adm-zip`, chưa có bản vá), `lodash`, `protobufjs`, `@grpc/grpc-js`, `source-map-js`, `nanoid`, `brace-expansion`, `postcss`; `@anthropic-ai/sdk` 0.80.0 có một phát hiện mức vừa về công cụ Memory (dự án không dùng; sửa cần nâng lên 0.134, bản chính). Không chạy `npm audit fix` vì sẽ đổi phiên bản phụ thuộc ngoài phạm vi; phần lớn có bản vá (`fix available`).
6. **Trạng thái trong bộ nhớ từng tiến trình**: giới hạn F6, bucket Free Dictionary, mạch ngắt, bộ đếm tra từ. Nhiều bản sao ứng dụng thì giới hạn nhân lên và mạch không đồng bộ. Chấp nhận được với một bản sao; cần Redis hoặc bảng dùng chung nếu mở rộng.
7. **Chưa kiểm chứng với dịch vụ thật** (giữ nguyên từ `docs/lookup-api-notes.md`): thân và header thật của 429 / 403 hết quota của Google, 429 của Free Dictionary, thân JSON thật của 404 "không có từ", hình dạng thật của lỗi `enforced_spend_limit_reached`. P7 không gọi dịch vụ thật nên các ca này chạy trên giả lập theo tài liệu.
8. **Số đo tải phụ thuộc môi trường** (DB từ xa). Nên chạy lại `npm run loadtest:lookup` sau khi triển khai ở cùng vùng với DB.
9. **Đếm `daily_cap`** (11.7): xem dòng 11.7, chấp nhận lệch.

## 6. Phân loại 34 test cũ đang thất bại

Chạy riêng 4 bộ: `ebooks`, `leitner`, `retrieval`, `word-translation` (34 ca thất bại / 86). **Cả 34 là fixture lỗi thời, không có hồi quy thật của ứng dụng.** Đã sửa fixture, **không đổi hành vi ứng dụng**; sau khi sửa cả bốn bộ xanh (87/87: thêm một ca Leitner).

| Bộ | Ca | Nguyên nhân | Phân loại | Cách sửa |
|---|---|---|---|---|
| `retrieval` | 26 (cả bộ) | `beforeAll` chèn `user_subscriptions` thiếu `price_paid`, cột `NOT NULL` từ migration 05 | fixture lỗi thời | thêm `price_paid = 0`. 26 ca (cả `calcXp` thuần túy) pass ngay, nên không có hồi quy ẩn |
| `leitner` | 1 (`box/1 returns all 5 cards`) | Từ khi viết lại Leitner, trả lời đúng trong luyện tập **đẩy thẻ đã có sang hộp kế**, nên sau phiên thứ hai chỉ 2 thẻ mới ở hộp 1, 3 thẻ cũ ở hộp 2 (test cũ coi cả 5 ở hộp 1). Đúng với `routes/api/practice.ts` (chú thích dòng 437) | fixture lỗi thời | mong đợi lấy từ DB: số thẻ ở hộp 1 + hộp 2 = 5 (không mất, không trùng) và `total` bằng số thẻ hộp 1 |
| `leitner` | 2 (`box 4 → 5`, `box 5 → 1`) | `POST /leitner/review` từ chối hộp 4/5 với `409 REVIEW_SESSION_REQUIRED` (kiểm tra cả hai nghĩa trong phiên ôn tập), đã ghi ở `CLAUDE.md` | fixture lỗi thời | thay bằng `it.each([4, 5])` xác nhận 409 và thẻ không đổi hộp, và thêm ca `sai từ hộp 3 → hộp 1` |
| `ebooks` | 1 (`404 … TRANSLATION_FALLBACK_ENABLED off`) | Test đặt `process.env` lúc chạy, nhưng cấu hình tra từ **đóng băng khi khởi động**; cờ vẫn bật, đường tra gọi Google / Free Dictionary **thật** bằng khóa trong `.env` và nhận `503` thay vì `404` | fixture lỗi thời (và vi phạm §0.5: gọi mạng thật) | khởi động ứng dụng với cờ tắt qua `bootLookupApp` + máy chủ giả; xác nhận 0 request ra ngoài |
| `word-translation` | 4 | (a) `cache miss`: stub Free Dictionary thiếu trường `word` (API thật luôn có) nên bị coi là không có, và stub Google trả 1 phần tử cho 2 văn bản; (b) `cache hit` và (c) `punctuation … hits translation cache` khẳng định đúng **điều spec cấm** (đọc `word_translation_cache`, `cached: true`); (d) `404 … fallback off` giống `ebooks` | fixture lỗi thời | (a) stub có `word` và Google trả đủ phần tử; (b) và (c) viết lại theo hợp đồng mới: **không cache**, lần hai hỏi lại nguồn, không ghi `word_translation_cache`, dấu câu bị cắt trước khi hỏi nguồn; (d) như `ebooks` |

Test mới thay cho các ca đã bỏ: xem `tests/e2e/lookup.e2e.test.ts`.

## 7. Test thêm trong P7

| Nhóm | Tệp | Số ca |
|---|---|---|
| Đầu cuối qua HTTP | `tests/e2e/lookup.e2e.test.ts`, `tests/e2e/mockServer.test.ts` | 30 + 16 |
| Chịu lỗi (`npm run test:chaos`) | `tests/chaos/upstream`, `anthropic`, `db`, `process`, `schedule` | 14 + 8 + 3 + 3 + 1 |
| Bảo mật | `tests/security/promptInjection`, `keySecrecy`, `wordFuzz`, `sqlParameterization` | 49 + 27 + 74 + 4 |
| Quan sát | `tests/health/lookupMetrics`, `lookupHealth` | 11 + 14 |
| Hàng đợi | `tests/queue/enrichmentWorkerRetryAfter`, `reconcileSchedule`, `reconcileSchedule.integration`, `redrive`, `redrive.integration` | 6 + 10 + 7 + 11 + 5 |
| Hạ tầng | `tests/db/poolError`, `tests/migrations/foundation.integration` | 6 + 4 |
| Sửa / bổ sung test cũ | `localLookup`, `boss`, `runtime`, `leitner`, `retrieval`, `ebooks`, `word-translation` | xem mục 6 |

Công cụ mới: `scripts/mock-upstream/server.ts`, `scripts/loadtest/{lookup-burst,app-runner,explain-lookup}.ts`, `scripts/enrichment/redrive.ts`, `scripts/health-snapshot.ts`. Tài liệu: `docs/lookup-{audit,chaos,loadtest,runbook}.md`.

Kết quả chạy cuối: xem báo cáo cuối của prompt (typecheck, toàn bộ test, `test:chaos`, tải).
