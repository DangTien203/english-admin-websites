# WordyGo · Hàng đợi làm giàu từ điển (P5)

Cập nhật: 14/10/2026 · Phiên bản pg-boss đối chiếu: **12.37.1** (đúng bản trong `node_modules`) · Đặc tả gốc: `docs/lookup-spec.md` §7, §8, §11, §12.

P5 làm **hạ tầng**: hàng đợi, sổ job `word_enrichment_jobs`, worker, thử lại, dừng gọn. Từ P6b, `services/enrichment/pipeline.ts` là đường ống thật (S0 đến S7, xem `docs/lookup-enrichment.md` mục 10); chỗ gắn rỗng luôn trả `skipped / pipeline_not_ready` của P5 không còn. Các mô tả bên dưới về hợp đồng worker ⇄ pipeline vẫn đúng.

---

## 1. Đối chiếu API pg-boss 12.37.1 với đặc tả

Nguồn đối chiếu: tệp kiểu `node_modules/pg-boss/dist/types.d.ts` và `index.d.ts`, mã `plans.js` / `manager.js` / `index.js`, README, và pgboss.io (`api/constructor`, `api/queues`, `api/jobs`, `api/workers`). Mọi mục "Thật" dưới đây đã được chạy thử trên Postgres thật (xem `tests/queue/queue.integration.test.ts`).

### 1.1 Chữ ký

| Thành phần | Chữ ký thật | Ghi chú |
|---|---|---|
| Khởi tạo | `new PgBoss(connectionString)` hoặc `new PgBoss(options: ConstructorOptions)` | Gói **ESM** (`"type": "module"`), cần Node ≥ 22.12. Từ mã CommonJS dùng được `require` / `import()` (Node 22.12+ hỗ trợ `require` ES module). Jest (CommonJS) không nạp nổi, xem §9 |
| `start` | `start(options?: { attempts?: number }): Promise<this>` | `attempts`: số lần thử khi lỗi, chờ 1 s nhân đôi tới 30 s. Cài schema và migration nếu `migrate: true` (mặc định) |
| `stop` | `stop(options?: { close?: boolean; graceful?: boolean; timeout?: number }): Promise<void>` | Mặc định `close: true`, `graceful: true`, `timeout: 30000` (tối thiểu 1000 ms, nhỏ hơn bị nâng lên) |
| Sự kiện lỗi | `boss.on('error', (err: Error) => …)` | Không có listener thì `error` làm sập tiến trình. Còn có `warning`, `wip`, `stopped`, `bam`, `flow` |
| `createQueue` | `createQueue(name: string, options?: Omit<Queue, 'name'>): Promise<void>` | **Idempotent** (`ON CONFLICT DO NOTHING`) nhưng **không cập nhật** option của queue đã có. Nếu `deadLetter` chưa tồn tại thì ném `Queue <tên> does not exist` |
| `updateQueue` | `updateQueue(name, options): Promise<void>` | Không đổi được `policy`, `partition`. `deadLetter: null` để gỡ DLQ |
| `getQueue` | `getQueue(name): Promise<QueueResult \| null>` | Trả `policy`, `deadLetter`, `retryLimit`, `retryDelay`, `retryBackoff`, `expireInSeconds`, cùng số đếm |
| `send` | `send(name, data?, options?: SendOptions): Promise<string \| null>` (có thêm dạng `send({ name, data, options })`) | Trả **id job**, hoặc **`null`** khi chính sách queue / throttle chặn (không ném lỗi) |
| `work` | `work(name, handler)` hoặc `work(name, options, handler): Promise<string>` | Trả **id worker**. Mỗi lần gọi thêm worker mới |
| `offWork` | `offWork(name, options?: { id?: string; wait?: boolean }): Promise<void>` | `wait` mặc định `true`; không có `id` thì dừng mọi worker của queue |
| Đọc job theo id | `findJobs(name, { id?, key?, data?, queued? }): Promise<JobWithMetadata[]>` | `getJobById(name, id)` còn tồn tại nhưng **đã deprecated**. `key` = `singletonKey`; `data` so khớp bao hàm JSON; `queued: true` chỉ lấy `created` / `retry` (KHÔNG gồm `active`) |

### 1.2 Tùy chọn hàng đợi, job và worker

| Nội dung (tên trong đặc tả / prompt) | Tên thật trong pg-boss | Mặc định thật | Ghi chú |
|---|---|---|---|
| policy `exclusive` | `policy: 'exclusive'` | `standard` | **Có thật.** Giá trị hợp lệ: `standard`, `short`, `singleton`, `stately`, `exclusive`, `key_strict_fifo`. `exclusive` = tối đa 1 job ở trạng thái `created` / `retry` / `active` cho mỗi `singletonKey` (chỉ mục duy nhất `job_i6`). Job đã `completed` / `failed` không chặn lần gửi sau |
| hàng lỗi chết | `deadLetter: '<tên queue>'` (cấp queue; job cũng nhận được) | không | Khi job hết lần thử, pg-boss chép job (nguyên `data`, `singletonKey`) vào DLQ **trong cùng câu lệnh** làm job `failed`. DLQ nhận retry / expiry **của DLQ**, không thừa kế của queue gốc |
| retryLimit | `retryLimit` | 2 | **Số lần thử LẠI, không phải số lần chạy.** `retryLimit: 3` = tối đa 4 lần chạy |
| retryDelay | `retryDelay` (giây) | 0 | |
| retryBackoff | `retryBackoff` | `false` | Chờ khoảng `retryDelay × 2^retryCount` (có nhiễu); `retryDelay = 0` thì bắt đầu từ 1 giây. Giới hạn trên: `retryDelayMax` (giây) |
| thời hạn chạy tối đa của job | **`expireInSeconds`** | 900 (hợp lệ 1 đến 86400) | Hết hạn thì job bị coi như lỗi (thử lại hoặc `failed`). Việc phát hiện do **bảo trì** (`supervise`) và do chính handler (`handler execution exceeded Ns`) |
| thời gian lưu job đã xong | **`deleteAfterSeconds`** | 604800 (7 ngày; `0` = giữ mãi) | Còn `retentionSeconds` (mặc định 14 ngày): job `created` / `retry` quá hạn sẽ bị xóa |
| singletonKey | `singletonKey` (tùy chọn của `send`) | không | Trong queue `exclusive` đây là khóa "một job mỗi từ" |
| startAfter | `startAfter` | 0 | `number` = **giây**; `string` = ISO 8601 hoặc interval Postgres (`'5 minutes'`); hoặc `Date` |
| localConcurrency | `localConcurrency` (tùy chọn của `work`) | 1 | Số worker song song trong **một tiến trình** |
| batchSize | `batchSize` | 1 | |
| pollingIntervalSeconds | `pollingIntervalSeconds` | 2 (tối thiểu 0.5) | |
| includeMetadata | `includeMetadata` | `false` | Bắt buộc để thấy `retryLimit` (job thường chỉ có `retryCount`) |
| Handler nhận mảng hay một job | **Luôn một MẢNG** `Job[]`, kể cả `batchSize: 1` | | `([job]) => …`. Handler ném lỗi thì pg-boss tự gọi `fail()`; handler trả về thì `complete()` (giá trị trả về lưu vào `output` khi `batchSize` là 1) |
| Truyền transaction vào `send` | **Có**: `send(name, data, { db })` với `db` là đối tượng có `executeSql(text, values)` | | pg-boss chạy câu INSERT job trên đúng kết nối đó. Cũng có `fromKnex`, `fromKysely`, `fromDrizzle`, `fromPrisma` cho ORM. Dự án này bọc `PoolClient.query` (§3) |
| Tắt bảo trì và lịch cho tiến trình chỉ gửi job | **Có**: `supervise: false`, `schedule: false` (tùy chọn constructor) | `true`, `true` | `supervise: false` bỏ bảo trì / giám sát (hết hạn, xóa job cũ, thống kê). Phải còn **ít nhất một tiến trình** có `supervise: true` (tiến trình worker) thì job `active` bị treo mới được xử lý |
| Kích thước pool riêng | `max` (tùy chọn constructor) | 10 | Dùng cho `PGBOSS_POOL_MAX`. Schema: `schema` (mặc định `pgboss`, tối đa 50 byte) |
| Hủy job giữa chừng | `job.signal: AbortSignal` | | Bị hủy khi: quá `expireInSeconds`, pg-boss đang dừng, hoặc mất quyền giữ job |

### 1.3 Chỗ khác với `docs/lookup-spec.md` §7 và §11.8

| # | Đặc tả / prompt nói | Thư viện thật | Cách xử lý |
|---|---|---|---|
| 1 | Chỉ nêu "createQueue" | `createQueue` bỏ qua option nếu queue đã tồn tại, nên đổi `ENRICHMENT_JOB_RETRY_LIMIT` rồi khởi động lại **không có tác dụng** | `ensureQueues` so sánh với `getQueue` và gọi `updateQueue` khi lệch. Job đã gửi trước đó giữ giá trị cũ (job chép cấu hình lúc gửi) |
| 2 | `retryLimit = ENRICHMENT_JOB_RETRY_LIMIT` | Là số lần thử lại | `retryLimit = 3` cho tối đa 4 lần chạy. Lần cuối: `retryCount === retryLimit` (đọc từ metadata) |
| 3 | "thời hạn chạy tối đa" | Tên là `expireInSeconds`, tối đa 86400 | Tính bằng `computeJobExpireSeconds`: không dưới 300 s và luôn lớn hơn 2 × `ANTHROPIC_TIMEOUT_MS_ENRICH` + 60 s (P6 có thể gọi Haiku hai lần) |
| 4 | §11.8: "offWork với wait" | Dừng gọn đầy đủ là `stop({ graceful, timeout })`; nó gọi `offWork(wait:false)` cho mọi queue, chờ handler tới `timeout`, rồi **fail** job còn chạy (job về `retry`) và hủy `signal` | Dùng `stop({ graceful: true, close: true, timeout: 30000 })`, sau đó đặt các hàng còn `running` về `queued` (§6) |
| 5 | Gửi: "ghi hàng, rồi `boss.send`" | `send` nhận được transaction | Cả đặt chỗ trần ngày, ghi hàng và gửi job nằm trong **một transaction** (§3): lỗi hay đụng độ thì rollback, không phải hoàn lại gì |
| 6 | Không nói gì về đọc job | `getJobById` deprecated | Dùng `findJobs` |
| 7 | Không nói gì về bảo trì | Bảo trì mặc định chạy ở mọi instance | Tiến trình chỉ gửi job: `supervise: false`. Cron (`schedule`) tắt ở mọi vai trò cho tới P7 |
| 8 | Dữ liệu job `{ word, requestedBy, ebookId }` | | Thêm `jobRowId` (id hàng sổ) để worker và hàng lỗi chết tìm đúng hàng. Vẫn không có email, tên, đoạn văn |

---

## 2. Thành phần và tệp

| Tệp | Vai trò |
|---|---|
| `services/queue/constants.ts` | Tên queue, hằng số (sàn 300 s, ân hạn dừng 30 s, ngưỡng stale 30 phút), `EnrichJobData`, `computeJobExpireSeconds` |
| `services/queue/boss.ts` | Tạo / khởi động **một lần** PgBoss, `ensureQueues`, `getBoss(role)`, `stopBoss()`. Vai trò `worker` (có bảo trì) hoặc `sender` (không) |
| `services/queue/pgBossEnqueuer.ts` | `PgBossEnrichmentEnqueuer` (§3) |
| `services/queue/enrichmentWorker.ts` | Handler của queue chính và của DLQ, `registerEnrichmentWorkers` (§4, §5) |
| `services/queue/runtime.ts` | `startEnrichmentRuntime('api' \| 'worker')`, dừng gọn |
| `services/queue/shutdown.ts` | Bắt SIGTERM / SIGINT, chạy các bước dừng theo thứ tự |
| `services/queue/reconcile.ts` | `reconcileStaleJobs()` (§7) |
| `services/queue/log.ts` | Log JSON một dòng và bộ đếm trong tiến trình |
| `services/enrichment/pipeline.ts` | `runEnrichment` (đường ống thật từ P6b) và hợp đồng với worker; `EnrichmentOutcome` có thêm `stagesMs` |
| `models/EnrichmentJob.ts` | Truy vấn `word_enrichment_jobs` |
| `worker.ts` | Tiến trình worker riêng (`npm run worker`) |
| `scripts/enrichment/enqueue.ts`, `status.ts` | Công cụ dòng lệnh (§8) |

Không thêm biến môi trường. Dùng sẵn: `ENRICHMENT_ENABLED`, `ENRICHMENT_WORKER_ENABLED`, `ENRICHMENT_WORKER_CONCURRENCY`, `ENRICHMENT_JOB_RETRY_LIMIT`, `ENRICHMENT_JOB_RETRY_DELAY_SECONDS`, `ENRICHMENT_MAX_JOBS_PER_DAY`, `PGBOSS_SCHEMA`, `PGBOSS_POOL_MAX`, `ANTHROPIC_TIMEOUT_MS_ENRICH`.

Kết nối của pg-boss lấy từ `pool.options` của `config/db.ts` (cùng chuỗi kết nối và SSL), nhưng pg-boss có **pool riêng** `PGBOSS_POOL_MAX` kết nối (mặc định 5).

---

## 3. Gửi job (enqueue)

Khi `ENRICHMENT_ENABLED=true`, `services/lookup/index.ts` dùng `PgBossEnrichmentEnqueuer`; khi `false` vẫn dùng `NoopEnqueuer` (trả `disabled`). Đường nhanh gọi trong `try/catch` (F11): lỗi hàng đợi không làm hỏng response.

```
enqueue({ word, requestedBy, ebookId, startAfterSeconds? })
 a) làm sạch từ (normalizeWord của đường nhanh)           → skipped / invalid_word
 b) đã có hàng queued|running cho từ                      → already_queued   (không tốn trần ngày)
 c) đã có entry (headword, lemma, word_forms; kể cả published=false) → skipped / exists
    ── lấy PgBoss; mở transaction ──
 d) đặt chỗ trần ngày (enrichment / jobs / YYYY-MM-DD UTC)  → skipped / daily_cap (rollback, log warn, tăng bộ đếm)
 e) INSERT hàng queued ... ON CONFLICT (word) WHERE status IN ('queued','running') DO NOTHING
                                                          → đụng độ: rollback, already_queued
 f) boss.send('dictionary.enrich_word', { word, requestedBy, ebookId, jobRowId },
              { singletonKey: word, startAfter?, db: <transaction> })
      trả null → hàng đổi thành skipped / duplicate, hoàn trần ngày, COMMIT, already_queued
      ném lỗi  → rollback, hàng audit failed / queue_error, ném lỗi lên
    ── COMMIT → queued ──
```

Vì d, e, f cùng một transaction: không có chuyện "đã trừ trần ngày nhưng chưa có job", kể cả khi tiến trình chết giữa chừng. Các bước a, b, c chạy ngoài transaction để không giữ khóa dòng bộ đếm khi không cần.

Ghi chú:
- Bước d nằm trong transaction nên các lần gửi **song song** nối đuôi nhau trên một dòng `api_usage_counters` (vài mili giây mỗi lần; đường nhanh đã giới hạn tần suất theo người dùng).
- Khi gửi lỗi, dòng audit `failed / queue_error` được ghi **sau khi đã trả kết nối** (không giữ hai kết nối cùng lúc).
- `getBoss()` được gọi trước khi mở transaction: pg-boss không dậy được thì chưa tốn trần ngày và chưa mượn kết nối.

---

## 4. Worker

Đăng ký: `boss.work('dictionary.enrich_word', { localConcurrency: ENRICHMENT_WORKER_CONCURRENCY, batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 5 }, handler)`.

Thăm dò mỗi 5 giây (hằng `DEFAULT_POLLING_SECONDS`) thay vì 2 giây mặc định để database serverless (Neon) có thể ngủ giữa các job. Việc làm giàu không cần nhanh hơn.

Handler cho mỗi job:

1. Nạp hàng theo `jobRowId`. Không có: tạo lại **cùng id**, trạng thái `queued`. Nếu từ đó đã có hàng hoạt động khác (đụng chỉ mục duy nhất): kết thúc job, không làm gì.
2. `status = running`, `attempts + 1`, xóa `reason`.
3. Gọi `runEnrichment({ word, requestedBy, ebookId, jobRowId, attempt, signal })`.
4. **Có kết quả** (`succeeded` / `rejected` / `skipped` / `failed`): ghi `status`, `reason`, `entry_id`, `model`, `input_tokens`, `output_tokens`, `finished_at`; hoàn tất job; **không thử lại**.
5. **Ném lỗi:**

| Lỗi | Hàng | Job pg-boss |
|---|---|---|
| `UpstreamUnavailable` hoặc lỗi lạ, chưa phải lần cuối | `queued`, `reason = upstream_error`, giữ `attempts` | ném lỗi lại → pg-boss thử lại theo backoff |
| như trên, **lần cuối** (`retryCount >= retryLimit`, đọc từ metadata) | `failed`, `upstream_error`, `finished_at` (ghi **trước** khi ném) | ném lỗi → job `failed` → vào hàng lỗi chết |
| `UpstreamConfigError` | `failed`, `config_error`, log mức error | hoàn tất, không thử lại |
| `BudgetExceeded` | `skipped`, `budget`, log mức error | hoàn tất, không thử lại |
| kết quả sai dạng (lỗi lập trình) | như "lỗi lạ" | như "lỗi lạ" |

6. Nếu `job.signal` đã bị hủy khi pipeline xong (hết ân hạn dừng, hoặc job quá `expireInSeconds`): pg-boss đã tự xử lý lần chạy đó; handler **không ghi kết quả**, chỉ đặt hàng về `queued`.

### Sơ đồ vòng đời của một hàng

```
   enqueue (transaction) ──▶ queued ◀───────────────────────────────────────┐
                               │                                            │
                               │ worker nhận job (attempts + 1)             │ lỗi tạm, còn lượt:
                               ▼                                            │ UpstreamUnavailable / lỗi lạ
                            running ────────────────────────────────────────┤ (reason upstream_error)
                               │  │                                         │
                               │  └─ bị ngắt (dừng tiến trình, quá hạn) ────┘ (reason để trống)
                               │
          ┌────────────────────┼─────────────────────────────────────────┐
          ▼                    ▼                                         ▼
  kết quả trả về        lỗi cấu hình / ngân sách              lần chạy cuối vẫn lỗi tạm
  succeeded             failed  / config_error                failed / upstream_error
  rejected              skipped / budget                      (rồi ném lỗi: job vào hàng lỗi chết)
  skipped, failed       (job hoàn tất, không thử lại)

  Từ bất kỳ queued|running:
    hàng lỗi chết   ──▶ failed / dead_letter
    reconcile (30') ──▶ failed / stale
  Trạng thái cuối (succeeded, rejected, skipped, failed) không chặn lần gửi sau:
  chỉ mục duy nhất chỉ áp cho queued|running.
```

**Quy tắc bất biến:** khi pg-boss đã bỏ một job (hết lần thử, hết hạn, vào hàng lỗi chết) thì hàng tương ứng không còn `queued` / `running`. Ba lớp bảo đảm: handler (lần thử cuối đóng hàng trước khi ném), worker của hàng lỗi chết, và `reconcileStaleJobs` (lưới an toàn).

---

## 5. Hàng lỗi chết

`dictionary.enrich_word.dlq` (tạo **trước** queue chính). Một worker nhẹ (`localConcurrency 1`, thăm dò mỗi 30 giây) với mỗi job: tìm hàng theo `jobRowId`; nếu còn `queued` / `running` thì đặt `failed`, `reason = dead_letter`; luôn log mức error (`evt: enrich_dead_letter`).

Trường hợp thường gặp là hàng đã `failed / upstream_error` (handler đã đóng nó ở lần cuối): worker này chỉ ghi log. Hàng còn hoạt động khi job vào DLQ xảy ra khi: job hết hạn `expireInSeconds` ở lần cuối (tiến trình chết, bảo trì phát hiện), hoặc dừng tiến trình mà job đã hết lần thử.

Xem lại / chạy lại job trong DLQ: `boss.redrive('dictionary.enrich_word.dlq', …)` (P7 hoặc thao tác tay). Lưu ý hàng cũ đã `failed`; `redrive` tạo job mới nhưng handler sẽ tạo / hồi sinh hàng theo `jobRowId` (bước 1 và 2 ở §4).

---

## 6. Vòng đời tiến trình và cách chạy

Ba chế độ, dùng chung mã (`services/queue/runtime.ts`):

| Tiến trình | Điều kiện | Làm gì |
|---|---|---|
| API (`app.ts`) | `ENRICHMENT_ENABLED=false` (mặc định) | **Không động tới pg-boss**, không tạo schema |
| API | `ENRICHMENT_ENABLED=true`, `ENRICHMENT_WORKER_ENABLED=false` | Chỉ gửi job (vai trò `sender`: `supervise: false`) |
| API | `ENRICHMENT_ENABLED=true`, `ENRICHMENT_WORKER_ENABLED=true` | Gửi job và chạy worker cùng API (vai trò `worker`) |
| Worker riêng (`npm run worker`) | `ENRICHMENT_WORKER_ENABLED=true` | Chạy worker, bất kể `ENRICHMENT_ENABLED` (cờ này chỉ chặn việc **gửi** job mới, spec §11.8). `false`: in thông báo, thoát mã 0 |

> `ENRICHMENT_WORKER_ENABLED` mặc định `true`. Để API không tự chạy worker mà dùng dịch vụ worker riêng: đặt `ENRICHMENT_WORKER_ENABLED=false` ở dịch vụ API, `true` ở dịch vụ worker.

```bash
# phát triển
npm run worker

# sản xuất (sau npm run build)
npm run worker:start        # node dist/worker.js
```

Triển khai Railway: tạo một dịch vụ thứ hai từ cùng repo, lệnh khởi động `node dist/worker.js`, cùng biến môi trường (thêm `ENRICHMENT_ENABLED=true` và `ANTHROPIC_API_KEY`). Schema pg-boss được cài ở lần `start()` đầu tiên của bất kỳ tiến trình nào (khóa tư vấn chống chạy song song), nên không cần bước migration riêng.

### Dừng gọn (SIGTERM / SIGINT)

1. API: ngừng nhận kết nối HTTP mới (`server.close()`).
2. `boss.stop({ graceful: true, close: true, timeout: 30000 })`: ngừng nhận job mới, chờ handler đang chạy tối đa **30 giây**. Hết ân hạn: pg-boss đánh lỗi các job còn chạy (job về `retry`, **không mất**) và hủy `signal`.
3. Các hàng của handler còn chạy trong tiến trình này được đặt **về `queued`** (`requeueInFlight`).
4. Đóng pool, thoát. Tín hiệu thứ hai, hoặc quá 45 giây, thoát ngay (mã 1).

Lần chạy bị ngắt vẫn tính vào `retryLimit` (pg-boss tăng `retryCount` khi job được nhận lại).

---

## 7. Dọn dẹp: `reconcileStaleJobs()`

`services/queue/reconcile.ts`. Hàng `queued` / `running` có `updated_at` cũ hơn 30 phút, mà `boss.findJobs(queue, { data: { jobRowId } })` không thấy job nào ở trạng thái `created` / `retry` / `active`, được đặt `failed`, `reason = stale`. Tùy chọn: `olderThanMinutes`, `wordPrefix`.

**P5 chưa gắn lịch.** P7 gọi định kỳ từ tiến trình worker. Chỉ chạy với **đúng schema pg-boss mà job được gửi vào** (`PGBOSS_SCHEMA`): chạy nhầm schema sẽ coi mọi hàng là mồ côi.

---

## 8. Công cụ dòng lệnh

```bash
# gửi một từ qua enqueuer thật (cần ENRICHMENT_ENABLED=true; vai trò sender, không chạy bảo trì)
npm run enrich:enqueue -- --word ubiquitous

# 20 hàng gần nhất và số lượng theo trạng thái
npm run enrich:status -- [--word ubiquitous] [--limit 20]
```

`enrich:enqueue` chỉ **gửi**; cần một worker đang chạy ở đâu đó để xử lý. Từ P6b còn `npm run enrich:run -- --word <w> [--dry-run]` (chạy đường ống trực tiếp, không qua hàng đợi) và `npm run enrich:review` (duyệt mục từ tự tạo); xem `docs/lookup-enrichment.md` mục 14. **Worker từ chối khởi động khi thiếu 30 chủ đề** (`topics_not_seeded`): job nằm yên trong hàng đợi. Công cụ nằm trong `scripts/` (thư mục này đang bị `.gitignore`, như các script khác của dự án).

---

## 9. Bảng mã `reason`

| Mã | `status` | Ghi ở đâu | Do ai | Ý nghĩa |
|---|---|---|---|---|
| `invalid_word` | (không có hàng) | `enrichment.reason` trong response | enqueuer (a) | Từ không qua bộ làm sạch của đường nhanh |
| `exists` | (không có hàng) / `skipped` | response; hàng ở P6 (S0) | enqueuer (c), P6 | Đã có entry |
| `daily_cap` | (không có hàng) | response + log warn + bộ đếm | enqueuer (d) | Hết `ENRICHMENT_MAX_JOBS_PER_DAY` của ngày UTC |
| `duplicate` | `skipped` | hàng audit | enqueuer (f) | `send` trả `null`: pg-boss đã có job cho từ này mà sổ không có hàng hoạt động |
| `queue_error` | `failed` | hàng audit + `enrichment.reason` (P3) | enqueuer | `send` / kết nối pg-boss lỗi |
| `upstream_error` | `queued` (giữa các lần thử) / `failed` (lần cuối) | hàng | worker | `UpstreamUnavailable` hoặc lỗi lạ |
| `config_error` | `failed` | hàng | worker | `UpstreamConfigError` (400/401/403, thiếu khóa) |
| `budget` | `skipped` | hàng | worker | `BudgetExceeded` |
| `dead_letter` | `failed` | hàng | worker hàng lỗi chết | Job vào DLQ khi hàng vẫn còn hoạt động |
| `stale` | `failed` | hàng | `reconcileStaleJobs` | Hàng treo, pg-boss không còn job |
| `pipeline_not_ready` | `skipped` | hàng | pipeline tạm (P5) | **Đã nghỉ hưu từ P6b**: không còn được tạo; có thể còn trong hàng sổ cũ |
| `unknown_word` | `rejected` (P6) / `skipped` (response, P3) | | P6, đường nhanh | Không nguồn nào nhận ra từ (không gọi Haiku). Free Dictionary treo với từ rác thì KHÔNG ra mã này mà ra `upstream_error` sau các lần thử |
| `proper_noun`, `not_english` | `rejected` | hàng | P6 | Haiku phán đoán |
| `variant_form`, `lemma_mismatch` | `skipped` | hàng | P6 | Lỗi chính tả / dạng lỗi thời; lemma bản nháp khác từ tra |
| `form_linked` | `succeeded` | hàng | P6 | Chỉ thêm dạng biến vào `word_forms` (entry của lemma đã có, hoặc job khác vừa tạo nó) |
| `invalid_output` | `failed` | hàng | P6 | Haiku sai định dạng sau một lần sửa, hoặc không thể tạo `meaning_vi` |

Bảng đầy đủ nhất, kèm giai đoạn đặt mã: `docs/lookup-enrichment.md` mục 11.

---

## 10. Truy vấn mẫu

Thay `pgboss` bằng giá trị `PGBOSS_SCHEMA` nếu khác. Đã chạy thử trên schema thật.

```sql
-- số job theo queue và trạng thái
SELECT name, state, count(*) AS n FROM pgboss.job GROUP BY name, state ORDER BY name, state;

-- cấu hình các queue
SELECT name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds, dead_letter
FROM pgboss.queue ORDER BY name;

-- các job của một từ (singleton_key = từ đã chuẩn hóa)
SELECT id, state, retry_count, retry_limit, start_after, created_on, started_on, completed_on, output
FROM pgboss.job
WHERE name = 'dictionary.enrich_word' AND singleton_key = 'ubiquitous'
ORDER BY created_on DESC;

-- job đang chạy
SELECT id, singleton_key, started_on, retry_count
FROM pgboss.job WHERE name = 'dictionary.enrich_word' AND state = 'active';

-- đang chờ và đã đến giờ chạy (nếu số này lớn và không giảm: worker không chạy)
SELECT min(start_after) AS oldest_ready, count(*) AS waiting
FROM pgboss.job
WHERE name = 'dictionary.enrich_word' AND state IN ('created', 'retry') AND start_after <= now();

-- hàng lỗi chết
SELECT id, data, source_id, source_retry_count, source_output, created_on
FROM pgboss.job WHERE name = 'dictionary.enrich_word.dlq' ORDER BY created_on DESC LIMIT 20;

-- hàng sổ đang queued/running nhưng pg-boss không còn job nào còn sống (ứng viên cho reconcile)
SELECT w.id, w.word, w.status, w.updated_at
FROM word_enrichment_jobs w
WHERE w.status IN ('queued', 'running')
  AND NOT EXISTS (
    SELECT 1 FROM pgboss.job j
    WHERE j.name = 'dictionary.enrich_word' AND j.state IN ('created', 'retry', 'active')
      AND j.data->>'jobRowId' = w.id::text);

-- sổ job theo trạng thái và mã reason
SELECT status, reason, count(*) AS n FROM word_enrichment_jobs GROUP BY status, reason ORDER BY n DESC;

-- các tiến trình pg-boss đang / đã chạy (stopped_on có giá trị = đã dừng gọn)
SELECT name, host, pid, version, supervise, schedule, started_on, heartbeat_on, stopped_on
FROM pgboss.instance ORDER BY started_on DESC;
```

---

## 11. Kiểm thử

- `tests/queue/pgBossEnqueuer.test.ts`: mọi nhánh a đến f (pg-boss, DB, bộ đếm giả), thứ tự lệnh, hoàn trần ngày, dữ liệu job chỉ có 4 trường.
- `tests/queue/enrichmentWorker.test.ts`: mọi nhánh của handler với pipeline giả, đọc `retryCount` / `retryLimit` từ metadata, hủy `signal`, hàng lỗi chết.
- `tests/queue/boss.test.ts`, `reconcileShutdown.test.ts`: tùy chọn queue, thứ tự tạo queue, `updateQueue`, reconcile, thứ tự dừng.
- `tests/queue/queue.integration.test.ts`: **Postgres thật + pg-boss thật**, schema riêng `pgboss_test_<mã>` và `pgboss_test_stop_<mã>` (xóa khi xong), từ fixture `qzq<mã>…`, bộ đếm riêng `enrichment_test_<mã>`: gửi → worker → `succeeded`; 10 lần gửi song song cùng một từ ra 1 hàng, 1 job, 1 lượt trần ngày; `UpstreamUnavailable` hai lần rồi thành công ra `attempts = 3`; luôn lỗi ra `failed` và job vào DLQ; dừng worker giữa chừng không mất job; `createQueue` / cài schema chạy lặp. Lần chạy hỏng giữa chừng có thể để lại schema `pgboss_test_*` hoặc hàng `qzq%`: xóa tay.

Jest (CommonJS) không nạp được các gói ES module nên `jest.config.js` có `transformIgnorePatterns` cho `pg-boss`, `rrule-temporal`, `serialize-error`, `non-error`. Nâng pg-boss mà có thêm phụ thuộc ESM thì thêm vào danh sách đó.

---

## 12. Quyết định thiết kế và giới hạn đã biết

1. **Transaction gộp d + e + f.** Đổi lấy: các lần gửi song song nối đuôi nhau trên một dòng bộ đếm. Bù lại không có "trần ngày bị trừ mà không có job".
2. **`ENRICHMENT_ENABLED=false` ở tiến trình API = không có pg-boss.** Mặc định của dự án (`ENRICHMENT_WORKER_ENABLED=true`) nếu chạy worker ở mọi API sẽ cài schema pg-boss vào database ở mọi lần triển khai. Worker riêng thì chạy bất kể `ENRICHMENT_ENABLED`.
3. **Không dùng `Retry-After` của nhà cung cấp** để đặt độ trễ thử lại: pg-boss chỉ nhận một lịch backoff cho cả queue khi handler ném lỗi. P6 nên tự giữ job (`startAfter`) nếu cần tôn trọng 429.
4. **Lần chạy bị ngắt khi dừng tiến trình vẫn tốn một lượt `retryLimit`.**
5. **Pool lỗi:** `config/db.ts` không có `pool.on('error')`. Neon cắt kết nối nhàn rỗi sẽ phát sự kiện `error` và làm sập tiến trình chạy lâu. `runtime.ts` gắn bộ ghi log cho tiến trình dùng hàng đợi; nên thêm cùng listener vào `config/db.ts` cho toàn dự án.
6. **pg-boss dùng `pg_advisory_xact_lock` (mức transaction)** nên chạy được qua PgBouncer chế độ transaction; `LISTEN/NOTIFY` không bật (`useListenNotify` mặc định tắt), chỉ thăm dò.
7. **Mở rộng:** mỗi tiến trình worker chạy `ENRICHMENT_WORKER_CONCURRENCY` job song song; chạy nhiều tiến trình worker là an toàn (pg-boss dùng `SKIP LOCKED`).
