module.exports = [
  {
    file: 'docs/lookup-runbook.md',
    edits: [
      // ── log table ──
      [
        "`shared` (nhập chung một chuyến bay), `enrichment_status` |",
        "`shared` (nhập chung một chuyến bay), `enrichment_status` (quyết định đã đưa vào response: `disabled`, `skipped`, `queued`; `deferred` sau một 503; từ spec 1.5). `latency_ms` là thời gian tới khi trả lời |",
      ],
      [
        "| `upstream_config_error` | **error** | nhà cung cấp trả 400/401/403 |",
        "| `lookup_enrich` | info | lần gửi job NỀN của một lần tra xong (từ spec 1.5; response chỉ nói `queued`, đây mới là kết quả thật) | `word`, `status` (`queued`, `already_queued`, `skipped`), `reason` (ví dụ `daily_cap`, `unknown_word` sau một 503), `delayed_s` (60 sau sự cố), `enqueue_ms` |\n| `lookup_background_error` | **error** | một việc chạy nền sau response ném lỗi: gửi job (`task: enrich`) hoặc ghi `word_lookups` (`task: word_lookups`). Response KHÔNG bị đổi; lần tra sau của từ đó tự thử gửi lại job | `task`, `word`, `error` (đã che khóa, tối đa 200 ký tự) |\n| `upstream_config_error` | **error** | nhà cung cấp trả 400/401/403 |",
      ],
      // ── diagnosis table ──
      [
        "| Job không chạy | `queue.main.waiting` tăng, `active` 0 |",
        "| Từ mới được tra mà không thấy job trong `/lookup/jobs` | log `lookup_enrich` của từ đó và `lookup_background_error` | Từ spec 1.5 việc gửi job chạy sau response, nên response luôn nói `queued` kể cả khi không có job. `lookup_enrich` cho biết thật: `already_queued` (đã có job), `skipped / daily_cap` (hết trần ngày), hoặc không có dòng nào + `lookup_background_error` (`task: enrich`, pg-boss / DB lỗi). Lần tra kế tiếp của từ đó tự gửi lại |\n| Job không chạy | `queue.main.waiting` tăng, `active` 0 |",
      ],
      // ── section 12 ──
      [
        "`ENRICHMENT_PUBLISH_POLICY=review`, đủ `GOOGLE_TRANSLATE_API_KEY` và `ANTHROPIC_API_KEY`: `npm run dev` (hoặc `npx tsx app.ts`). Script nghiệm thu đọc cùng `.env` nên hai bên phải cùng cấu hình.",
        "`ENRICHMENT_PUBLISH_POLICY=review`, đủ `GOOGLE_TRANSLATE_API_KEY` và `ANTHROPIC_API_KEY`: `npm run dev` (hoặc `npx tsx app.ts`). Script nghiệm thu đọc cùng `.env` nên hai bên phải cùng cấu hình. Từ spec 1.5 mặc định đã là `review`, nhưng một dòng `ENRICHMENT_PUBLISH_POLICY=auto` **tường minh** trong `.env` vẫn thắng mặc định: kiểm tra `.env`, hoặc đặt biến trong chính shell chạy cả máy chủ lẫn script (dotenv không ghi đè biến đã có trong shell), ví dụ `ENRICHMENT_ENABLED=true ENRICHMENT_PUBLISH_POLICY=review npm run dev`.",
      ],
      [
        "`--wait-minutes` (mặc định 10) là thời gian chờ job nền. Mã thoát 0 khi không có \"không đạt\". Mất khoảng 2 phút",
        "`--wait-minutes` (mặc định 10) là thời gian chờ job nền. **Mã thoát**: 0 = không có \"không đạt\" và mọi từ đều có kết luận; 1 = có \"không đạt\" (hoặc ký tự Google đổi, hoặc p95 vượt); **3 = không có \"không đạt\" nhưng còn từ \"không đánh giá được: nguồn ngoài lỗi\"** (đừng đọc là đạt; mục 12.2). Thứ tự chạy là A, B, C, D, **H**, E, F (không phải thứ tự của đề bài: H trước E và F, mục 12.2). Mất khoảng 2 phút",
      ],
      [
        "nhóm C và H có từ dự phòng thay (nostalgia, gregarious, lucid; trunk, rack, pawn). *Không đạt* kèm nguyên nhân từng dòng ở mục 4 của báo cáo.",
        "nhóm C và H có từ dự phòng thay (C: nostalgia, gregarious, lucid; H: trunk, rack, pawn, bark, crane, pitch, seal, bolt, stalk, jam). *Không đạt* kèm nguyên nhân từng dòng ở mục 4 của báo cáo. *Không đánh giá được: nguồn ngoài lỗi* ở mục 4.1 (mục 12.2).",
      ],
      [
        "Điều đạt: A và B (9/9, mỗi lần tra ~0,2 s, **ký tự Google không đổi: 2.883 trước và sau**, mọi dạng biến đã có dòng `word_forms`), C, D (7/7 job), E (3/3 `rejected / proper_noun`), `recieve` (`skipped / variant_form`, không mục từ), 12/12 job nhóm C, D, H `succeeded` và `published = false`.",
        "Điều đạt: A và B (9/9, mỗi lần tra ~0,2 s, **ký tự Google không đổi: 2.883 trước và sau**, mọi dạng biến đã có dòng `word_forms`), C, D (7/7 job), E (3/3 `rejected / proper_noun`), `recieve` (`skipped / variant_form`, không mục từ), 12/12 job nhóm C, D, H `succeeded` và `published = false`.\n\n### 12.2 Khi Free Dictionary lỗi: cách chấm (bản vá 16/10/2026)\n\nLần chạy đầu cho thấy hai thứ không phải lỗi của mã vẫn bị ghi \"không đạt\": nhóm H (Free Dictionary đã bị mạch ngắt mở bởi E và F) và các ca 503 của E, F (Free Dictionary treo). Bộ nghiệm thu nay xử lý như sau; **đặc tả mục 6 không đổi và không được sửa để hợp thức hóa kết quả**.\n\n1. **Thăm dò trước khi chạy.** Gọi THẲNG Free Dictionary 3 lần liền với từ mẫu `hello` (không qua máy chủ, để không làm mạch ngắt của máy chủ nhích). **Khỏe** chỉ khi cả 3 lần trả 200 với danh sách mục từ không rỗng trong `LOOKUP_UPSTREAM_TIMEOUT_MS`. Kết quả 3 lần được in và ghi vào báo cáo (mục 1.1). Thăm dò lại sau mỗi lần chờ mạch ngắt và sau lượt tra.\n2. **Nhãn mới: \"không đánh giá được: nguồn ngoài lỗi\"** (không phải đạt, không phải không đạt). Áp cho: (a) nhóm H khi Free Dictionary không khỏe lúc tra (thăm dò trước đó hoặc sau lượt tra không khỏe, hoặc mạch ngắt có vẻ đang mở) mà từ không có sense; (b) **mọi ca 503 `TRANSLATION_UNAVAILABLE` của nhóm E, F, H**. Lý do (b): theo ma trận mục 6, \"không G, FDerr → 503\" là cách DUY NHẤT ra 503; từ rác như `asdfghjk`, `xinchao` không có bản dịch của Google nên câu trả lời phải chờ Free Dictionary, và khi nó treo thì máy chủ KHÔNG được bịa ra 404 mà phải trả 503. Vậy 503 ở đó là hành vi **đúng** (**đạt có ghi chú**); chỉ kỳ vọng của nhóm (E: 200, F: 404) là không kiểm tra được. Báo cáo ghi câu này mỗi lần.\n3. Mọi lỗi khác vẫn là \"không đạt\" dù Free Dictionary ra sao (sai mã HTTP, sai `source`, thiếu bản dịch, job sai). Một dòng có phần nhanh \"không đánh giá được\" nhưng phần job \"không đạt\" vẫn là **không đạt**.\n4. **Thứ tự và mạch ngắt.** Nhóm H chạy trước E và F (E, F là hai nhóm làm Free Dictionary treo). Giữa hai nhóm, nếu `UPSTREAM_BREAKER_FAILURE_THRESHOLD` lần tra liên tiếp cuối cùng đều cho thấy Free Dictionary lỗi (503, hoặc nhóm C, D, H trả bản tạm thiếu `pos`) thì máy chủ có vẻ đã ngắt mạch: script chờ `UPSTREAM_BREAKER_RESET_MS` (cộng 2 s đệm) tính từ lần lỗi cuối, thăm dò lại, rồi mới sang nhóm kế. Thời gian chờ được ghi vào báo cáo.\n5. **Chạy lại riêng.** Báo cáo và console in đúng lệnh, chỉ gồm các nhóm còn dòng chưa đánh giá được (theo thứ tự chạy), ví dụ `npm run acceptance:lookup -- --staging --only H,E,F --base-url http://localhost:3000`. Nhóm H đã chạy để lại mục từ cho từng từ (job không cần Free Dictionary) nên các từ đó thành \"bỏ qua: đã có mục từ\"; script lấy từ dự phòng kế tiếp (có 10 từ dự phòng cho H). **Không dùng `--cleanup`** nếu bạn không muốn xóa dữ liệu.",
      ],
    ],
  },
];
