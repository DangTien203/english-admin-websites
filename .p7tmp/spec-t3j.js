module.exports = [
  {
    file: 'scripts/acceptance/report.ts',
    edits: [
      [
        `  waits: BreakerWait[];
  /** group H words`,
        `  waits: BreakerWait[];
  /** words NOT run because Free Dictionary was not answering at the start (group H: a run could not be judged and would use up the word) */
  deferred: SkippedWord[];
  /** group H words`,
      ],
      [
        `  counts.skip += s.skipped.length;`,
        `  counts.skip += s.skipped.length;
  counts.unevaluable += s.deferred.length;`,
      ],
      [
        `  const unevaluable = s.results.filter((r) => r.verdict.verdict === 'unevaluable');
  if (unevaluable.length === 0) lines.push('Không có.');
  else {
    lines.push('| Nhóm | Từ | Vì sao không chấm được |');
    lines.push('|---|---|---|');
    for (const r of unevaluable) lines.push(\`| \${r.planned.group} | \${r.planned.word} | \${r.verdict.reasons.map((x) => cell(x)).join('<br>')} |\`);`,
        `  const unevaluable = s.results.filter((r) => r.verdict.verdict === 'unevaluable');
  if (unevaluable.length === 0 && s.deferred.length === 0) lines.push('Không có.');
  else {
    lines.push('| Nhóm | Từ | Vì sao không chấm được |');
    lines.push('|---|---|---|');
    for (const r of unevaluable) lines.push(\`| \${r.planned.group} | \${r.planned.word} | \${r.verdict.reasons.map((x) => cell(x)).join('<br>')} |\`);
    for (const d of s.deferred) lines.push(\`| \${d.group} | \${d.word} | \${cell(d.reason)} |\`);`,
      ],
    ],
  },
  {
    file: 'scripts/acceptance/lookup-acceptance.ts',
    edits: [
      [
        `  // One entry per lookup that reached Free Dictionary: did it fail?`,
        `  // Free Dictionary is not answering: group H cannot be judged, and running it would only use up its words (each run leaves an entry
  // behind) and ask more of a service that is struggling. The words are listed as "not judged" with the command that runs them later.
  const deferred: SkippedWord[] = [];
  if (probes.length > 0 && !probes[0].result.healthy) {
    for (const p of plan.run.filter((x) => x.group === 'H')) {
      deferred.push({ group: 'H', word: p.word, reason: \`\${UNEVALUABLE_LABEL}: chưa chạy vì Free Dictionary không trả lời lúc bắt đầu (từ giữ nguyên cho lần chạy lại)\` });
    }
    plan.run = plan.run.filter((x) => x.group !== 'H');
    if (deferred.length > 0) console.warn(\`  Không chạy nhóm H (\${deferred.length} từ): \${UNEVALUABLE_LABEL}. Chạy lại khi Free Dictionary khỏe.\`);
  }
  // One entry per lookup that reached Free Dictionary: did it fail?`,
      ],
      [
        `  const unevaluableGroups = new Set(results.filter((r) => r.verdict.verdict === 'unevaluable').map((r) => r.planned.group));`,
        `  const unevaluableGroups = new Set<Group>([...results.filter((r) => r.verdict.verdict === 'unevaluable').map((r) => r.planned.group), ...deferred.map((d) => d.group)]);`,
      ],
      [
        `    probes,
    waits,
    wordChecks,`,
        `    probes,
    waits,
    deferred,
    wordChecks,`,
      ],
      [
        `  const unevaluableCount = results.filter((r) => r.verdict.verdict === 'unevaluable').length;`,
        `  const unevaluableCount = results.filter((r) => r.verdict.verdict === 'unevaluable').length + deferred.length;`,
      ],
    ],
  },
  {
    file: 'tests/acceptance/report.test.ts',
    edits: [
      [
        `    waits: [],
    wordChecks: [],`,
        `    waits: [],
    deferred: [],
    wordChecks: [],`,
      ],
      [
        `describe('buildReport — group H words asked about again', () => {`,
        `describe('buildReport — group H not run because Free Dictionary was down at the start', () => {
  const deferred = ['jam', 'ring'].map((w) => ({ group: 'H' as const, word: w, reason: \`\${UNEVALUABLE_LABEL}: chưa chạy vì Free Dictionary không trả lời lúc bắt đầu (từ giữ nguyên cho lần chạy lại)\` }));
  const f = word('F', 'asdfghjk', err(404, 'ENTRY_NOT_FOUND', 400), { probeHealthy: false }, false);
  const text = buildReport(summary([f], { deferred, rerun: rerunCommand(['H'], BASE), probes: [{ label: 'trước khi chạy', result: probe(false) }] }));

  it('counts them as not judged, lists them with the reason, and gives the command that runs them', () => {
    expect(text).toContain(\`| Đạt | Không đạt | \${UNEVALUABLE_LABEL} | Bỏ qua (tiền đề sai) |\`);
    expect(text).toContain('| 1 | 0 | 2 | 0 |');
    expect(text).toContain('| H | jam |');
    expect(text).toContain('chưa chạy vì Free Dictionary không trả lời lúc bắt đầu');
    expect(text).toContain('npm run acceptance:lookup -- --staging --only H --base-url http://localhost:3000');
    expect(text).toContain('CHƯA kết luận hết');
  });
});

describe('buildReport — group H words asked about again', () => {`,
      ],
    ],
  },
];
