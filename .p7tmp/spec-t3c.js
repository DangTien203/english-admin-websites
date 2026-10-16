module.exports = [
  {
    file: 'scripts/acceptance/lookup-acceptance.ts',
    edits: [
      // ── imports ─────────────────────────────────────────────────────────────────────────────────────────────
      [
        `  evaluateLatency,
  summarizeFast,
  TERMINAL_JOB_STATUSES,
  type EntryObservation,`,
        `  evaluateLatency,
  reclassifyForSource,
  summarizeFast,
  TERMINAL_JOB_STATUSES,
  UNEVALUABLE_LABEL,
  type EntryObservation,`,
      ],
      [
        `import { checkPrecondition, GROUP_ORDER, GROUP_TITLES, GROUP_WORDS, FALLBACK_WORDS, jobExpectation, MISS_GROUPS, planWords, type Group, type PlannedWord, type SkippedWord, type WordFacts } from './words';`,
        `import { breakerLikelyOpen, breakerWaitMs, describeProbe, fdFailureEvidence, probeFreeDictionary, rerunCommand, sourceHealthFor, type ProbeResult } from './source';
import { checkPrecondition, GROUP_ORDER, GROUP_TITLES, GROUP_WORDS, FALLBACK_WORDS, jobExpectation, MISS_GROUPS, planWords, type Group, type PlannedWord, type SkippedWord, type WordFacts } from './words';`,
      ],
      // ── verdict label, run summary ──────────────────────────────────────────────────────────────────────────
      [
        `const verdictLabel = (v: Verdict) => (v.verdict === 'pass' ? 'ĐẠT' : v.verdict === 'fail' ? 'KHÔNG ĐẠT' : 'BỎ QUA');`,
        `const verdictLabel = (v: Verdict) => (v.verdict === 'pass' ? 'ĐẠT' : v.verdict === 'fail' ? 'KHÔNG ĐẠT' : v.verdict === 'unevaluable' ? UNEVALUABLE_LABEL : 'BỎ QUA');

interface ProbeEntry {
  label: string;
  result: ProbeResult;
}

interface BreakerWait {
  /** the group the run was about to start */
  before: Group;
  /** the group that left the circuit breaker open */
  after: Group;
  waitedMs: number;
}`,
      ],
      [
        `  waitMinutes: number;
  jobWaitTimedOut: boolean;
  elapsedSec: number;
}`,
        `  waitMinutes: number;
  jobWaitTimedOut: boolean;
  elapsedSec: number;
  /** Free Dictionary probes, in the order they were made (before the run, after a wait, after the fast path) */
  probes: ProbeEntry[];
  waits: BreakerWait[];
  breakerResetMs: number;
  /** the command that runs again only the groups that could not be judged, null when there are none */
  rerun: string | null;
}`,
      ],
      // ── the report ──────────────────────────────────────────────────────────────────────────────────────────
      [
        `  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const r of s.results) counts[r.verdict.verdict]++;
  counts.skip += s.skipped.length;`,
        `  const counts = { pass: 0, fail: 0, skip: 0, unevaluable: 0 };
  for (const r of s.results) counts[r.verdict.verdict]++;
  counts.skip += s.skipped.length;`,
      ],
      [
        `  lines.push(\`| Đạt | Không đạt | Bỏ qua (tiền đề sai) |\`);
  lines.push('|---|---|---|');
  lines.push(\`| \${counts.pass} | \${counts.fail} | \${counts.skip} |\`);
  lines.push('');`,
        `  lines.push(\`| Đạt | Không đạt | \${UNEVALUABLE_LABEL} | Bỏ qua (tiền đề sai) |\`);
  lines.push('|---|---|---|---|');
  lines.push(\`| \${counts.pass} | \${counts.fail} | \${counts.unevaluable} | \${counts.skip} |\`);
  lines.push('');
  if (counts.unevaluable > 0) {
    lines.push(\`**Lần chạy này CHƯA kết luận hết**: \${counts.unevaluable} từ không đánh giá được vì Free Dictionary lỗi (mục 1.1 và 4.1). Đó không phải đạt và cũng không phải không đạt. Chạy lại riêng các nhóm đó khi nguồn khỏe: \\\`\${s.rerun}\\\`\`);
    lines.push('');
  }`,
      ],
      [
        `  lines.push('');
  lines.push('## 2. Đường nhanh (mỗi từ một lần tra)');`,
        `  lines.push('');
  lines.push('### 1.1 Free Dictionary trong lần chạy này');
  lines.push('');
  if (s.probes.length === 0) lines.push('Lần chạy không có nhóm nào đi tới Free Dictionary (không thăm dò).');
  else {
    lines.push('Thăm dò gọi THẲNG Free Dictionary (không qua máy chủ, để không làm mạch ngắt của máy chủ nhích), 3 lần liền với một từ mẫu; **khỏe** chỉ khi cả 3 lần trả 200 với danh sách mục từ không rỗng trong LOOKUP_UPSTREAM_TIMEOUT_MS.');
    lines.push('');
    lines.push('| Lúc | Kết luận | Chi tiết 3 lần |');
    lines.push('|---|---|---|');
    for (const p of s.probes) lines.push(\`| \${p.label} | \${p.result.healthy ? 'khỏe' : '**KHÔNG KHỎE**'} | \${cell(describeProbe(p.result))} |\`);
  }
  lines.push('');
  if (s.waits.length > 0) {
    for (const w of s.waits) lines.push(\`* Sau nhóm \${w.after} mạch ngắt Free Dictionary của máy chủ có vẻ đã mở (nhiều lần lỗi liên tiếp): chờ \${Math.round(w.waitedMs / 1000)} s (UPSTREAM_BREAKER_RESET_MS = \${s.breakerResetMs} ms cộng 2 s đệm) trước nhóm \${w.before}.\`);
    lines.push('');
  }
  lines.push('Thứ tự chạy: A, B, C, D, **H**, E, F. Nhóm H chạy trước E và F vì E, F là hai nhóm làm Free Dictionary treo nhiều nhất (tên riêng và từ rác không có bản dịch của Google nên phải chờ Free Dictionary hết giờ).');
  lines.push('');
  lines.push('**Quy tắc chấm khi Free Dictionary lỗi** (không sửa đặc tả để hợp thức hóa kết quả, mục 6 của đặc tả giữ nguyên):');
  lines.push('');
  lines.push('* Một ca **503 TRANSLATION_UNAVAILABLE** của nhóm E hoặc F (kể cả từ rác như \`asdfghjk\`, \`xinchao\`) là hành vi **ĐÚNG** theo ma trận mục 6: "không G, FDerr → 503". Từ rác không có bản dịch của Google, Free Dictionary treo hoặc lỗi thì máy chủ KHÔNG được bịa ra 404; trả 503 là đúng (**đạt có ghi chú**). Kỳ vọng của nhóm (E: 200, F: 404) không kiểm tra được lúc đó, nên dòng được ghi là "\${UNEVALUABLE_LABEL}", không phải "không đạt".');
  lines.push('* Nhóm **H** cần các sense của Free Dictionary: nếu một lần thăm dò hoặc mạch ngắt cho thấy nó không khỏe lúc tra, từ H không có sense được ghi là "\${UNEVALUABLE_LABEL}". Phần job nền của dòng vẫn được chấm riêng: một job sai vẫn là "không đạt".');
  lines.push('* Mọi lỗi khác (sai mã HTTP, sai \`source\`, thiếu bản dịch…) vẫn là "không đạt" dù Free Dictionary ra sao.');
  lines.push('');
  lines.push('## 2. Đường nhanh (mỗi từ một lần tra)');`,
      ],
      [
        `  else {
    lines.push('| Nhóm | Từ | Nguyên nhân |');
    lines.push('|---|---|---|');
    for (const r of failed) lines.push(\`| \${r.planned.group} | \${r.planned.word} | \${r.verdict.reasons.map((x) => cell(x)).join('<br>')} |\`);
  }
  lines.push('');`,
        `  else {
    lines.push('| Nhóm | Từ | Nguyên nhân |');
    lines.push('|---|---|---|');
    for (const r of failed) lines.push(\`| \${r.planned.group} | \${r.planned.word} | \${r.verdict.reasons.map((x) => cell(x)).join('<br>')} |\`);
  }
  lines.push('');
  lines.push(\`### 4.1 Từ "\${UNEVALUABLE_LABEL}"\`);
  lines.push('');
  const unevaluable = s.results.filter((r) => r.verdict.verdict === 'unevaluable');
  if (unevaluable.length === 0) lines.push('Không có.');
  else {
    lines.push('| Nhóm | Từ | Vì sao không chấm được |');
    lines.push('|---|---|---|');
    for (const r of unevaluable) lines.push(\`| \${r.planned.group} | \${r.planned.word} | \${r.verdict.reasons.map((x) => cell(x)).join('<br>')} |\`);
    lines.push('');
    lines.push(\`Chạy lại riêng khi Free Dictionary khỏe (cần thêm từ mới cho nhóm H: các từ H đã chạy đã có mục từ do job tạo, nên script dùng từ dự phòng):\`);
    lines.push('');
    lines.push('\`\`\`bash');
    lines.push(s.rerun ?? '');
    lines.push('\`\`\`');
  }
  lines.push('');`,
      ],
      // ── the run: probe, order, breaker, contexts ────────────────────────────────────────────────────────────
      [
        `  console.log('\\n── đường nhanh ──');
  for (const planned of plan.run) {`,
        `  // ── Free Dictionary: probe it directly before anything is looked up ──
  const usesFd = plan.run.some((p) => MISS_GROUPS.has(p.group));
  const probes: ProbeEntry[] = [];
  const waits: BreakerWait[] = [];
  const probe = async (label: string): Promise<ProbeResult> => {
    const result = await probeFreeDictionary(lookupConfig.freeDictionary.baseUrl, lookupConfig.lookup.upstreamTimeoutMs);
    probes.push({ label, result });
    console.log(\`  thăm dò Free Dictionary (\${label}): \${result.healthy ? 'KHỎE' : 'KHÔNG KHỎE'} - \${describeProbe(result)}\`);
    return result;
  };
  if (usesFd) {
    console.log('\\n── thăm dò Free Dictionary ──');
    const first = await probe('trước khi chạy');
    if (!first.healthy) console.warn(\`  CẢNH BÁO: Free Dictionary không khỏe. Nhóm H và các ca 503 của nhóm E, F sẽ được ghi là "\${UNEVALUABLE_LABEL}", không phải "không đạt".\`);
  }
  // One entry per lookup that reached Free Dictionary: did it fail? (the end of this list is how the circuit breaker of the server is guessed)
  const fdHistory: boolean[] = [];
  let lastEvidenceAt = 0;
  let previousGroup: Group | null = null;
  const contextOf = new Map<string, { probeHealthy: boolean | null; breakerOpen: boolean }>();

  console.log('\\n── đường nhanh ──');
  for (const planned of plan.run) {
    // The group before left the circuit breaker of Free Dictionary open? Let it close (UPSTREAM_BREAKER_RESET_MS) before the next group,
    // and look again: a group judged while the breaker is open measures the breaker, not the word.
    if (previousGroup !== null && previousGroup !== planned.group && MISS_GROUPS.has(planned.group) && breakerLikelyOpen(fdHistory, lookupConfig.breaker.failureThreshold)) {
      const waitMs = breakerWaitMs(lastEvidenceAt, Date.now(), lookupConfig.breaker.resetMs);
      console.log(\`  Free Dictionary có vẻ đang bị ngắt mạch sau nhóm \${previousGroup}: chờ \${Math.round(waitMs / 1000)} s (UPSTREAM_BREAKER_RESET_MS=\${lookupConfig.breaker.resetMs}) trước nhóm \${planned.group}\`);
      await sleep(waitMs);
      waits.push({ before: planned.group, after: previousGroup, waitedMs: waitMs });
      await probe(\`sau nhóm \${previousGroup}\`);
      fdHistory.length = 0; // the breaker has had its time: the next lookup is its trial
    }
    previousGroup = planned.group;
    contextOf.set(planned.word, { probeHealthy: probes.length > 0 ? probes[probes.length - 1].result.healthy : null, breakerOpen: breakerLikelyOpen(fdHistory, lookupConfig.breaker.failureThreshold) });
`,
      ],
      [
        `    const obs = await lookup(baseUrl, token, creds, planned.word);
    observations.set(planned.word, obs);
    const f = summarizeFast(obs);`,
        `    const obs = await lookup(baseUrl, token, creds, planned.word);
    observations.set(planned.word, obs);
    if (MISS_GROUPS.has(planned.group)) {
      const failed = fdFailureEvidence(planned.group, obs);
      fdHistory.push(failed);
      if (failed) lastEvidenceAt = Date.now();
    }
    const f = summarizeFast(obs);`,
      ],
      [
        `  // ── word_forms rows of group B (written in the background) ──`,
        `  // ── Free Dictionary once more, now that the fast path is over (decides the words that ran while it was struggling) ──
  const endProbe = usesFd ? await probe('sau lượt tra') : null;

  // ── word_forms rows of group B (written in the background) ──`,
      ],
      // ── evaluation ──────────────────────────────────────────────────────────────────────────────────────────
      [
        `    const fastV = evaluateFast(planned.group, planned.word, obs);`,
        `    const at = contextOf.get(planned.word) ?? { probeHealthy: null, breakerOpen: false };
    const fastV = reclassifyForSource(planned.group, obs, evaluateFast(planned.group, planned.word, obs), sourceHealthFor(at, endProbe ? endProbe.result.healthy : null));`,
      ],
      [
        `  const chars = charsBefore !== null && charsAfter !== null ?`,
        `  const unevaluableGroups = new Set(results.filter((r) => r.verdict.verdict === 'unevaluable').map((r) => r.planned.group));
  const rerun = unevaluableGroups.size > 0 ? rerunCommand(unevaluableGroups, baseUrl) : null;
  const chars = charsBefore !== null && charsAfter !== null ?`,
      ],
      [
        `    waitMinutes,
    jobWaitTimedOut: timedOut,
    elapsedSec: (Date.now() - started) / 1000,
  };`,
        `    waitMinutes,
    jobWaitTimedOut: timedOut,
    elapsedSec: (Date.now() - started) / 1000,
    probes,
    waits,
    breakerResetMs: lookupConfig.breaker.resetMs,
    rerun,
  };`,
      ],
      // ── the end of the run ──────────────────────────────────────────────────────────────────────────────────
      [
        `  const pass = results.filter((r) => r.verdict.verdict === 'pass').length;
  const fail = results.filter((r) => r.verdict.verdict === 'fail').length;
  console.log(\`\\nĐẠT \${pass}  KHÔNG ĐẠT \${fail}  BỎ QUA \${plan.skipped.length}   báo cáo: \${path.relative(process.cwd(), reportPath)}\`);
  return fail > 0 || chars?.verdict.verdict === 'fail' || latency.verdict === 'fail' ? 1 : 0;`,
        `  const pass = results.filter((r) => r.verdict.verdict === 'pass').length;
  const fail = results.filter((r) => r.verdict.verdict === 'fail').length;
  const unevaluableCount = results.filter((r) => r.verdict.verdict === 'unevaluable').length;
  console.log(\`\\nĐẠT \${pass}  KHÔNG ĐẠT \${fail}  KHÔNG ĐÁNH GIÁ ĐƯỢC \${unevaluableCount}  BỎ QUA \${plan.skipped.length}   báo cáo: \${path.relative(process.cwd(), reportPath)}\`);
  if (rerun) console.log(\`Có \${unevaluableCount} từ không đánh giá được vì nguồn ngoài lỗi (không phải lỗi của mã). Chạy lại riêng khi Free Dictionary khỏe:\\n  \${rerun}\`);
  // 1 = something failed; 3 = nothing failed but the run did not reach a verdict on every word (so it must not be read as a pass)
  if (fail > 0 || chars?.verdict.verdict === 'fail' || latency.verdict === 'fail') return 1;
  return unevaluableCount > 0 ? 3 : 0;`,
      ],
    ],
  },
];
