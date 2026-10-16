export interface WordResult {
  planned: PlannedWord;
  fast: FastObservation | null;
  summary: FastSummary | null;
  formPresent: boolean | null;
  job: JobObservation | null;
  verdicts: { fast: Verdict; form?: Verdict; job: Verdict };
  verdict: Verdict;
}

// ── helpers for the report ──────────────────────────────────────────────────────────────────────────────────────────

export const fmtMs = (ms: number | null | undefined) => (ms === null || ms === undefined || Number.isNaN(ms) ? '-' : String(Math.round(ms)));
export const cell = (v: unknown) => (v === null || v === undefined ? '-' : String(v).replace(/\|/g, '\\|'));
export const verdictLabel = (v: Verdict) => (v.verdict === 'pass' ? 'ĐẠT' : v.verdict === 'fail' ? 'KHÔNG ĐẠT' : v.verdict === 'unevaluable' ? UNEVALUABLE_LABEL : 'BỎ QUA');

export interface ProbeEntry {
  label: string;
  result: ProbeResult;
}

export interface BreakerWait {
  /** the group the run was about to start */
  before: Group;
  /** the group that left the circuit breaker open */
  after: Group;
  waitedMs: number;
}

export interface RunSummary {
  startedAtDb: string;
  identity: DatabaseIdentity;
  baseUrl: string;
  groups: Group[];
  results: WordResult[];
  skipped: SkippedWord[];
  chars?: { before: number; after: number; verdict: Verdict };
  latency: LatencyResult;
  tokens: { anthropicBefore: { input: number; output: number }; anthropicAfter: { input: number; output: number }; jobs: { input: number; output: number; calls: number; costUsd: number | null } };
  waitMinutes: number;
  jobWaitTimedOut: boolean;
  elapsedSec: number;
  /** Free Dictionary probes, in the order they were made (before the run, after a wait, after the fast path) */
  probes: ProbeEntry[];
  waits: BreakerWait[];
  breakerResetMs: number;
  /** the command that runs again only the groups that could not be judged, null when there are none */
  rerun: string | null;
}

export function buildReport(s: RunSummary): string {
  const counts = { pass: 0, fail: 0, skip: 0, unevaluable: 0 };
  for (const r of s.results) counts[r.verdict.verdict]++;
  counts.skip += s.skipped.length;
  const lines: string[] = [];
  lines.push('# WordyGo · Báo cáo nghiệm thu tra từ (P7b)');
  lines.push('');
  lines.push(`Chạy lúc ${s.startedAtDb} (đồng hồ DB) · DB: ${dbLabel(s.identity)} · máy chủ: ${s.baseUrl} · nhóm: ${s.groups.join(', ')} · ENRICHMENT_PUBLISH_POLICY=${s.settings.publishPolicy} · LOOKUP_TOTAL_DEADLINE_MS=${s.settings.totalDeadlineMs} · LOOKUP_FAST_TRANSLATOR=${s.settings.fastTranslator} · tổng thời gian ${Math.round(s.elapsedSec)} s.`);
  lines.push('Tạo bởi `npm run acceptance:lookup`; cách chạy ở `docs/lookup-runbook.md` mục 12. Bảng bên dưới là kết quả ĐO, không chỉnh để cho xanh.');
  lines.push('');
  lines.push('## 1. Tóm tắt');
  lines.push('');
  lines.push(`| Đạt | Không đạt | ${UNEVALUABLE_LABEL} | Bỏ qua (tiền đề sai) |`);
  lines.push('|---|---|---|---|');
  lines.push(`| ${counts.pass} | ${counts.fail} | ${counts.unevaluable} | ${counts.skip} |`);
  lines.push('');
  if (counts.unevaluable > 0) {
    lines.push(`**Lần chạy này CHƯA kết luận hết**: ${counts.unevaluable} từ không đánh giá được vì Free Dictionary lỗi (mục 1.1 và 4.1). Đó không phải đạt và cũng không phải không đạt. Chạy lại riêng các nhóm đó khi nguồn khỏe: \`${s.rerun}\``);
    lines.push('');
  }
  lines.push('| Kiểm tra cấp lần chạy | Kết quả | Chi tiết |');
  lines.push('|---|---|---|');
  if (s.chars) lines.push(`| Nhóm A và B không gọi Google (ký tự không đổi) | ${verdictLabel(s.chars.verdict)} | trước ${s.chars.before}, sau ${s.chars.after}${s.chars.verdict.reasons.length ? `; ${s.chars.verdict.reasons.join('; ')}` : ''} |`);
  lines.push(`| p95 đường nhanh nhóm C, D, E, H ≤ ${s.latency.limitMs} ms | ${verdictLabel(s.latency)} | p50 = ${fmtMs(s.latency.p50)} ms, p95 = ${fmtMs(s.latency.p95)} ms, ${s.latency.samples} mẫu${s.latency.reasons.length ? `; ${s.latency.reasons.join('; ')}` : ''} |`);
  lines.push('');
  lines.push('### 1.1 Free Dictionary trong lần chạy này');
  lines.push('');
  if (s.probes.length === 0) lines.push('Lần chạy không có nhóm nào đi tới Free Dictionary (không thăm dò).');
  else {
    lines.push('Thăm dò gọi THẲNG Free Dictionary (không qua máy chủ, để không làm mạch ngắt của máy chủ nhích), 3 lần liền với một từ mẫu; **khỏe** chỉ khi cả 3 lần trả 200 với danh sách mục từ không rỗng trong LOOKUP_UPSTREAM_TIMEOUT_MS.');
    lines.push('');
    lines.push('| Lúc | Kết luận | Chi tiết 3 lần |');
    lines.push('|---|---|---|');
    for (const p of s.probes) lines.push(`| ${p.label} | ${p.result.healthy ? 'khỏe' : '**KHÔNG KHỎE**'} | ${cell(describeProbe(p.result))} |`);
  }
  lines.push('');
  if (s.waits.length > 0) {
    for (const w of s.waits) lines.push(`* Sau nhóm ${w.after} mạch ngắt Free Dictionary của máy chủ có vẻ đã mở (nhiều lần lỗi liên tiếp): chờ ${Math.round(w.waitedMs / 1000)} s (UPSTREAM_BREAKER_RESET_MS = ${s.breakerResetMs} ms cộng 2 s đệm) trước nhóm ${w.before}.`);
    lines.push('');
  }
  lines.push('Thứ tự chạy: A, B, C, D, **H**, E, F. Nhóm H chạy trước E và F vì E, F là hai nhóm làm Free Dictionary treo nhiều nhất (tên riêng và từ rác không có bản dịch của Google nên phải chờ Free Dictionary hết giờ).');
  lines.push('');
  lines.push('**Quy tắc chấm khi Free Dictionary lỗi** (không sửa đặc tả để hợp thức hóa kết quả, mục 6 của đặc tả giữ nguyên):');
  lines.push('');
  lines.push('* Một ca **503 TRANSLATION_UNAVAILABLE** của nhóm E hoặc F (kể cả từ rác như `asdfghjk`, `xinchao`) là hành vi **ĐÚNG** theo ma trận mục 6: "không G, FDerr → 503". Từ rác không có bản dịch của Google, Free Dictionary treo hoặc lỗi thì máy chủ KHÔNG được bịa ra 404; trả 503 là đúng (**đạt có ghi chú**). Kỳ vọng của nhóm (E: 200, F: 404) không kiểm tra được lúc đó, nên dòng được ghi là "' + UNEVALUABLE_LABEL + '", không phải "không đạt".');
  lines.push('* Nhóm **H** cần các sense của Free Dictionary: nếu một lần thăm dò hoặc mạch ngắt cho thấy nó không khỏe lúc tra, từ H không có sense được ghi là "' + UNEVALUABLE_LABEL + '". Phần job nền của dòng vẫn được chấm riêng: một job sai vẫn là "không đạt".');
  lines.push('* Mọi lỗi khác (sai mã HTTP, sai `source`, thiếu bản dịch…) vẫn là "không đạt" dù Free Dictionary ra sao.');
  lines.push('');
  lines.push('## 2. Đường nhanh (mỗi từ một lần tra)');
  lines.push('');
  lines.push('| Nhóm | Từ | HTTP | source | temporary | matched_form | partial | missing | meanings_vi | senses | enrichment | ms | Kết quả đường nhanh |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of s.results) {
    const f = r.summary!;
    lines.push(
      `| ${r.planned.group} | ${r.planned.word}${r.planned.standsInFor ? ` (thay ${r.planned.standsInFor})` : ''} | ${f.status}${f.errorCode ? ` ${f.errorCode}` : ''}${r.fast?.retriedAfter429 ? ' (sau 429)' : ''} | ${cell(f.source)} | ${cell(f.temporary)} | ${cell(f.matchedForm)} | ${cell(f.partial)} | ${cell(f.missing.join(','))} | ${cell(f.meaningsCount)} | ${cell(f.sensesCount)} | ${cell(f.enrichmentStatus)} | ${fmtMs(f.ms)} | ${verdictLabel(r.verdicts.fast)} |`
    );
  }
  lines.push('');
  lines.push('## 3. Job nền và dữ liệu đã ghi');
  lines.push('');
  lines.push(`Chờ tối đa ${s.waitMinutes} phút${s.jobWaitTimedOut ? ' (**ĐÃ HẾT HẠN CHỜ**, còn job chưa xong)' : ''}.`);
  lines.push('');
  lines.push('| Nhóm | Từ | Kỳ vọng | Job | reason | Mục từ | published | sense | ví dụ | meaning_vi | Kết quả job |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of s.results) {
    const j = r.job!;
    const row = j.rows[0];
    const e = j.entry;
    lines.push(
      `| ${r.planned.group} | ${r.planned.word} | ${jobExpectation(r.planned.group, r.planned.word)}${r.formPresent !== null ? `; word_forms ${r.formPresent ? 'có' : 'KHÔNG'}` : ''} | ${row ? row.status : 'không có'} | ${cell(row?.reason)} | ${e ? 'có' : j.headwordEntryExists ? 'có (có từ trước lần chạy)' : 'không'} | ${e ? e.published : '-'} | ${e ? e.senseCount : '-'} | ${e ? e.exampleCount : '-'} | ${e ? cell((e.meaningVi ?? '').slice(0, 60)) : '-'} | ${verdictLabel(r.verdicts.job)} |`
    );
  }
  lines.push('');
  lines.push('## 4. Từ KHÔNG ĐẠT, nguyên nhân');
  lines.push('');
  const failed = s.results.filter((r) => r.verdict.verdict === 'fail');
  if (failed.length === 0) lines.push('Không có.');
  else {
    lines.push('| Nhóm | Từ | Nguyên nhân |');
    lines.push('|---|---|---|');
    for (const r of failed) lines.push(`| ${r.planned.group} | ${r.planned.word} | ${r.verdict.reasons.map((x) => cell(x)).join('<br>')} |`);
  }
  lines.push('');
  lines.push(`### 4.1 Từ "${UNEVALUABLE_LABEL}"`);
  lines.push('');
  const unevaluable = s.results.filter((r) => r.verdict.verdict === 'unevaluable');
  if (unevaluable.length === 0) lines.push('Không có.');
  else {
    lines.push('| Nhóm | Từ | Vì sao không chấm được |');
    lines.push('|---|---|---|');
    for (const r of unevaluable) lines.push(`| ${r.planned.group} | ${r.planned.word} | ${r.verdict.reasons.map((x) => cell(x)).join('<br>')} |`);
    lines.push('');
    lines.push(`Chạy lại riêng khi Free Dictionary khỏe (cần thêm từ mới cho nhóm H: các từ H đã chạy đã có mục từ do job tạo, nên script dùng từ dự phòng):`);
    lines.push('');
    lines.push('```bash');
    lines.push(s.rerun ?? '');
    lines.push('```');
  }
  lines.push('');
  lines.push('## 5. Từ BỎ QUA (tiền đề sai)');
  lines.push('');
  if (s.skipped.length === 0) lines.push('Không có.');
  else {
    lines.push('| Nhóm | Từ | Lý do |');
    lines.push('|---|---|---|');
    for (const k of s.skipped) lines.push(`| ${k.group} | ${k.word} | ${cell(k.reason)} |`);
    const standIns = s.results.filter((r) => r.planned.standsInFor);
    if (standIns.length > 0) lines.push('', `Từ dự phòng đã chạy: ${standIns.map((r) => `${r.planned.word} (thay ${r.planned.standsInFor})`).join(', ')}.`);
  }
  lines.push('');
  lines.push('## 6. Token và chi phí của lần chạy');
  lines.push('');
  const t = s.tokens;
  lines.push('| Đại lượng | Giá trị |');
  lines.push('|---|---|');
  lines.push(`| \`api_usage_counters\` anthropic (tháng ${utcMonth()}) tăng | vào ${t.anthropicAfter.input - t.anthropicBefore.input}, ra ${t.anthropicAfter.output - t.anthropicBefore.output} |`);
  lines.push(`| Cộng từ hàng job (${t.jobs.calls} job có gọi Haiku) | vào ${t.jobs.input}, ra ${t.jobs.output} |`);
  lines.push(`| Chi phí ước tính | ${t.jobs.costUsd === null ? 'n/a' : `$${t.jobs.costUsd.toFixed(5)}`} |`);
  lines.push('');
  lines.push(`Chi phí là ƯỚC TÍNH từ bảng giá nhập tay ngày ${PRICING_CHECKED_ON} (\`services/enrichment/pricing.ts\`, phải xác minh lại), giả định mỗi job đọc 7.859 token system prompt từ cache còn phần vào còn lại tính đầy đủ; hàng job chỉ lưu tổng token đầu vào nên không tách được chính xác (ghi cache, lần sửa). Token vào gồm cả ghi và đọc cache. Chi phí Google chỉ biết số ký tự (mục 1), không quy ra tiền.`);
  lines.push('');
  return lines.join('\n') + '\n';
}