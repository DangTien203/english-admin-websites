import {
  EXAMPLE_VI_MAX_CHARS,
  SENSE_MEANING_MAX_CHARS,
  SENSE_VI_MAX_CHARS,
  SENSE_VI_MAX_MEANINGS,
  breakerLevel,
  usageLevel,
  type BreakerLevel,
  type UsageLevel,
} from '../services/lookup/adminRules';

/**
 * Small helpers for the views of the lookup / enrichment admin (views/lookup/*.ejs): Vietnamese labels for the codes the job
 * writes, badge colours, number and date formats. Passed to the templates as `lk`. Pure; no database.
 */

export const STATUS_LABELS: Record<string, string> = {
  queued: 'Đang chờ',
  running: 'Đang chạy',
  succeeded: 'Thành công',
  rejected: 'Bị từ chối',
  failed: 'Lỗi',
  skipped: 'Bỏ qua',
};

const STATUS_BADGES: Record<string, string> = {
  queued: 'badge-info',
  running: 'badge-primary',
  succeeded: 'badge-success',
  rejected: 'badge-warning',
  failed: 'badge-danger',
  skipped: 'badge-secondary',
};

/** docs/lookup-enrichment.md §11 and docs/lookup-queue.md §9. */
export const REASON_LABELS: Record<string, string> = {
  form_linked: 'Đã nối dạng biến vào mục từ gốc',
  exists: 'Đã có mục từ',
  variant_form: 'Lỗi chính tả hoặc dạng lỗi thời',
  lemma_mismatch: 'Dạng gốc khác từ tra, cần xử lý tay',
  budget: 'Hết ngân sách Anthropic',
  daily_cap: 'Hết trần job trong ngày',
  duplicate: 'Đã có job cho từ này',
  unknown_word: 'Không nguồn nào nhận ra từ',
  proper_noun: 'Tên riêng',
  not_english: 'Không phải từ tiếng Anh',
  invalid_output: 'Đầu ra của mô hình sai',
  config_error: 'Sai cấu hình hoặc khóa API',
  upstream_error: 'Dịch vụ ngoài lỗi',
  dead_letter: 'Hết số lần thử',
  stale: 'Treo quá lâu',
  queue_error: 'Lỗi hàng đợi',
  invalid_word: 'Từ không hợp lệ',
  pipeline_not_ready: 'Đường ống chưa sẵn sàng (cũ)',
};

export const PROVIDER_LABELS: Record<string, string> = {
  google_translate: 'Google Dịch',
  free_dictionary: 'Free Dictionary',
  datamuse: 'Datamuse',
  anthropic: 'Anthropic (làm giàu)',
  anthropic_fast: 'Anthropic (tra nhanh)',
};

export const BREAKER_LABELS: Record<string, string> = {
  closed: 'Đóng (bình thường)',
  half_open: 'Nửa mở (đang thử lại)',
  open: 'Mở (đang bỏ qua nguồn này)',
};

export const SKIP_LABELS: Record<string, string> = {
  not_found: 'Không tìm thấy',
  not_auto: 'Không phải mục từ tự tạo',
  already_published: 'Đã xuất bản',
  tier_a_incomplete: 'Thiếu trường bắt buộc (tầng A)',
  has_review_notes: 'Có ghi chú cần xem của Haiku',
};

const LEVEL_CLASS: Record<UsageLevel | BreakerLevel, string> = {
  ok: 'lk-ok',
  warn: 'lk-warn',
  critical: 'lk-critical',
  unknown: 'lk-unknown',
};

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The field_name of an entry_edit_history line, in words. The edits of a sense are named after the sense
 * ("sense:<sense id>:definition_vi", "sense:<sense id>:example_vi:<example id>"); the full name stays in the title of the cell.
 */
export function historyField(name: string | null | undefined): string {
  const field = String(name ?? '');
  const sense = /^sense:([0-9a-f]{8})-[0-9a-f-]{27}:(definition_vi|example_vi)(?::([0-9a-f]{8})-[0-9a-f-]{27})?$/i.exec(field);
  if (!sense) return field;
  return sense[2] === 'definition_vi' ? `nghĩa tiếng Việt của sense …${sense[1]}` : `dịch ví dụ của sense …${sense[1]}`;
}

/** Limits the edit form of a sense tells the admin about (the same numbers the API enforces). */
const limits = {
  senseViMax: SENSE_VI_MAX_CHARS,
  senseViMaxMeanings: SENSE_VI_MAX_MEANINGS,
  senseMeaningMax: SENSE_MEANING_MAX_CHARS,
  exampleViMax: EXAMPLE_VI_MAX_CHARS,
};

export const lk = {
  /** every code the job can write, for the filter */
  reasonCodes: Object.keys(REASON_LABELS),
  statusLabel: (s: string) => STATUS_LABELS[s] ?? s,
  statusBadge: (s: string) => STATUS_BADGES[s] ?? 'badge-secondary',
  reasonLabel: (r: string | null | undefined) => (r ? (REASON_LABELS[r] ?? r) : ''),
  providerLabel: (p: string) => PROVIDER_LABELS[p] ?? p,
  breakerLabel: (s: string) => BREAKER_LABELS[s] ?? s,
  skipLabel: (r: string) => SKIP_LABELS[r] ?? r,
  usageLevel,
  breakerLevel,
  historyField,
  limits,
  levelClass: (level: UsageLevel | BreakerLevel) => LEVEL_CLASS[level] ?? 'lk-unknown',
  /** 12.345.678 (vi-VN grouping, fixed so the page does not depend on the server's locale) */
  num: (n: number | string | null | undefined) => (n === null || n === undefined || n === '' ? '—' : Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')),
  percent: (used: number, limit: number) => (limit > 0 ? `${Math.min(999, Math.round((used / limit) * 100))}%` : '—'),
  /** dd/mm/yyyy HH:mm in UTC+7 (the admins are in Vietnam; the database keeps UTC) */
  date: (d: Date | string | null | undefined) => {
    if (!d) return '—';
    const t = new Date(d);
    if (Number.isNaN(t.getTime())) return '—';
    const v = new Date(t.getTime() + 7 * 60 * 60 * 1000);
    return `${pad(v.getUTCDate())}/${pad(v.getUTCMonth() + 1)}/${v.getUTCFullYear()} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  },
};

export type Lk = typeof lk;
