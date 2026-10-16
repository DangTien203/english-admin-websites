module.exports = [
  {
    file: 'docs/lookup-attribution.md',
    edits: [
      [
        `Cập nhật 15/10/2026 (P7b). Tài liệu này`,
        `Cập nhật 16/10/2026 (vá sau P8: mục 2.5 nhãn nhà cung cấp, mục 4 và 5.7 Datamuse); lần đầu 15/10/2026 (P7b). Tài liệu này`,
      ],
      [
        `| App Flutter, popup tra từ (\`wordygo/lib/features/ebook/widgets/word_lookup_popup.dart\`) | Hiển thị một dòng chữ nhỏ: \`Translated by Google\` nếu có nhà cung cấp tên \`google\`, ngược lại \`Auto-translated\`. **Backend gửi \`google_translate\`, không phải \`google\`**, nên điều kiện không bao giờ đúng và dòng luôn là \`Auto-translated\`. App không đọc trường \`attribution\` |`,
        `| App Flutter, popup tra từ (\`wordygo/lib/features/ebook/widgets/word_lookup_popup.dart\`) | Hiển thị một dòng chữ nhỏ: \`Translated by Google\` nếu có nhà cung cấp tên \`google\`, ngược lại \`Auto-translated\`. **Backend gửi \`google_translate\`, không phải \`google\`**, nên điều kiện không bao giờ đúng và dòng luôn là \`Auto-translated\`. App không đọc trường \`attribution\`. Hai giá trị và nơi cần sửa: mục 2.5 |`,
      ],
      [
        `## 3. Đề xuất nơi hiển thị (để bạn chọn; chưa làm gì trong mã)`,
        `### 2.5 Nhãn nhà cung cấp: backend gửi gì, app so khớp gì, sửa ở đâu

Kiểm ngày 16/10/2026 bằng đọc mã của hai bên (\`grep\` trên \`english-admin-websites\` và \`wordygo/lib\`).

| | Giá trị | Nơi |
|---|---|---|
| **Backend đang gửi** cho Google Translate | \`google_translate\` | \`services/lookup/merge.ts\` (hàm \`composeTemporary\`, dòng \`providers.push('google_translate')\`): có khi Google dịch từ gốc (chế độ \`LOOKUP_FAST_TRANSLATOR=google\`) **hoặc** khi bước 2 (dịch định nghĩa) đã chạy. Đường cũ \`services/wordTranslationService.ts\` (dòng \`providers.push('google_translate')\`, và cả hàng đã lưu trong bảng cache) gửi cùng giá trị |
| **App đang so khớp** | \`google\` | \`wordygo/lib/features/ebook/widgets/word_lookup_popup.dart\`, getter \`_attribution\`: \`providers.any((p) => p.toLowerCase() == 'google')\` |

\`google_translate\` khác \`google\`, nên điều kiện không bao giờ đúng: mọi bản dịch tạm đều hiện \`Auto-translated\`, kể cả khi bản dịch chính là của Google.

**Backend KHÔNG đổi giá trị** (quy tắc của đặc tả mục 0.3: response chỉ được THÊM trường, không đổi tên hay giá trị, vì app cũ đang chạy và \`docs/lookup-api.md\` đã ghi \`google_translate\`). Việc sửa nhãn nằm ở **app**. Những chỗ cần sửa, và chỉ những chỗ này (đã tìm hết trong \`wordygo/lib\`):

1. \`lib/features/ebook/widgets/word_lookup_popup.dart\`, getter \`_attribution\` (khoảng dòng 478 đến 484): đổi so khớp \`== 'google'\` thành \`== 'google_translate'\`. Đây là chỗ DUY NHẤT đọc \`providers\`.
2. Cũng ở getter đó, **xử lý \`claude_haiku\`**: khi \`LOOKUP_FAST_TRANSLATOR=haiku\`, \`translation_vi\` đến từ Claude còn \`providers\` vẫn có \`google_translate\` (vì bước 2 dịch định nghĩa vẫn dùng Google). Nếu chỉ sửa theo ý 1, dòng \`Translated by Google\` sẽ hiện cho một bản dịch của Claude, là sai sự thật. Nên kiểm \`claude_haiku\` TRƯỚC (ví dụ nhãn "Dịch bởi AI") rồi mới tới \`google_translate\`. Ngoài ra \`providers\` chỉ có \`free_dictionary_api\` (Google lỗi, \`translation_vi = null\`) thì không được ghi Google.
3. Không cần đổi \`lib/features/ebook/models/word_lookup_result.dart\` (dòng 101, 114) và \`word_lookup_result.g.dart\` (dòng 27, 28, 42): chúng chỉ mang chuỗi qua lại.

Việc ghi công đầy đủ hơn (huy hiệu Google, Wiktionary từ \`attribution[]\`) là các đề xuất #1 và #2 ở mục 3, vẫn chờ bạn quyết định.

## 3. Đề xuất nơi hiển thị (để bạn chọn; chưa làm gì trong mã)`,
      ],
      [
        `* **Datamuse yêu cầu khóa API**: phần đầu trang nói từ **1/2/2027**, mục *Usage limits* của chính trang đó nói **1/1/2027** (mâu thuẫn tại thời điểm đọc). Mã dùng ngày an toàn hơn, 1/1/2027, để cảnh báo. Chi tiết: \`docs/lookup-runbook.md\` mục 11.2.`,
        `* **Datamuse yêu cầu khóa API**: phần đầu trang nói từ **1/2/2027**, mục *Usage limits* của chính trang đó nói **1/1/2027** (mâu thuẫn tại thời điểm đọc, đọc lại 16/10/2026 vẫn vậy). Mã dùng ngày an toàn hơn, 1/1/2027, để cảnh báo. Chi tiết: \`docs/lookup-runbook.md\` mục 11.2.
* **Datamuse: trang chính thức vẫn KHÔNG nói cách gửi khóa** (đọc \`https://www.datamuse.com/api/\` ngày 16/10/2026, cả bản đã dựng lẫn HTML gốc): không có tên tham số truy vấn, tên header hay kiểu \`Authorization\`. Chỉ có hai câu: khóa "sẽ bắt buộc trong mọi request, giới hạn 100.000 request mỗi ngày mỗi khóa" và "nếu chưa có khóa, hãy liên hệ qua biểu mẫu phản hồi"; kèm một ghi chú ngày 5/10 của chủ trang nói đang xử lý dần các yêu cầu cấp khóa. Vì vậy \`applyDatamuseAuth\` (\`services/upstream/datamuseClient.ts\`) **được giữ nguyên là hàm rỗng**: đoán tên tham số rồi gửi khóa đi một nơi chưa được tài liệu hóa vừa có thể bị từ chối, vừa đưa khóa vào URL/header theo cách không ai cam kết.`,
      ],
      [
        `7. **Datamuse**: xin khóa, và quyết định có ghi nhận trong tài liệu ứng dụng (#6) không.`,
        `7. **Datamuse**: xin khóa qua biểu mẫu phản hồi của họ (trang nói ghi chú 5/10 là họ đang cấp dần), hỏi luôn **cách gửi khóa** nếu thư cấp khóa không nói; khi có câu trả lời bằng văn bản, viết vào \`applyDatamuseAuth\` (nơi duy nhất) kèm test. Và quyết định có ghi nhận trong tài liệu ứng dụng (#6) không.`,
      ],
    ],
  },
  {
    file: 'docs/lookup-runbook.md',
    edits: [
      [
        `* \`DATAMUSE_API_KEY\` được đọc, nhưng hàm \`applyDatamuseAuth\` (\`services/upstream/datamuseClient.ts\`) **cố ý rỗng**: chưa có tài liệu nên chưa đoán tên tham số.`,
        `* \`DATAMUSE_API_KEY\` được đọc, nhưng hàm \`applyDatamuseAuth\` (\`services/upstream/datamuseClient.ts\`) **cố ý rỗng**: chưa có tài liệu nên chưa đoán tên tham số. (Đọc lại trang chính thức ngày 16/10/2026: vẫn không nói cách gửi khóa, xem \`docs/lookup-attribution.md\` mục 4.)`,
      ],
    ],
  },
];
