module.exports = [
  {
    file: 'docs/lookup-loadtest.md',
    edits: [
      [
        `Đo ngày 15/10/2026 · Node v24.14`,
        `Đo ngày 15/10/2026; mục 2.6 (kịch bản D, sau khi việc gửi job chạy sau response) đo ngày 16/10/2026 · Node v24.14`,
      ],
      [
        `| Heap trước và sau |`,
        `| p50 / p95 khi việc gửi job chạy SAU response (kịch bản D, 16/10/2026) | **855 đến 880 ms / 893 đến 902 ms**, so với **1.275 / 1.426 ms** của mã cũ đo trong cùng điều kiện (gửi job thật vào pg-boss, 30 từ mới, nguồn ngoài giả trễ 300 ms). Mức giảm bằng đúng thời gian một lần gửi (320 đến 410 ms). Chi tiết ở mục 2.6 |
| Heap trước và sau |`,
      ],
      [
        `| **C** F6 | một người dùng hỏi 25 từ mới cùng lúc |`,
        `| **D** trả lời và gửi job | \`--send\` từ mới (mặc định 30) lần lượt từng từ, \`ENRICHMENT_ENABLED=true\` với bộ gửi pg-boss THẬT trong schema riêng \`lt_<mã>\` (không worker nên không job nào được xử lý), nguồn ngoài giả trễ \`--latency\` ms | mọi câu 200 đầy đủ và \`enrichment.status = "queued"\`; mọi từ có hàng trong sổ job (việc gửi nền có chạy); mọi lần gửi nền ra \`queued\`; thời gian trả lời nhỏ hơn "trả lời cộng thời gian gửi". Dọn xong: hàng sổ job, ô đếm job của ngày (\`api_usage_counters\`), schema \`lt_<mã>\` |
| **C** F6 | một người dùng hỏi 25 từ mới cùng lúc |`,
      ],
      [
        `npm run loadtest:lookup -- --skip-slow --json out.json   # bỏ kịch bản B (chờ ~20 s), ghi thêm JSON`,
        `npm run loadtest:lookup -- --skip-slow --json out.json   # bỏ kịch bản B (chờ ~20 s), ghi thêm JSON
npm run loadtest:lookup -- --only-send                   # chỉ kịch bản D (khoảng 1 đến 2 phút, phần lớn là pg-boss tạo schema riêng)
npm run loadtest:lookup -- --skip-send                   # bỏ kịch bản D`,
      ],
      [
        `## 3. EXPLAIN (ANALYZE, BUFFERS)`,
        `### 2.6 Kịch bản D: thời gian trả lời khi việc gửi job và ghi \`word_lookups\` chạy sau response (16/10/2026)

**Vì sao.** Lần nghiệm thu 15/10/2026 cho p95 nhóm C, D, E, H là **3.756 ms**, vượt \`LOOKUP_TOTAL_DEADLINE_MS + 500\` = 3.500 ms. Hạn chót 3.000 ms chỉ bao truy vấn cục bộ và các cuộc gọi ra ngoài; việc gửi job (một giao dịch pg-boss, khoảng 0,4 giây với DB ở Singapore) và việc ghi \`word_lookups\` nằm sau hạn chót mà vẫn trước response. Từ spec 1.5 hai việc đó chạy **sau** response (\`docs/lookup-spec.md\` mục 5 F11, F12). \`LOOKUP_TOTAL_DEADLINE_MS\` và biên 500 ms không đổi.

**Cách đo.** 30 từ mới, từng từ một (tuần tự, để số đo là chi phí của mã và của các vòng gọi DB, không phải hàng chờ kết nối), \`ENRICHMENT_ENABLED=true\`, bộ gửi pg-boss thật trong schema riêng, nguồn ngoài giả trễ 300 ms, DB là Neon ở Singapore gọi từ máy dev. Cột "mã cũ" là kết quả đo THẲNG: đặt tạm tệp \`services/lookup/lookupService.ts\` của commit HEAD vào cây làm việc, chạy \`npm run loadtest:lookup -- --only-send --send 30\`, rồi trả tệp mới về chỗ cũ.

| | n | p50 | p95 | max |
|---|---|---|---|---|
| **Mã cũ** (gửi job TRƯỚC response), đo thẳng | 30 | 1.275 ms | 1.426 ms | 1.601 ms |
| **Mã mới**, lần chạy 1 | 30 | **855 ms** | **893 ms** | 917 ms |
| mã mới, lần 1, cộng thời gian gửi (\`enqueue_ms\` trong log \`lookup_enrich\`) = người dùng đã phải chờ bao lâu nếu việc gửi đứng trước | 30 | 1.270 ms | 1.303 ms | 1.327 ms |
| riêng việc gửi job, lần 1 | 30 | 410 ms | 425 ms | 439 ms |
| **Mã mới**, lần chạy 2 (bản cuối, có gộp các lần gửi cùng từ) | 30 | **880 ms** | **902 ms** | 934 ms |
| mã mới, lần 2, cộng thời gian gửi | 30 | 1.206 ms | 1.243 ms | 1.253 ms |
| riêng việc gửi job, lần 2 | 30 | 320 ms | 349 ms | 354 ms |

Đọc: p50 giảm khoảng 400 ms (−31 đến −33%) và p95 khoảng 520 ms (−37%), khớp với thời gian một lần gửi. Hai cách ước (đo thẳng mã cũ, và "mã mới cộng thời gian gửi") cho cùng một con số trong sai số của Neon (1.275 so với 1.206 đến 1.270). Mọi kiểm tra của kịch bản đạt (30 câu 200 đầy đủ, \`enrichment.status = "queued"\`, 33 hàng sổ job cho 33 từ kể cả 3 từ làm ấm, mọi lần gửi nền \`queued\`), cả hai lần chạy của mã mới.

**Trên nghiệm thu thật** (nguồn ngoài thật, Free Dictionary chập chờn khiến nhiều từ chạm hết hạn chót 3.000 ms): p95 của C, D, E, H là **3.389 ms** và **3.432 ms** ở hai lần chạy ngày 16/10, nằm trong giới hạn 3.500 ms (trước đó 3.756 ms). Phần vượt hạn chót của câu chậm nhất giảm từ ~756 ms xuống ~390 đến 430 ms, tức bớt đúng một lần gửi job; còn lại là truy vấn cục bộ, xác thực và HTTP. Xem \`docs/lookup-acceptance-report.md\`.

**Kiểm tra không thụt lùi ở tải** (\`--same 30 --distinct 15 --skip-slow\`, cấu hình mặc định, 16/10/2026, bản cuối): 21 trên 21 kiểm tra đạt. 30 cùng một từ cộng 15 từ khác: p50 1.529 / 1.508 ms, p95 1.535 / 1.512 ms (hai vòng); hàng chờ DB cao nhất 50 và 49; 1 chuyến bay + 29 người nhập chung, Free Dictionary và Google mỗi nơi nhận đúng 1 request cho từ chung ở cả hai vòng; F6 đúng 20 nhận và 5 bị 429; heap +1,6 MB sau hai vòng (vòng cuối +0,3 MB). Con số này **không so sánh được** với mục 2.1 lần 3 (3.021 / 2.041 ms): hôm đó và hôm nay DB ở xa chậm khác nhau, và kịch bản A chạy với \`ENRICHMENT_ENABLED=false\` nên không có việc gửi job; chỉ kết luận được là không có hồi quy (kiểm tra đạt, hàng chờ DB không tăng).

**Điều cần biết.** Trước đây việc gửi job nằm trong request nên số request chạy việc đó cùng lúc bị chặn bởi số request đang chạy. Nay không còn chặn: một đợt tra dồn dập tạo ra các lần gửi cùng lúc, tranh kết nối với những lần tra tiếp theo. Hai biện pháp có trong mã: (1) mỗi tiến trình chỉ chạy **một** lần gửi cho mỗi từ tại một thời điểm (trăm request chung một chuyến bay không còn thành trăm giao dịch pg-boss; hàng đợi vốn chỉ nhận một job mỗi từ), (2) khi tắt gọn (SIGTERM) tiến trình chờ tối đa 10 giây cho các việc nền đang chạy xong (\`app.ts\`, bước \`lookup_background\`). Chưa có giới hạn tổng số việc nền chạy cùng lúc: đó là mục "bộ giới hạn đồng thời" của khuyến nghị 2 ở mục 2.1, vẫn để bạn quyết.

## 3. EXPLAIN (ANALYZE, BUFFERS)`,
      ],
    ],
  },
];
