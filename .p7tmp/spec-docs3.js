module.exports = [
  {
    file: 'docs/lookup-runbook.md',
    edits: [
      [
        `Thăm dò lại sau mỗi lần chờ mạch ngắt và sau lượt tra.`,
        `Thăm dò lại sau mỗi lần chờ mạch ngắt và sau lượt tra. Nếu lần thăm dò ĐẦU không khỏe, **nhóm H không được chạy**: lượt tra không chấm được, và mỗi lần chạy để lại một mục từ cho từng từ (job không cần Free Dictionary) nên chỉ làm hao từ và hỏi thêm một dịch vụ đang chập chờn. Các từ của nó nằm ở mục 4.1 của báo cáo với lý do "chưa chạy" và được giữ nguyên cho lần chạy lại. Nhóm E và F vẫn chạy.`,
      ],
      [
        `(a) nhóm H khi Free Dictionary không khỏe lúc tra (thăm dò trước đó hoặc sau lượt tra không khỏe, hoặc mạch ngắt có vẻ đang mở) mà từ không có sense;`,
        `(a) nhóm H khi Free Dictionary không khỏe lúc tra (thăm dò trước đó hoặc sau lượt tra không khỏe, hoặc mạch ngắt có vẻ đang mở) mà từ không có sense; ngoài ra, mỗi từ H trả về không có sense còn được **hỏi lại đúng từ đó** sau lượt tra: Free Dictionary có dữ liệu cho từ ấy (nghĩa là máy chủ không nhận được gì lúc tra: timeout, phản hồi hỏng, mạch ngắt) hoặc vẫn không trả lời thì không đánh giá được; nếu nó trả **404** cho từ đó thì từ H chọn không hợp và vẫn là không đạt (ba từ thông dụng của lần thăm dò có thể khỏe trong khi các từ chưa nằm trong bộ nhớ đệm của họ thì treo, đã thấy ngày 16/10/2026);`,
      ],
    ],
  },
];
