module.exports = [
  {
    file: 'docs/lookup-spec.md',
    edits: [
      [
        `mục 5 F11 và F12 chạy nền sau khi đã trả response; 1.4: P8`,
        `mục 5 F11 và F12 chạy nền sau khi đã trả response, mục 12.1 thêm hai dòng log; 1.4: P8`,
      ],
      [
        `F11 Nếu ENRICHMENT_ENABLED và từ đáng tin (mục 7): gửi job. Lỗi hàng đợi chỉ ghi log, không làm hỏng response.
F12 Ghi word_lookups: translation (200) hoặc not_found (404, 503).
Giới hạn thời gian: tổng không vượt LOOKUP_TOTAL_DEADLINE_MS; hết hạn thì trả những gì đã có và đặt partial=true.`,
        `F11 Nếu ENRICHMENT_ENABLED và từ đáng tin (mục 7): gửi job. Lỗi hàng đợi chỉ ghi log, không làm hỏng response.
    Từ spec 1.5, việc GỬI chạy NỀN, sau khi response đã được trao cho nơi gọi, và không ai chờ nó. Response mang quyết định tại thời điểm trả lời: disabled (ENRICHMENT_ENABLED=false), skipped với reason unknown_word (từ không đáng tin, mục 7), hoặc queued (đã giao cho khâu gửi nền; đây là lời hứa thử gửi, không phải biên nhận). Kết quả thật của lần gửi (queued, already_queued, skipped với daily_cap, ...) chỉ nằm ở log { evt:'lookup_enrich' } (mục 12.1). Lần gửi ném lỗi ghi một dòng { evt:'lookup_background_error', task:'enrich' } mức error và không đổi response; vì từ vẫn chưa có trong từ điển, lần tra sau của từ đó tự thử gửi lại. Phép kiểm "từ đáng tin" vẫn chạy trước response, và chỉ truy vấn DB khi Free Dictionary chưa xác nhận từ.
F12 Ghi word_lookups: translation (200) hoặc not_found (404, 503). Từ spec 1.5 cũng chạy nền sau response (mọi nhánh, kể cả dictionary); lỗi ghi { evt:'lookup_background_error', task:'word_lookups' } và không đổi response.
Giới hạn thời gian: tổng không vượt LOOKUP_TOTAL_DEADLINE_MS; hết hạn thì trả những gì đã có và đặt partial=true.
    Hạn chót chỉ bao các truy vấn cục bộ và các cuộc gọi ra ngoài. Trước spec 1.5, việc gửi job (một giao dịch pg-boss, khoảng 0,5 giây với DB ở xa) và ghi word_lookups nằm SAU hạn chót mà vẫn trước response, nên đẩy p95 vượt LOOKUP_TOTAL_DEADLINE_MS + 500 ms. Nay hai việc đó chạy sau response nên không cộng vào thời gian người dùng chờ. LOOKUP_TOTAL_DEADLINE_MS và biên 500 ms của nghiệm thu không đổi.`,
      ],
      [
        `nếu ENRICHMENT_ENABLED và từ đáng tin thì gửi job với startAfter 60 giây`,
        `nếu ENRICHMENT_ENABLED và từ đáng tin thì gửi job với startAfter 60 giây (từ spec 1.5: kiểm từ và gửi đều chạy nền sau khi 503 đã đi; dòng log lookup ghi enrichment_status = deferred)`,
      ],
      [
        `Mỗi lần tra: { evt:'lookup', word, outcome, source, partial, latency_ms, google_ms, fd_ms, enrichment_status }.`,
        `Mỗi lần tra: { evt:'lookup', word, outcome, source, partial, latency_ms, google_ms, fd_ms, enrichment_status }. Từ spec 1.5, enrichment_status của dòng này là quyết định đã đưa vào response (disabled, skipped, queued; deferred sau một 503) và latency_ms là thời gian TỚI KHI TRẢ LỜI. Kết quả thật của lần gửi nền nằm ở dòng riêng { evt:'lookup_enrich', word, status, reason, delayed_s, enqueue_ms } (mức info). Một lần gửi hoặc một lần ghi word_lookups ở nền bị lỗi ra { evt:'lookup_background_error', task:'enrich'|'word_lookups', word, error } ở mức error (đã che khóa, tối đa 200 ký tự).`,
      ],
    ],
  },
  {
    file: 'docs/lookup-api.md',
    edits: [
      [
        "`queued` \\| `already_queued` \\| `skipped` \\| `disabled`. Hiện luôn `disabled` (chưa có hàng đợi thật, làm ở P5) |",
        "`queued` \\| `already_queued` \\| `skipped` \\| `disabled`. Từ spec 1.5 giá trị là **quyết định tại thời điểm trả lời**, vì việc gửi job chạy NỀN sau response: `disabled` (`ENRICHMENT_ENABLED=false`), `skipped` với `reason: unknown_word` (từ không đáng tin), hoặc `queued` (đã giao cho khâu gửi nền: lời hứa thử gửi, không phải biên nhận). `already_queued` và `skipped` với `daily_cap`, `queue_error`, `invalid_word` không còn xuất hiện ở đây; kết quả thật của lần gửi nằm ở log `lookup_enrich`. Tên trường và các giá trị cũ giữ nguyên; app hiện không đọc trường này |",
      ],
      [
        "→ F11 gắn hàng đợi → F12 ghi `word_lookups` (`dictionary`, `translation` hoặc `not_found`).",
        "→ F11 gắn hàng đợi → F12 ghi `word_lookups` (`dictionary`, `translation` hoặc `not_found`); **từ spec 1.5, F11 (gửi job) và F12 chạy nền sau khi response đã đi**, lỗi của chúng chỉ ra log.",
      ],
    ],
  },
  {
    file: 'docs/lookup-queue.md',
    edits: [
      [
        "Đường nhanh gọi trong `try/catch` (F11): lỗi hàng đợi không làm hỏng response.",
        "Đường nhanh gọi trong `try/catch` (F11): lỗi hàng đợi không làm hỏng response. **Từ spec 1.5 lần gọi này xảy ra SAU response**, trong khâu nền của `WordLookupService` (`afterResponse`): response chỉ mang `queued` (đã giao), kết quả thật của `enqueue()` ghi ở log `lookup_enrich`, và một `enqueue()` ném lỗi ghi `lookup_background_error` (task `enrich`). Trang quản trị (`POST /lookup/api/jobs`) gọi enqueuer trực tiếp nên vẫn nhận kết quả thật.",
      ],
      [
        "| `invalid_word` | (không có hàng) | `enrichment.reason` trong response | enqueuer (a) |",
        "| `invalid_word` | (không có hàng) | log `lookup_enrich` (từ spec 1.5; trước đó ở `enrichment.reason` của response) | enqueuer (a) |",
      ],
      [
        "| `daily_cap` | (không có hàng) | response + log warn + bộ đếm | enqueuer (d) |",
        "| `daily_cap` | (không có hàng) | log `lookup_enrich` + log warn + bộ đếm (từ spec 1.5 không còn ở response) | enqueuer (d) |",
      ],
      [
        "| `queue_error` | `failed` | hàng audit + `enrichment.reason` (P3) | enqueuer |",
        "| `queue_error` | `failed` | hàng audit + log `lookup_background_error` (từ spec 1.5 không còn ở `enrichment.reason`) | enqueuer |",
      ],
    ],
  },
  {
    file: 'docs/lookup-chaos.md',
    edits: [
      [
        "từ thứ ba: `enrichment: { status: \"skipped\", reason: \"daily_cap\" }`, không có job; câu trả lời tra từ vẫn đầy đủ |",
        "từ thứ ba: response vẫn `enrichment: { status: \"queued\" }` (quyết định trước khi gửi, từ spec 1.5), không có job, log `lookup_enrich` ghi `skipped / daily_cap`; câu trả lời tra từ vẫn đầy đủ |",
      ],
    ],
  },
  {
    file: 'docs/lookup-audit.md',
    edits: [
      [
        "| `WordLookupService.enrich` | e2e: job gửi cho từ có Free Dictionary,",
        "| `WordLookupService.planEnrichment` + `sendJob` (chạy nền sau response từ spec 1.5) | e2e: job gửi cho từ có Free Dictionary,",
      ],
      [
        "| `WordLookupService.recordLookup` | e2e: kết quả đúng ở từng ca của ma trận |",
        "| `WordLookupService.recordLookup` (chạy nền sau response từ spec 1.5) | e2e: kết quả đúng ở từng ca của ma trận; `lookupService.test.ts` (nhóm \"F11 / F12 run after the response\") |",
      ],
    ],
  },
];
