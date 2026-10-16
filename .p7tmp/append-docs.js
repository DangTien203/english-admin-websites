const fs = require('fs');

function appendTo(file, text) {
  let s = fs.readFileSync(file, 'utf8');
  const crlf = s.includes('\r\n');
  if (crlf) s = s.split('\r\n').join('\n');
  s = s.replace(/\n+$/, '\n') + text;
  if (crlf) s = s.split('\n').join('\r\n');
  fs.writeFileSync(file, s);
  console.log('appended to', file);
}

const history = `| Lần chạy | Mã | Chạy | Đạt | Không đạt | Không đánh giá được | p50 / p95 nhóm C, D, E, H |
|---|---|---|---|---|---|---|
| 15/10 (P7b) | cũ: gửi job trước response; Free Dictionary đã mở mạch ở E, F nên hỏng H | 28 từ (6 bỏ qua) | 18 | 10 | (chưa có nhãn) | 1.0 đến 1.7 s khi nguồn khỏe; **p95 3.756 ms, vượt 3.500** |
| 16/10 lần 1 | mới: gửi job và ghi \`word_lookups\` SAU response; công cụ đã có nhãn "không đánh giá được" cho 503 của E, F | 15 từ (27 bỏ qua) | 6 | 5 (nhóm H: \`senses = 0\`) | 4 (503 của E, F) | 3.075 ms / **3.389 ms**, trong giới hạn |
| 16/10 lần 2 | thêm hỏi lại ĐÚNG từ H sau lượt tra | 15 từ (34 bỏ qua) | 5 | 0 | 10 (6 H, 2 E, 2 F) | 834 ms / **3.432 ms**, trong giới hạn |
| 16/10 lần 3 (báo cáo ở trên) | thêm thăm dò bằng 3 từ khác nhau; nhóm H không chạy khi nguồn không khỏe | 9 từ (40 bỏ qua) | 5 | 0 | 10 (6 H chưa chạy, 2 E, 2 F) | 616 ms / **3.396 ms**, trong giới hạn |

`;

const body = `
## 7. Phân tích các lần chạy ngày 15 và 16/10/2026 (viết tay; chạy lại script sẽ ghi đè cả tệp, bản lưu ở \`docs/lookup-runbook.md\` mục 12.2 và 12.3)

${history}**Free Dictionary đang hỏng ở phía họ, không phải ở mã.** Ngày 16/10 (kiểm bằng \`curl\` trực tiếp, ngoài ứng dụng): các từ \`hello\` và \`house\` trả 200 trong 0,2 s (CDN của dịch vụ có sẵn trong bộ nhớ đệm); các từ khác như \`water\`, \`tree\`, \`jam\`, \`crane\`, \`bolt\` lúc thì treo hơn 6 đến 8 giây, lúc thì trả **404 trong 90 ms** (tức máy chủ gốc không đọc được mục từ). Nhật ký của chính máy chủ ứng dụng cho cùng một kết luận: \`fd: error:timeout\` (crane, bolt, stalk, london, microsoft), \`error:bad_response\` (pitch, seal), rồi \`error:breaker_open\` sau 5 lỗi liên tiếp. Vì vậy:

* **Nhóm H không chấm được hôm nay.** Lần 1 chấm 5 từ H "không đạt" (\`senses = 0\`) trong khi lần thăm dò đầu và cuối đều "khỏe": thăm dò chỉ dùng \`hello\`, một từ luôn có trong bộ nhớ đệm của CDN, nên không thấy máy chủ gốc đang chết. Đã sửa công cụ: thăm dò bằng ba từ khác nhau (\`house\`, \`water\`, \`tree\`), hỏi lại đúng từ H không có sense, và không chạy H khi lần thăm dò đầu không khỏe (lần 3).
* **503 của E, F (microsoft, shakespeare, asdfghjk, xinchao) là hành vi đúng của ma trận mục 6** ("không G, FDerr → 503"): Google dịch ra chính từ đó nên không dùng được, và Free Dictionary treo hoặc lỗi thì máy chủ không được bịa ra 404. **Đạt có ghi chú** về hành vi; kỳ vọng của đề bài (E: 200, F: 404) không kiểm tra được lúc này nên các dòng là "không đánh giá được: nguồn ngoài lỗi". Đặc tả mục 6 không đổi.
* **Điều đã chứng minh được hôm nay** dù nguồn hỏng: A và B đạt và ký tự Google không đổi (7.727 trước và sau); \`london\` (200, \`translation\`, job \`rejected / proper_noun\`, không mục từ); \`recieve\` (200 hoặc 404; job \`skipped / variant_form\`, không mục từ); mọi job của E rejected đúng; **p95 ≤ 3.500 ms ở cả ba lần chạy** (3.389, 3.432, 3.396 ms), gồm cả những câu chạm hết hạn chót 3.000 ms, vì việc gửi job (310 đến 460 ms, \`enqueue_ms\` trong log \`lookup_enrich\`) không còn nằm trước response.
* **Điều chưa chứng minh được và cần chạy lại khi Free Dictionary khỏe:** các điều kiện của nhóm H (\`senses\` từ 2 phần tử khác loại, \`meanings_vi\` từ 3) ở đường nhanh, và hai kỳ vọng E (microsoft, shakespeare: 200) và F (asdfghjk, xinchao: 404).

**Vì sao chỉ 9 đến 15 trong 30 từ chạy được, và việc cần bạn quyết để chạy đủ:**

1. **Nhóm C và D (9 từ) đều đã có mục từ** do job của lần chạy 15/10 tạo (\`published = false\`), nên tiền đề "chưa có mục từ" sai và các từ bị bỏ qua. Chạy lại nhóm C, D cần xóa các mục từ ấy (\`npm run acceptance:lookup -- --staging --cleanup\`) hoặc dùng từ mới. Prompt này cấm xóa dữ liệu nên **không** chạy \`--cleanup\`.
2. **Nhóm A và B thiếu \`run\`, \`go\`, \`light\` đã xuất bản**: ba mục từ đó đang \`published = false\` (mục từ \`bank\` và \`child\` vẫn \`published = true\`). Bản seed (\`npm run seed:lookup-test -- --staging\`) sẽ xuất bản lại chúng; tôi **không** chạy seed vì không rõ ai đã gỡ xuất bản và vì có thể bạn không muốn. Tôi chỉ tạo lại \`.acceptance.local.json\` (đổi mật khẩu của người dùng thử \`lookup-acceptance@example.com\`, không đụng mục từ nào).
3. **Mỗi lần chạy nhóm H để lại một mục từ cho mỗi từ** (job không cần Free Dictionary), nên mỗi lần chạy "dùng hết" 6 từ H. Đã dùng (đã có mục từ): batter, mole, sage, tick, fawn, trunk, rack, pawn (15/10), bark, crane, pitch, seal, bolt, stalk (lần 1 ngày 16/10), jam, ring, spring, mint, pound, row (lần 2). Còn 8 từ dự phòng chưa dùng: wave, well, yard, fan, tap, rock, bear, pool (đủ cho một lần chạy H nữa; nhóm H lần 3 **không chạy** nên không dùng thêm từ nào). Thêm từ vào \`FALLBACK_WORDS.H\` (\`scripts/acceptance/words.ts\`) khi cần.

Khi \`curl -m 6 https://api.dictionaryapi.dev/api/v2/entries/en/water\` trả 200 nhanh trở lại: \`npm run acceptance:lookup -- --staging --only H,E,F --base-url http://localhost:3000\`.
`;

appendTo('docs/lookup-acceptance-report.md', body);

const runbook = `
### 12.3 Kết quả sau bản vá (16/10/2026, DB dev, \`ENRICHMENT_PUBLISH_POLICY=review\`)

Ba lần chạy liên tiếp với mã mới (gửi job và ghi \`word_lookups\` sau response) và công cụ nghiệm thu mới. Nguồn ngoài hỏng cả ngày nên đây **không phải** lần chạy 30 từ đầy đủ. Bảng và phân tích: \`docs/lookup-acceptance-report.md\` mục 7.

${history}* **p95 đã nằm trong giới hạn**: 3.389, 3.432 và 3.396 ms so với 3.756 ms trước vá (giới hạn 3.500 ms), kể cả khi nhiều câu chạm hết hạn chót vì Free Dictionary treo. Phần vượt hạn chót của câu chậm nhất giảm từ ~756 ms xuống ~390 đến 430 ms.
* **Free Dictionary hỏng thật** (\`curl\` trực tiếp: \`hello\` và \`house\` nhanh nhờ CDN, mọi từ khác treo hoặc trả 404). Vì thế nhóm H và 503 của E, F là "không đánh giá được: nguồn ngoài lỗi"; 503 của từ rác là hành vi đúng của mục 6 (đạt có ghi chú).
* Đã sửa công cụ qua ba lần chạy: lần 1 cho thấy thăm dò bằng \`hello\` gọi một dịch vụ đã chết là khỏe, nên nay thăm dò bằng ba từ khác nhau, hỏi lại đúng từ H không có sense, và không chạy H khi nguồn không khỏe.
* Còn thiếu để chạy đủ 30 từ (cần bạn quyết, mục 7 của báo cáo): nhóm C, D đã có mục từ từ lần 15/10 (cần \`--cleanup\`, bị cấm ở đợt này); \`run\`, \`go\`, \`light\` đang \`published = false\` (cần \`seed:lookup-test\`, sẽ xuất bản lại chúng); nhóm H dùng hết 6 từ mỗi lần chạy.
`;
appendTo('docs/lookup-runbook.md', runbook);
