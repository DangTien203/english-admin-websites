/**
 * Text of the dry run of `enrich:seed-oxford` (Vietnamese, like the other command-line tools). Pure: takes numbers, returns lines.
 */
import { CEFR_LEVELS, coverageOf } from './list';
import { formatDuration, usd, type Estimate, type ExclusionReason, type SeedPlan } from './plan';
import type { Check } from './send';

const REASON_LABEL: Record<ExclusionReason, string> = {
  in_dictionary: 'đã có trong dictionary_entries (headword hoặc lemma, kể cả published = false)',
  in_word_forms: 'đã là một dạng biến trong word_forms',
  in_queue: 'đang nằm trong hàng đợi (queued / running)',
  done_before: 'đã có kết quả cuối từ lần trước (không gửi lại để khỏi tốn token)',
};

const count = (n: number): string => n.toLocaleString('en-US');

export function levelCounts(words: ReadonlyArray<{ cefr: string | null }>): string {
  const parts: string[] = CEFR_LEVELS.map((l) => [l, words.filter((w) => w.cefr === l).length] as const)
    .filter(([, n]) => n > 0)
    .map(([l, n]) => `${l} ${count(n)}`);
  const none = words.filter((w) => w.cefr === null).length;
  if (none > 0) parts.push(`không có mức ${count(none)}`);
  return parts.length > 0 ? parts.join(', ') : '(không có)';
}

export function formatPlan(plan: SeedPlan, estimate: Estimate, o: { fileName: string; selectionText: string; checks?: Check[]; confirmed: boolean }): string[] {
  const p = plan.parsed;
  const out: string[] = [];
  out.push(`File: ${o.fileName} · ${count(p.rows)} dòng · ${count(p.distinctWords)} từ khác nhau (chữ thường)`);
  out.push(
    `  Gộp dòng trùng: ${count(p.mergedExtraRows)} dòng thừa của ${count(p.mergedWords)} từ; ${count(p.multiLevelWords)} từ có nhiều mức CEFR (lấy mức THẤP NHẤT); ${count(p.rowsWithoutLevel)} dòng không có mức CEFR hợp lệ`
  );
  out.push(`  Chỉ đọc: từ, loại từ, mức CEFR. Định nghĩa, ví dụ, IPA, audio của Oxford KHÔNG được đưa vào (IPA và audio chỉ được đếm bên dưới).`);

  out.push('');
  out.push(`Bị bộ làm sạch đầu vào (cùng bộ với đường tra cứu) từ chối: ${count(p.invalid.length)} từ`);
  for (const w of p.invalid) out.push(`  - ${w.word}  (${w.category === 'multi_word' ? 'nhiều từ' : 'ký tự lạ'})`);

  out.push('');
  out.push(`Từ hợp lệ: ${count(p.words.length)}`);
  const byReason = new Map<ExclusionReason, number>();
  for (const e of plan.excluded) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
  for (const reason of Object.keys(REASON_LABEL) as ExclusionReason[]) {
    if (byReason.has(reason)) out.push(`  loại: ${count(byReason.get(reason)!)} ${REASON_LABEL[reason]}`);
  }
  const before = new Map<string, number>();
  for (const e of plan.excluded) if (e.reason === 'done_before') before.set(e.detail ?? '?', (before.get(e.detail ?? '?') ?? 0) + 1);
  for (const [detail, n] of before) out.push(`        ${detail}: ${count(n)}`);
  out.push(`  còn có thể gửi: ${count(plan.eligible.length)}  (${levelCounts(plan.eligible)})`);

  out.push('');
  out.push(`Lần chạy này (${o.selectionText}): ${count(plan.selected.length)} từ  (${levelCounts(plan.selected)})`);
  const pos = new Map<string, number>();
  for (const w of plan.selected) pos.set(w.primaryPos ?? '(không rõ)', (pos.get(w.primaryPos ?? '(không rõ)') ?? 0) + 1);
  if (pos.size > 0) out.push(`  loại từ: ${[...pos.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (plan.selected.length > 0) {
    const preview = plan.selected.slice(0, 40).map((w) => `${w.word}${w.cefr ? ` ${w.cefr}` : ''}`);
    out.push(`  thứ tự gửi (CEFR tăng dần, rồi tần suất): ${preview.join(', ')}${plan.selected.length > 40 ? ', …' : ''}`);
  }

  const cov = coverageOf(p.words);
  out.push('');
  out.push(`Độ phủ của file (từ hợp lệ, chỉ đếm): IPA ${count(cov.ipa)}/${count(cov.words)} · audio US ${count(cov.audioUs)}/${count(cov.words)} · audio UK ${count(cov.audioUk)}/${count(cov.words)}. Không đưa vào mục từ ở bước này.`);

  out.push('');
  out.push('Ước tính cho lần chạy này:');
  const costNote =
    estimate.costSource === 'history'
      ? `trung bình thật của ${count(estimate.historyJobs)} job đã gọi Haiku (giả định ${count(7859)} token system prompt đọc từ cache mỗi job)`
      : 'ƯỚC TÍNH: chưa đủ lịch sử, dùng 0,00085 USD/từ (docs/lookup-runbook.md §10.3)';
  out.push(`  chi phí:   ${usd(estimate.costUsd)}  (${usd(estimate.costPerWordUsd)}/từ; ${costNote}; chưa tính lần thử lại và bảng giá nhập tay phải được xác minh lại)`);
  out.push(
    `  thời gian: ${formatDuration(estimate.workerSeconds)} cho worker  (${Math.round(estimate.secondsPerWord)} giây/từ ${estimate.timeSource === 'history' ? 'theo trung vị thật' : 'ƯỚC TÍNH'}, đồng thời ${estimate.concurrency}); cộng thời gian gửi vào hàng đợi (khoảng 1 đến 2 giây/từ với DB ở xa)`
  );
  out.push(
    `  số ngày:   ${Number.isFinite(estimate.days) ? estimate.days : 'không xác định'}  (ENRICHMENT_MAX_JOBS_PER_DAY = ${count(estimate.dailyCap)}, hôm nay (UTC) đã dùng ${count(estimate.usedToday)})`
  );

  if (o.checks) {
    out.push('');
    out.push('Kiểm tra trước khi chạy:');
    for (const c of o.checks) out.push(`  [${c.ok ? 'ĐẠT' : 'KHÔNG ĐẠT'}] ${c.name}: ${c.detail}`);
  }

  if (!o.confirmed) {
    out.push('');
    out.push('CHƯA GỬI GÌ (chạy thử). Để gửi thật: thêm --confirm.');
  }
  return out;
}
