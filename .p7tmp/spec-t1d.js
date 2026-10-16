module.exports = [
  {
    file: 'docs/lookup-runbook.md',
    edits: [
      [
        "`auto` (**mặc định khi không đặt biến**) công khai ngay mục từ đủ tầng A.",
        "**`review` cũng là mặc định khi không đặt biến (hoặc để trống) từ spec 1.5**; các bản trước mặc định `auto`. `auto` công khai ngay mục từ đủ tầng A và chỉ có hiệu lực khi được đặt RÕ trong môi trường của worker. **Bản mã cũ (ví dụ một triển khai từ xa chưa được triển khai lại) vẫn mặc định `auto`**: muốn chắc chắn, đặt `ENRICHMENT_PUBLISH_POLICY=review` tường minh ở mọi nơi có worker, đừng chỉ dựa vào mặc định.",
      ],
      [
        "(`ENRICHMENT_PUBLISH_POLICY` mặc định là `auto` khi không đặt)",
        "(`ENRICHMENT_PUBLISH_POLICY` mặc định là `review` khi không đặt, từ spec 1.5; worker chạy bản mã cũ vẫn mặc định `auto` cho tới khi được triển khai lại hoặc được đặt biến tường minh)",
      ],
    ],
  },
];
