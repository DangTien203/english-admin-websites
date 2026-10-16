module.exports = [
  {
    file: 'docs/lookup-enrichment.md',
    edits: [
      [
        "`ENRICHMENT_PUBLISH_POLICY=review` → luôn `false`; `auto` → `true` khi đủ tầng A.",
        "`ENRICHMENT_PUBLISH_POLICY=review` → luôn `false`; `auto` → `true` khi đủ tầng A. **Mặc định khi không đặt biến là `review`** (đổi từ `auto` ở spec 1.5); `auto` phải được đặt tường minh.",
      ],
    ],
  },
];
