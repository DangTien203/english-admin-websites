module.exports = [
  {
    file: 'config/lookup.ts',
    edits: [
      [
        `  ENRICHMENT_PUBLISH_POLICY: z.preprocess(
    blankToUndefined,
    z.enum(['auto', 'review'], { error: 'must be "auto" or "review"' }).default('auto')
  ),`,
        `  // Safe by default: an entry written by the job waits for an admin unless "auto" is set explicitly (docs/lookup-spec.md §1, §10.3;
  // changed from "auto" in spec 1.5).
  ENRICHMENT_PUBLISH_POLICY: z.preprocess(
    blankToUndefined,
    z.enum(['auto', 'review'], { error: 'must be "auto" or "review"' }).default('review')
  ),`,
      ],
    ],
  },
  {
    file: '.env.example',
    edits: [
      [
        `# auto = publish when tier A is complete; review = always create as unpublished
ENRICHMENT_PUBLISH_POLICY=auto`,
        `# review (the default when unset) = always create as unpublished, an admin publishes it;
# auto = publish when tier A is complete (never the default: it has to be set explicitly)
ENRICHMENT_PUBLISH_POLICY=review`,
      ],
    ],
  },
  {
    file: 'docs/lookup-spec.md',
    edits: [
      [
        `Tệp: docs/lookup-spec.md · Phiên bản 1.4 · 16/10/2026 (1.4: P8`,
        `Tệp: docs/lookup-spec.md · Phiên bản 1.5 · 16/10/2026 (1.5: vá sau P8 — mục 1 và 10.3 ĐỔI MẶC ĐỊNH ENRICHMENT_PUBLISH_POLICY từ auto sang review, mục 5 F11 và F12 chạy nền sau khi đã trả response; 1.4: P8`,
      ],
      [
        `Tên khớp 100% với Phần 1B. Kiểm tra bằng zod ở module cấu hình; sai thì dừng khi khởi động. Boolean nhận true hoặc false.
TRANSLATION_FALLBACK_ENABLED=true
ENRICHMENT_ENABLED=false
ENRICHMENT_WORKER_ENABLED=true
ENRICHMENT_PUBLISH_POLICY=auto`,
        `Tên khớp 100% với Phần 1B. Kiểm tra bằng zod ở module cấu hình; sai thì dừng khi khởi động. Boolean nhận true hoặc false.
TRANSLATION_FALLBACK_ENABLED=true
ENRICHMENT_ENABLED=false
ENRICHMENT_WORKER_ENABLED=true
ENRICHMENT_PUBLISH_POLICY=review`,
      ],
      [
        `REFDATA_DATABASE_URL=
LOOKUP_FAST_TRANSLATOR chỉ nhận`,
        `REFDATA_DATABASE_URL=
THAY ĐỔI SO VỚI BẢN 1.4 trở về trước: mặc định của ENRICHMENT_PUBLISH_POLICY là review (các bản trước ghi auto). Không đặt biến, hoặc để trống, thì mục từ do job tạo luôn có published=false và chờ quản trị viên duyệt. Muốn tự xuất bản khi đủ tầng A phải đặt RÕ ENRICHMENT_PUBLISH_POLICY=auto trong môi trường của tiến trình worker. Giá trị khác auto và review vẫn làm ứng dụng dừng khi khởi động.
LOOKUP_FAST_TRANSLATOR chỉ nhận`,
      ],
      [
        `10.3 published: ENRICHMENT_PUBLISH_POLICY='review' thì false. 'auto' thì true khi đủ tầng A, ngược lại false.`,
        `10.3 published: ENRICHMENT_PUBLISH_POLICY='review' thì false. 'auto' thì true khi đủ tầng A, ngược lại false. Mặc định khi không đặt biến là 'review' (đổi từ 'auto' ở bản 1.5, xem mục 1).`,
      ],
    ],
  },
];
