/**
 * The whole of `npm run enrich:seed-oxford`, with everything it touches passed in, so that tests run it against the real database with a
 * fake queue (scripts/enrichment/seed-oxford.ts only builds the real parts).
 *
 * Without --confirm it only reads and prints. With --confirm it runs the checks first and sends nothing if one fails.
 */
import path from 'node:path';
import type { EnrichmentEnqueuer } from '../../lookup/enqueuer';
import { parseApplyCefrArgs, parsePublishArgs, parseSeedArgs, selectionFromArgs, type SeedArgs } from './args';
import { applyCefr, buildMatrix, formatMatrix, planCefr, type Connectable } from './cefr';
import { formatPlan, levelCounts } from './format';
import { readOxfordFile } from './list';
import { measureDb, mb } from './measure';
import { CLI_PUBLISH_VALUE, planPublish, publishSelected, type Connectable as PublishConnectable } from './publish';
import { buildSeedPlan, estimateRun, jobsUsedToday, loadHistory, usd, type Queryable } from './plan';
import { REPORT_FILE, writeReport } from './report';
import { parseCefrList } from './selection';
import { preflight, sendWords, SPEND_CAP_REMINDER, type SendReport, type WorkerInstance } from './send';
import { addRun, STATE_FILE, type RunRecord } from './state';

export interface SeedDeps {
  db: Queryable;
  refDb: Queryable;
  config: {
    enrichmentEnabled: boolean;
    publishPolicy: 'auto' | 'review';
    model: string;
    concurrency: number;
    dailyCap: number;
    schema: string;
  };
  hostname: string;
  loadTopics: () => Promise<unknown>;
  /** Tests give their own list of live workers; the real tool reads the pg-boss `instance` table. */
  listWorkers?: () => Promise<WorkerInstance[]>;
  /** Called only after every check passed, just before the first word is sent. */
  createEnqueuer: () => Promise<EnrichmentEnqueuer>;
  out: (line: string) => void;
  err: (line: string) => void;
  stateFile?: string;
  reportFile?: string;
  now?: () => Date;
}

const USAGE =
  'usage: npm run enrich:seed-oxford -- --file <oxford_5000.json> [--limit N] [--offset N] [--only-cefr A1,A2] [--sample N] [--dry-run | --confirm | --report [--worker-log <file>]] [--allow-auto]';

/** 0 ok, 1 refused or failed, 2 wrong usage. */
export async function runSeed(argv: string[], deps: SeedDeps): Promise<number> {
  const { out, err } = deps;
  let args: SeedArgs;
  try {
    args = parseSeedArgs(argv);
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!args.file) {
    err(`--file <oxford_5000.json> is required\n${USAGE}`);
    return 2;
  }

  let parsed;
  try {
    parsed = readOxfordFile(args.file);
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
  const fileName = path.basename(args.file);

  if (args.report) {
    const written = await writeReport({ db: deps.db, refDb: deps.refDb, parsed, fileName, workerLog: args.workerLog, stateFile: deps.stateFile, outFile: deps.reportFile, now: deps.now?.() });
    out(`Đã ghi ${deps.reportFile ?? REPORT_FILE} (${written.lines} dòng).`);
    return 0;
  }

  let selection;
  try {
    selection = selectionFromArgs(args);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const plan = await buildSeedPlan(deps.db, deps.refDb, parsed, selection.options);
  const estimate = estimateRun({
    words: plan.selected.length,
    model: deps.config.model,
    history: await loadHistory(deps.db),
    concurrency: deps.config.concurrency,
    dailyCap: deps.config.dailyCap,
    usedToday: await jobsUsedToday(deps.db, deps.now?.()),
  });
  const checks = await preflight({
    db: deps.db,
    enrichmentEnabled: deps.config.enrichmentEnabled,
    publishPolicy: deps.config.publishPolicy,
    allowAuto: args.allowAuto,
    schema: deps.config.schema,
    hostname: deps.hostname,
    loadTopics: deps.loadTopics,
    listWorkers: deps.listWorkers,
    now: deps.now?.(),
  });

  formatPlan(plan, estimate, { fileName, selectionText: selection.text, checks: checks.checks, confirmed: args.confirm }).forEach(out);
  if (!args.confirm) return 0;

  out('');
  if (!checks.ok) {
    err('KHÔNG GỬI: có kiểm tra không đạt (xem trên). Chưa có gì được ghi.');
    return 1;
  }
  out(SPEND_CAP_REMINDER);
  if (plan.selected.length === 0) {
    out('Không có từ nào để gửi.');
    return 0;
  }

  const before = await measureDb(deps.db, deps.now?.());
  const run: RunRecord = {
    startedAt: (deps.now?.() ?? new Date()).toISOString(),
    finishedAt: null,
    options: { sample: args.sample, limit: args.limit, offset: args.offset, onlyCefr: selection.options.onlyCefr ? [...selection.options.onlyCefr] : undefined },
    model: deps.config.model,
    publishPolicy: deps.config.publishPolicy,
    concurrency: deps.config.concurrency,
    words: [],
    stoppedBy: null,
    before: { dbBytes: before.dbBytes, anthropicInputTokens: before.anthropicInputTokens, anthropicOutputTokens: before.anthropicOutputTokens, tableBytes: before.tableBytes },
    estimate: {
      words: estimate.words,
      costUsd: estimate.costUsd,
      costSource: estimate.costSource,
      secondsPerWord: estimate.secondsPerWord,
      workerSeconds: estimate.workerSeconds,
      days: Number.isFinite(estimate.days) ? estimate.days : -1,
    },
  };

  out(`Bắt đầu gửi ${plan.selected.length} từ (DB ${mb(before.dbBytes)} trước khi gửi)…`);
  const started = Date.now();
  let report: SendReport;
  try {
    const enqueuer = await deps.createEnqueuer();
    report = await sendWords(enqueuer, plan.selected.map((w) => w.word), {
      onProgress: (done, total, r) => out(`  ${done}/${total} — mới ${r.queued.length}, đã có job ${r.alreadyQueued.length}, bỏ qua ${r.skipped.length}, lỗi ${r.errors.length}`),
    });
  } catch (e) {
    err(`Không khởi động được hàng đợi: ${(e as Error).message}`);
    return 1;
  }
  run.words = [...report.queued, ...report.alreadyQueued];
  run.finishedAt = (deps.now?.() ?? new Date()).toISOString();
  run.stoppedBy = report.stoppedBy;
  addRun(run, deps.stateFile ?? STATE_FILE);

  out('');
  out(`Xong sau ${Math.round((Date.now() - started) / 1000)} giây.`);
  out(`  job mới trong hàng đợi: ${report.queued.length}  (${levelCounts(plan.selected.filter((w) => report.queued.includes(w.word)))})`);
  out(`  đã có job sẵn: ${report.alreadyQueued.length} · bị enqueuer bỏ qua: ${report.skipped.length} · lỗi: ${report.errors.length}`);
  for (const s of report.skipped.slice(0, 20)) out(`    bỏ qua ${s.word}: ${s.reason}`);
  for (const e of report.errors.slice(0, 10)) out(`    lỗi ${e.word}: ${e.error}`);
  if (report.stoppedBy) {
    out(`  DỪNG vì ${report.stoppedBy}: còn ${report.notAttempted.length} từ chưa gửi.`);
    if (report.stoppedBy === 'daily_cap') out('  Chạy lại lệnh này vào ngày UTC sau (hoặc sau khi nâng ENRICHMENT_MAX_JOBS_PER_DAY): nó tiếp tục từ chỗ dừng, không tạo job trùng.');
  }
  out(`  Chi phí ước tính của ${run.words.length} từ: ${usd(estimate.costPerWordUsd * run.words.length)} (ước tính; số thật: chạy lại với --report sau khi worker xong)`);
  out('Job được xử lý bởi worker. Theo dõi: npm run enrich:status. Tắt worker khi xong (polling 5 giây giữ Neon thức).');
  return report.errors.length > 0 && report.queued.length === 0 && report.alreadyQueued.length === 0 ? 1 : 0;
}

// ── oxford:apply-cefr ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface CefrDeps {
  db: Queryable;
  source: Connectable;
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function runApplyCefr(argv: string[], deps: CefrDeps): Promise<number> {
  const { out, err } = deps;
  let args;
  try {
    args = parseApplyCefrArgs(argv);
  } catch (e) {
    err(`${(e as Error).message}\nusage: npm run oxford:apply-cefr -- --file <oxford_5000.json> [--dry-run]`);
    return 2;
  }
  if (!args.file) {
    err('--file <oxford_5000.json> is required');
    return 2;
  }
  const parsed = readOxfordFile(args.file);
  const decisions = await planCefr(deps.db, parsed.words);
  const count = (a: string) => decisions.filter((d) => d.action === a).length;

  out(`File: ${path.basename(args.file)} · ${parsed.words.length} từ hợp lệ`);
  out(`Mục từ [auto] khớp một từ của file: ${decisions.length}`);
  out(`  sẽ đổi mức:                 ${count('change')}`);
  out(`  đã đúng mức, chỉ đánh dấu:  ${count('agree')}`);
  out(`  đã đánh dấu [oxford-cefr]:  ${count('already')} (không đụng)`);
  out(`  Oxford không có mức:        ${count('no_oxford_level')} (không đụng)`);
  out('');
  formatMatrix(buildMatrix(decisions)).forEach(out);

  const changes = decisions.filter((d) => d.action === 'change');
  if (changes.length > 0) {
    out('');
    out(`Mục từ sẽ đổi (${Math.min(changes.length, 40)}/${changes.length}):`);
    for (const d of changes.slice(0, 40)) out(`  ${d.entry.headword.padEnd(20)} ${d.entry.cefr_level ?? '-'} → ${d.oxford}`);
  }

  if (args.dryRun) {
    out('\nCHƯA ĐỔI GÌ (--dry-run).');
    return 0;
  }
  const result = await applyCefr(deps.source, decisions);
  out('');
  out(`ĐÃ ÁP DỤNG: đổi mức ${result.changed} · chỉ đánh dấu ${result.markedOnly} · đã đánh dấu từ trước ${result.alreadyMarked} · không có mức Oxford ${result.noOxfordLevel}`);
  return 0;
}

// ── enrich:publish ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PublishDeps {
  db: Queryable;
  source: PublishConnectable;
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function runPublish(argv: string[], deps: PublishDeps): Promise<number> {
  const { out, err } = deps;
  let args;
  try {
    args = parsePublishArgs(argv);
  } catch (e) {
    err(`${(e as Error).message}\nusage: npm run enrich:publish -- [--cefr A1,A2] [--limit 500] [--dry-run | --confirm]`);
    return 2;
  }
  const cefr = args.cefr ? parseCefrList(args.cefr) : undefined;
  const plan = await planPublish(deps.db, { cefr, limit: args.limit });

  const byReason = new Map<string, number>();
  for (const s of plan.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  const byCategory = new Map<string, number>();
  for (const s of plan.skipped) for (const b of s.blocking ?? []) byCategory.set(b.label, (byCategory.get(b.label) ?? 0) + 1);

  out(`Mục từ [auto] chưa xuất bản${cefr ? ` (mức ${cefr.join(', ')})` : ''}: ${plan.candidates}`);
  out(`  đủ điều kiện xuất bản hàng loạt: ${plan.eligible.length}`);
  out(`  giữ lại: thiếu tầng A ${byReason.get('tier_a_incomplete') ?? 0} · có ghi chú cần xem ${byReason.get('has_review_notes') ?? 0}`);
  for (const [label, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) out(`      ghi chú "${label}": ${n}`);
  out(`Lần này (--limit ${args.limit}): ${plan.selected.length} mục từ`);
  for (const e of plan.selected.slice(0, 40)) out(`  ${(e.cefr_level ?? '-').padEnd(3)} ${e.headword}`);
  if (plan.selected.length > 40) out(`  … và ${plan.selected.length - 40} mục từ nữa`);

  if (!args.confirm) {
    out('\nCHƯA XUẤT BẢN GÌ (chạy thử). Để xuất bản thật: thêm --confirm.');
    return 0;
  }
  const result = await publishSelected(deps.source, plan.selected);
  out('');
  out(`ĐÃ XUẤT BẢN ${result.published.length} mục từ (mỗi mục một dòng entry_edit_history, new_value "${CLI_PUBLISH_VALUE}").`);
  if (result.dropped.length > 0) out(`  bỏ ${result.dropped.length} mục từ vì đã đổi giữa lúc lập kế hoạch và lúc ghi: ${result.dropped.map((d) => d.headword).join(', ')}`);
  return 0;
}
