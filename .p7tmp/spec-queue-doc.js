module.exports = [
  {
    file: 'docs/lookup-queue.md',
    edits: [
      [
        `Các mô tả bên dưới về hợp đồng worker ⇄ pipeline vẫn đúng.`,
        `Các mô tả bên dưới về hợp đồng worker ⇄ pipeline vẫn đúng.
**P7 bổ sung:** bộ dọn \`reconcileStaleJobs\` chạy theo lịch mỗi 10 phút (mục 7); lệnh \`npm run enrich:redrive\` gửi lại job trong hàng chết (mục 5); worker chờ \`Retry-After\` của nhà cung cấp trước khi để pg-boss thử lại (mục 4); mọi kết nối bị DB cắt được ghi log thay vì làm sập tiến trình (mục 12). Quy trình vận hành: \`docs/lookup-runbook.md\`.`,
      ],
      [
        `Cron (\`schedule\`) tắt ở mọi vai trò cho tới P7 |`,
        `Cron (\`schedule\`) chỉ bật ở vai trò \`worker\` (từ P7: chạy bộ dọn mỗi 10 phút, mục 7) |`,
      ],
      [
        `| \`services/queue/reconcile.ts\` | \`reconcileStaleJobs()\` (§7) |`,
        `| \`services/queue/reconcile.ts\` | \`reconcileStaleJobs()\` (§7) |
| \`services/queue/reconcileSchedule.ts\` | lịch cron 10 phút, hàng \`dictionary.enrich_word.reconcile\`, khóa tư vấn (P7, §7) |
| \`services/queue/redrive.ts\`, \`scripts/enrichment/redrive.ts\` | \`npm run enrich:redrive\` (P7, §5) |
| \`config/poolErrors.ts\` | listener lỗi cho pool và cho từng client lấy từ pool (P7, §12) |`,
      ],
      [
        `Xem lại / chạy lại job trong DLQ: \`boss.redrive('dictionary.enrich_word.dlq', …)\` (P7 hoặc thao tác tay). Lưu ý hàng cũ đã \`failed\`; \`redrive\` tạo job mới nhưng handler sẽ tạo / hồi sinh hàng theo \`jobRowId\` (bước 1 và 2 ở §4).`,
        `**Gửi lại (P7):** \`npm run enrich:redrive\` (chạy thử là mặc định; \`--confirm\` mới gửi; chỉ gửi những job đã chọn bằng \`--word\`, \`--id\`, \`--reason\`, \`--limit\`). Không dùng \`boss.redrive()\` của pg-boss vì nó chỉ chuyển job **còn chờ** (\`state < active\`), mà worker của hàng chết hoàn tất job trong vài giây; lệnh đọc dữ liệu job còn lưu (mặc định 7 ngày) và gửi lại qua đúng enqueuer của đường tra, nên giữ mọi chốt (đã có mục từ, đã có hàng hoạt động, trần ngày, \`singletonKey\`). Hàng \`failed\` cũ giữ làm lịch sử, hàng mới được tạo. Cách dùng đầy đủ: \`docs/lookup-runbook.md\` mục 4.`,
      ],
      [
        `**P5 chưa gắn lịch.** P7 gọi định kỳ từ tiến trình worker. Chỉ chạy với`,
        `**Đã gắn lịch từ P7** (\`services/queue/reconcileSchedule.ts\`): vai trò \`worker\` của pg-boss (\`schedule: true\`) đăng ký cron \`*/10 * * * *\` vào hàng \`dictionary.enrich_word.reconcile\` (chính sách \`exclusive\`, \`retryLimit: 0\`), mỗi lần tới giờ có một job chạy \`reconcileStaleJobs\` trong một giao dịch giữ \`pg_try_advisory_xact_lock(hashtextextended('enrich:reconcile', 0))\`. Mỗi lúc chỉ một nơi chạy: pg-boss giành quyền đánh giá cron trong DB, hàng \`exclusive\` không để các lần tới giờ chồng nhau, và khóa tư vấn chặn lần chạy thứ hai. Test: \`tests/queue/reconcileSchedule*.test.ts\`, \`tests/chaos/schedule.chaos.test.ts\`. Chỉ chạy với`,
      ],
      [
        `# 20 hàng gần nhất và số lượng theo trạng thái
npm run enrich:status -- [--word ubiquitous] [--limit 20]`,
        `# 20 hàng gần nhất và số lượng theo trạng thái
npm run enrich:status -- [--word ubiquitous] [--limit 20]

# gửi lại job trong hàng chết (chạy thử là mặc định)
npm run enrich:redrive -- [--word a,b] [--id <id>] [--reason upstream_error] [--limit 20] [--confirm]`,
      ],
      [
        `Công cụ nằm trong \`scripts/\` (thư mục này đang bị \`.gitignore\`, như các script khác của dự án).`,
        `Công cụ nằm trong \`scripts/\`.`,
      ],
      [
        `Lần chạy hỏng giữa chừng có thể để lại schema \`pgboss_test_*\` hoặc hàng \`qzq%\`: xóa tay.`,
        `Lần chạy hỏng giữa chừng có thể để lại schema \`pgboss_test_*\` hoặc hàng \`qzq%\`: xóa tay.
- P7: \`tests/queue/reconcileSchedule.test.ts\`, \`reconcileSchedule.integration.test.ts\` (lịch, khóa tư vấn, hai thực thể cùng schema), \`redrive.test.ts\`, \`redrive.integration.test.ts\` (job thật vào hàng chết rồi được gửi lại), \`enrichmentWorkerRetryAfter.test.ts\`; các kịch bản chịu lỗi ở \`tests/chaos/\` (\`docs/lookup-chaos.md\`).`,
      ],
      [
        `5. **Pool lỗi:** \`config/db.ts\` không có \`pool.on('error')\`. Neon cắt kết nối nhàn rỗi sẽ phát sự kiện \`error\` và làm sập tiến trình chạy lâu. \`runtime.ts\` gắn bộ ghi log cho tiến trình dùng hàng đợi; nên thêm cùng listener vào \`config/db.ts\` cho toàn dự án.`,
        `5. **Pool lỗi (đã vá ở P7):** trước đây \`config/db.ts\` không có \`pool.on('error')\`, và một client đang được dùng (\`pool.connect()\`, ví dụ trong giao dịch ghi mục từ hay giao dịch của enqueuer) **không có listener lỗi nào cả** (pg-pool gỡ listener của nó khi giao client ra). Neon cắt kết nối ở một trong hai tình huống đó là một sự kiện \`error\` không ai nghe, tức ngoại lệ không bắt được làm sập API / worker. \`config/poolErrors.ts\` (\`attachPoolErrorHandlers\`) gắn \`pool.on('error')\` (client rảnh, log \`pg_pool_error\`) và, trên sự kiện \`connect\` của pool, \`client.on('error')\` cho mọi client mới (log \`pg_client_error\`); dùng cho pool chính và pool \`REFDATA_DATABASE_URL\`. Câu truy vấn đang chạy vẫn nhận lỗi như một lời từ chối bình thường. Test: \`tests/db/poolError.test.ts\` (giết kết nối thật bằng \`pg_terminate_backend\`), \`tests/chaos/db.chaos.test.ts\`.`,
      ],
      [
        `3. **Không dùng \`Retry-After\` của nhà cung cấp** để đặt độ trễ thử lại: pg-boss chỉ nhận một lịch backoff cho cả queue khi handler ném lỗi. P6 nên tự giữ job (\`startAfter\`) nếu cần tôn trọng 429.`,
        `3. **\`Retry-After\` của nhà cung cấp** không đặt được độ trễ thử lại của pg-boss (chỉ có một lịch backoff cho cả queue khi handler ném lỗi). Từ P7 worker **chờ** \`Retry-After\` của một 429 (tối đa \`MAX_RETRY_AFTER_WAIT_MS\` = 60 s, dừng sớm nếu tiến trình đang tắt) rồi mới đặt hàng về \`queued\` và ném lỗi, nên lần thử lại do pg-boss lên lịch không đập vào cùng bức tường (spec §11.4). Không chờ ở lần thử cuối. Phần vượt quá 60 s do backoff của pg-boss (30 s, gấp đôi) đảm nhận.`,
      ],
    ],
  },
];
