/**
 * docs/lookup-oxford-seed-report.md: the report of the Oxford seeding, generated from the database, the state file that
 * `enrich:seed-oxford --confirm` keeps, the Oxford file and (optionally) the log of the worker. Read only: nothing is changed.
 *
 * The generated part sits between two markers and is rewritten on every run; whatever follows the end marker (the notes written by hand
 * for each phase) is kept.
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyReviewNote } from '../../lookup/reviewNotes';
import { TOPIC_NAMES } from '../topics';
import { parseAutoNote } from '../../../utils/autoEntryNote';
import { buildMatrix, formatMatrix, planCefr } from './cefr';
import { coverageOf, type ParsedOxford } from './list';
import { measureDb, mb, payloadBytes } from './measure';
import { classifyWords, costFromTotals, formatDuration, usd, type Queryable } from './plan';
import { evaluate } from './publish';
import { allSentWords, readState, type RunRecord } from './state';

export const REPORT_FILE = 'docs/lookup-oxford-seed-report.md';
export const BEGIN_MARK = '<!-- BEGIN GENERATED (npm run enrich:seed-oxford -- --report) -->';
export const END_MARK = '<!-- END GENERATED -->';

// ── small pure helpers (tested) ────────────────────────────────────────────────────────────────────────────────────────

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export interface WorkerLogStats {
  jobs: number;
  /** milliseconds */
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  meanHaikuMs: number | null;
  /** how many `enrich` lines were for attempt 1, 2, 3, 4… */
  attempts: Record<string, number>;
  retries: number;
}

/** Reads the `enrich` / `enrich_retry` lines of a worker's output (one JSON object per line; other lines are ignored). */
export function parseWorkerLog(text: string): WorkerLogStats {
  const durations: number[] = [];
  const haiku: number[] = [];
  const attempts: Record<string, number> = {};
  let retries = 0;
  for (const raw of text.split(/\r?\n/)) {
    const start = raw.indexOf('{');
    if (start < 0) continue;
    let line: any;
    try {
      line = JSON.parse(raw.slice(start));
    } catch {
      continue;
    }
    if (line?.evt === 'enrich_retry' || line?.evt === 'enrich_retry_after_wait') retries++;
    if (line?.evt !== 'enrich' || typeof line.duration_ms !== 'number') continue;
    durations.push(line.duration_ms);
    if (typeof line.stages_ms?.s3_haiku === 'number') haiku.push(line.stages_ms.s3_haiku);
    const key = String(line.attempt ?? '?');
    attempts[key] = (attempts[key] ?? 0) + 1;
  }
  return {
    jobs: durations.length,
    medianMs: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs: durations.length ? Math.max(...durations) : null,
    meanHaikuMs: haiku.length ? haiku.reduce((s, v) => s + v, 0) / haiku.length : null,
    attempts,
    retries,
  };
}

export interface InvalidOutputEvent {
  word: string;
  /** word_enrichment_jobs.id of the job (the log line's job_id) */
  jobId: string | null;
  /** the rules the last draft broke: validator code + field path with the indexes taken out (senses[].meanings_vi) */
  issues: Array<{ code: string; path: string }>;
  firstIssues: Array<{ code: string; path: string }>;
  outputTokens: number | null;
}

const generic = (path: string): string => String(path).replace(/\[\d+\]/g, '[]');

/** The `enrich` lines of the worker log that ended in failed / invalid_output, with the rules they broke (needs a worker that logs `issues`). */
export function parseInvalidOutputs(text: string): InvalidOutputEvent[] {
  const out: InvalidOutputEvent[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const start = raw.indexOf('{');
    if (start < 0) continue;
    let line: any;
    try {
      line = JSON.parse(raw.slice(start));
    } catch {
      continue;
    }
    if (line?.evt !== 'enrich' || line.status !== 'failed' || line.reason !== 'invalid_output') continue;
    const pick = (list: unknown) => (Array.isArray(list) ? list.map((x: any) => ({ code: String(x?.code ?? '?'), path: generic(x?.path ?? '$') })) : []);
    out.push({ word: String(line.word), jobId: line.job_id ? String(line.job_id) : null, issues: pick(line.issues), firstIssues: pick(line.first_issues), outputTokens: typeof line.output_tokens === 'number' ? line.output_tokens : null });
  }
  return out;
}

const md = (text: unknown): string => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const n = (v: number): string => v.toLocaleString('en-US');

function table(headers: string[], rows: Array<Array<string | number>>): string[] {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(md).join(' | ')} |`)];
}

/** One line of the report for a sorted list of "label: count" pairs. */
const pairs = (entries: Array<[string, number]>): string => (entries.length ? entries.map(([k, v]) => `${k} ${n(v)}`).join(', ') : '(không có)');

const SQL_CHECKS = `-- Kết quả theo trạng thái và lý do của job gần nhất mỗi từ trong ngày (đổi khoảng thời gian cho đúng)
SELECT status, coalesce(reason, '-') AS reason, count(*) FROM word_enrichment_jobs
 WHERE created_at > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 3 DESC;

-- Mục từ tự tạo: đã xuất bản và chưa
SELECT published, count(*) FROM dictionary_entries WHERE admin_note LIKE '[auto]%' GROUP BY 1;

-- Phân bố mức CEFR của mục từ tự tạo, và số mục đã lấy mức theo Oxford
SELECT cefr_level, count(*) AS tong, count(*) FILTER (WHERE admin_note LIKE '%[oxford-cefr]%') AS theo_oxford
  FROM dictionary_entries WHERE admin_note LIKE '[auto]%' GROUP BY 1 ORDER BY 1;

-- Phân bố chủ đề (chỉ 30 chủ đề chuẩn) của mục từ tự tạo
SELECT t.name, count(*) FROM entry_tags et JOIN tags t ON t.id = et.tag_id JOIN dictionary_entries e ON e.id = et.entry_id
 WHERE e.admin_note LIKE '[auto]%' GROUP BY 1 ORDER BY 2 DESC;

-- Mục từ tự tạo thiếu IPA, thiếu audio, không có ví dụ
SELECT count(*) FILTER (WHERE ipa_us IS NULL AND ipa_uk IS NULL) AS thieu_ipa,
       count(*) FILTER (WHERE audio_us_url IS NULL AND audio_uk_url IS NULL) AS thieu_audio,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM entry_senses s JOIN sense_examples x ON x.sense_id = s.id WHERE s.entry_id = e.id)) AS khong_vi_du
  FROM dictionary_entries e WHERE admin_note LIKE '[auto]%';

-- Số lần thử trung bình và phân bố
SELECT attempts, count(*) FROM word_enrichment_jobs WHERE status IN ('succeeded','rejected','skipped','failed') GROUP BY 1 ORDER BY 1;

-- Token Anthropic trong tháng (mọi lần gọi, kể cả lần thử lại) và job đã gửi theo ngày
SELECT period, unit, used FROM api_usage_counters WHERE provider = 'anthropic' ORDER BY period DESC, unit;
SELECT period AS ngay, used AS job_da_gui FROM api_usage_counters WHERE provider = 'enrichment' AND unit = 'jobs' ORDER BY period DESC LIMIT 7;

-- Worker nào đang nối vào hàng đợi (chỉ được có worker của bạn khi đang nạp)
SELECT name, host, pid, started_on, heartbeat_on, stopped_on FROM pgboss.instance ORDER BY started_on DESC LIMIT 8;

-- Dung lượng cơ sở dữ liệu
SELECT pg_size_pretty(pg_database_size(current_database()));

-- Các mục từ đang chờ duyệt đủ điều kiện xuất bản hàng loạt: npm run enrich:publish   (chạy thử là mặc định)`;

// ── the report ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReportInput {
  db: Queryable;
  refDb: Queryable;
  parsed: ParsedOxford;
  fileName: string;
  workerLog?: string;
  now?: Date;
  /** where the state file is (tests) */
  stateFile?: string;
  /** report on the runs from this one (1 = the first) onwards; default: all of them */
  fromRun?: number;
}

interface JobRow {
  word: string;
  status: string;
  reason: string | null;
  attempts: number;
  entry_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
  finished_at: Date | null;
}

export async function buildReport(i: ReportInput): Promise<string[]> {
  const now = i.now ?? new Date();
  const from = Math.max(1, i.fromRun ?? 1);
  const runs = readState(i.stateFile).runs.slice(from - 1);
  const sent = allSentWords({ runs });
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(`Sinh lúc ${now.toISOString()} bởi \`npm run enrich:seed-oxford -- --file … --report\`. Phạm vi: ${runs.length === 0 ? "chưa có lần gửi nào" : `các lần gửi #${from} đến #${from + runs.length - 1}`}. Phần này được ghi lại mỗi lần chạy; ghi chú viết tay nằm SAU dấu kết thúc và được giữ.`, '');

  // 1 ─ runs and the Oxford file
  push('## 1. Dữ liệu vào và các lần gửi', '');
  const p = i.parsed;
  const cov = coverageOf(p.words);
  push(
    `File \`${i.fileName}\`: ${n(p.rows)} dòng, ${n(p.distinctWords)} từ khác nhau (chữ thường). Gộp ${n(p.mergedExtraRows)} dòng trùng của ${n(p.mergedWords)} từ; ${n(p.multiLevelWords)} từ có nhiều mức CEFR (lấy mức thấp nhất); ${n(p.rowsWithoutLevel)} dòng không có mức hợp lệ. Chỉ đọc từ, loại từ, mức CEFR; định nghĩa và ví dụ của Oxford không được dùng.`,
    '',
    `Độ phủ IPA/audio của file (từ hợp lệ, chỉ đếm, KHÔNG đưa vào mục từ): IPA ${n(cov.ipa)}/${n(cov.words)} · audio US ${n(cov.audioUs)}/${n(cov.words)} · audio UK ${n(cov.audioUk)}/${n(cov.words)}.`,
    ''
  );
  if (runs.length === 0) push('Chưa có lần gửi nào (`--confirm`) được ghi nhận.', '');
  else {
    push(
      ...table(
        ['#', 'bắt đầu (UTC)', 'kết thúc', 'cách chọn', 'từ đã gửi', 'dừng bởi', 'model', 'policy', 'đồng thời'],
        runs.map((r: RunRecord, k) => [
          from + k,
          r.startedAt.slice(0, 19).replace('T', ' '),
          (r.finishedAt ?? '').slice(11, 19),
          [r.options.onlyCefr?.length ? `mức ${r.options.onlyCefr.join(',')}` : '', r.options.sample ? `mẫu ${r.options.sample}` : '', r.options.limit ? `limit ${r.options.limit}` : '', r.options.offset ? `offset ${r.options.offset}` : '', r.options.retryLastRun ? 'gửi lại từ lần trước' : ''].filter(Boolean).join(' · ') || 'tất cả',
          r.words.length,
          r.stoppedBy ?? '-',
          r.model,
          r.publishPolicy,
          r.concurrency,
        ])
      ),
      ''
    );
  }

  // 2 ─ results by status
  let jobs: JobRow[] = [];
  if (sent.length > 0) {
    jobs = (
      await i.db.query(
        `SELECT DISTINCT ON (word) word, status, reason, attempts, entry_id, input_tokens, output_tokens, created_at, finished_at
           FROM word_enrichment_jobs WHERE word = ANY($1::text[]) ORDER BY word, created_at DESC`,
        [sent]
      )
    ).rows;
  }
  push('## 2. Kết quả theo trạng thái và lý do', '');
  if (sent.length === 0) push('(chưa có)', '');
  else {
    const byKey = new Map<string, number>();
    for (const j of jobs) byKey.set(`${j.status} / ${j.reason ?? '-'}`, (byKey.get(`${j.status} / ${j.reason ?? '-'}`) ?? 0) + 1);
    const noRow = sent.length - jobs.length;
    push(...table(['status / reason', 'số từ'], [...[...byKey.entries()].sort((a, b) => b[1] - a[1]), ...(noRow > 0 ? [['(chưa có hàng sổ)', noRow] as [string, number]] : [])]), '');
    push(`Tổng ${n(sent.length)} từ đã gửi. Job còn \`queued\`/\`running\`: ${n(jobs.filter((j) => j.status === 'queued' || j.status === 'running').length)}.`, '');
    const transient = jobs.filter((j) => j.reason === 'budget' || j.reason === 'upstream_error' || j.reason === 'dead_letter').length;
    push(`Job hết ngân sách hoặc lỗi nhà cung cấp (\`budget\`, \`upstream_error\`, \`dead_letter\`) ở job gần nhất của từ: ${transient}.`, '');
  }

  // 2b ─ per run, and why invalid_output
  if (sent.length > 0 && runs.length > 0) {
    const rows = (
      await i.db.query(`SELECT id, word, status, reason, created_at FROM word_enrichment_jobs WHERE word = ANY($1::text[]) AND created_at >= $2::timestamptz - interval '1 minute' ORDER BY created_at`, [sent, runs[0].startedAt])
    ).rows;
    const bounds = runs.map((r, k) => ({ from: new Date(r.startedAt).getTime() - 60_000, to: k + 1 < runs.length ? new Date(runs[k + 1].startedAt).getTime() - 60_000 : Infinity, words: new Set(r.words) }));
    const perRun = runs.map(() => new Map<string, number>());
    const runOfJob = new Map<string, number>();
    for (const row of rows) {
      const at = new Date(row.created_at).getTime();
      const k = bounds.findIndex((b) => at >= b.from && at < b.to && b.words.has(row.word));
      if (k < 0) continue;
      runOfJob.set(row.id, k);
      const key = `${row.status} / ${row.reason ?? '-'}`;
      perRun[k].set(key, (perRun[k].get(key) ?? 0) + 1);
    }
    const keys = [...new Set(perRun.flatMap((m) => [...m.keys()]))].sort();
    push('**Theo từng lần gửi** (đếm HÀNG sổ do lần gửi đó tạo, nên hàng cũ của từ được gửi lại vẫn nằm ở lần gửi cũ của nó):', '');
    push(...table(['status / reason', ...runs.map((_, k) => `lần #${from + k} (${n(runs[k].words.length)} từ)`)], keys.map((key) => [key, ...perRun.map((m) => m.get(key) ?? 0)])), '');

    const firstInvalid = perRun[0].get('failed / invalid_output') ?? 0;
    const firstRate = (firstInvalid * 100) / Math.max(1, runs[0].words.length);
    const finalInvalid = jobs.filter((j) => j.status === 'failed' && j.reason === 'invalid_output').length;
    push(
      `Tiêu chí dừng khẩn cấp: ở LƯỢT ĐẦU (lần #${from}, ${n(runs[0].words.length)} từ) \`invalid_output\` là ${n(firstInvalid)} (${firstRate.toFixed(1)}%; dừng khi vượt 5% theo yêu cầu ban đầu, 8% ở giai đoạn 2); sau các lần gửi lại còn ${n(finalInvalid)}/${n(sent.length)} từ hỏng (${((finalInvalid * 100) / Math.max(1, sent.length)).toFixed(1)}%). Lỗi nhà cung cấp và chi phí: ở trên và mục 4.`,
      ''
    );

    const byWord = new Map(p.words.map((w) => [w.word, w]));
    push('**\`invalid_output\` theo nguyên nhân (validator) và loại từ, từng lần gửi**', '');
    if (!i.workerLog) push('(cần \`--worker-log <log của worker>\`: validator nào nằm ở log, không ở cơ sở dữ liệu; worker cũ trước P10 chưa ghi trường này)', '');
    else {
      const all = parseInvalidOutputs(fs.readFileSync(i.workerLog, 'utf8'));
      let any = false;
      for (let k = 0; k < runs.length; k++) {
        const events = all.filter((e) => e.jobId !== null && runOfJob.get(e.jobId) === k);
        if (events.length === 0) continue;
        any = true;
        const distinct = new Set(events.map((e) => e.word));
        const noDetail = events.filter((e) => e.issues.length === 0).length;
        push(`*Lần #${from + k}* (${n(runs[k].words.length)} từ): ${n(events.length)} job \`invalid_output\`${noDetail > 0 ? `, ${noDetail} không có chi tiết (worker cũ)` : ''}.`, '');
        const countCodes = (pick: (e: InvalidOutputEvent) => Array<{ code: string; path: string }>) => {
          const m = new Map<string, Set<string>>();
          for (const e of events) for (const x of pick(e)) m.set(`${x.code} @ ${x.path}`, (m.get(`${x.code} @ ${x.path}`) ?? new Set()).add(e.word));
          return [...m.entries()].map(([key, set]) => [key, set.size] as [string, number]).sort((a, b) => b[1] - a[1]);
        };
        const last = countCodes((e) => e.issues);
        const first = countCodes((e) => e.firstIssues);
        push('Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:', '', ...table(['validator @ trường', 'số từ'], last.length ? last : [['(không có chi tiết)', 0]]), '');
        push('Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:', '', ...table(['validator @ trường', 'số từ'], first.length ? first : [['(không có chi tiết)', 0]]), '');
        const sentByPos = new Map<string, number>();
        for (const w of runs[k].words) {
          const key = byWord.get(w)?.primaryPos ?? '(không rõ)';
          sentByPos.set(key, (sentByPos.get(key) ?? 0) + 1);
        }
        const failedByPos = new Map<string, number>();
        for (const w of distinct) {
          const key = byWord.get(w)?.primaryPos ?? '(không rõ)';
          failedByPos.set(key, (failedByPos.get(key) ?? 0) + 1);
        }
        push(
          'Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):',
          '',
          ...table(
            ['loại từ', 'từ đã gửi', 'từ hỏng', 'tỉ lệ'],
            [...sentByPos.entries()].sort((a, b) => b[1] - a[1]).map(([key, total]) => [key, total, failedByPos.get(key) ?? 0, `${(((failedByPos.get(key) ?? 0) * 100) / total).toFixed(1)}%`])
          ),
          ''
        );
        const outTokens = events.map((e) => e.outputTokens).filter((x): x is number => x !== null);
        if (outTokens.length > 0) push(`Token ra của các job hỏng: trung vị ${n(Math.round(percentile(outTokens, 50) ?? 0))} (giới hạn \`ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH\` mặc định 4.000).`, '');
        push('Từng từ:', '', ...table(['từ', 'loại từ (Oxford)', 'CEFR', 'luật vi phạm ở bản cuối'], [...distinct].sort().map((w) => [w, (byWord.get(w)?.pos ?? []).join(', '), byWord.get(w)?.cefr ?? '-', [...new Set(events.filter((e) => e.word === w).flatMap((e) => e.issues.map((x) => `${x.code} @ ${x.path}`)))].join('; ') || '-'])), '');
      }
      if (!any) push('Không có dòng \`invalid_output\` nào trong log cho các lần gửi này.', '');
    }
  }

  // 3 ─ skipped words
  push('## 3. Từ bị bỏ qua', '');
  push(`**Bị bộ làm sạch đầu vào từ chối (${n(p.invalid.length)}):** ${p.invalid.map((w) => `\`${w.word}\` (${w.category === 'multi_word' ? 'nhiều từ' : 'ký tự lạ'})`).join(', ') || '(không có)'}`, '');
  const { excluded } = await classifyWords(i.db, p.words);
  const ex = new Map<string, number>();
  for (const e of excluded) ex.set(e.reason, (ex.get(e.reason) ?? 0) + 1);
  push(
    `**Không gửi vì đã có (tính tại thời điểm sinh báo cáo, nên gồm cả mục từ do chính đợt nạp này tạo):** trong từ điển ${n(ex.get('in_dictionary') ?? 0)} · là dạng biến trong word_forms ${n(ex.get('in_word_forms') ?? 0)} · đang trong hàng đợi ${n(ex.get('in_queue') ?? 0)} · đã có kết quả cuối từ job trước ${n(ex.get('done_before') ?? 0)}.`,
    ''
  );
  const notEntries = jobs.filter((j) => !(j.status === 'succeeded' && j.reason === null));
  if (notEntries.length > 0) {
    push(`**Đã gửi nhưng không thành mục từ mới (${n(notEntries.length)}), theo job gần nhất của từ:**`, '');
    push(...table(['từ', 'status', 'reason', 'số lần chạy'], notEntries.slice(0, 200).map((j) => [j.word, j.status, j.reason ?? '-', j.attempts])), '');
    if (notEntries.length > 200) push(`… và ${n(notEntries.length - 200)} từ nữa.`, '');
  }

  // entries created by the run
  const createdIds = jobs.filter((j) => j.status === 'succeeded' && j.reason === null && j.entry_id).map((j) => j.entry_id as string);
  let entries: any[] = [];
  let senseRows: any[] = [];
  if (createdIds.length > 0) {
    entries = (
      await i.db.query(
        `SELECT e.id, e.headword, e.pos, e.cefr_level, e.ipa_us, e.ipa_uk, e.audio_us_url, e.audio_uk_url, e.meaning_vi, e.admin_note, e.published,
                (SELECT count(*)::int FROM sense_examples x JOIN entry_senses s ON s.id = x.sense_id WHERE s.entry_id = e.id) AS examples
           FROM dictionary_entries e WHERE e.id = ANY($1::uuid[])`,
        [createdIds]
      )
    ).rows;
    senseRows = (await i.db.query(`SELECT entry_id, definition_vi FROM entry_senses WHERE entry_id = ANY($1::uuid[])`, [createdIds])).rows;
  }

  // 4 ─ tokens and cost
  push('## 4. Token và chi phí: thực so với ước tính', '');
  const firstRun = runs[0];
  if (!firstRun) push('(chưa có)', '');
  else {
    const rowsTotal = (
      await i.db.query(
        `SELECT count(*) FILTER (WHERE input_tokens > 0)::int AS jobs, COALESCE(sum(input_tokens), 0)::bigint AS inp, COALESCE(sum(output_tokens), 0)::bigint AS outp,
                avg(attempts)::float AS attempts, count(*)::int AS rows
           FROM word_enrichment_jobs WHERE word = ANY($1::text[]) AND created_at >= $2::timestamptz - interval '1 minute'`,
        [sent, firstRun.startedAt]
      )
    ).rows[0];
    const model = firstRun.model;
    const now0 = await measureDb(i.db, now);
    const dIn = now0.anthropicInputTokens - firstRun.before.anthropicInputTokens;
    const dOut = now0.anthropicOutputTokens - firstRun.before.anthropicOutputTokens;
    const jobsWithTokens = Number(rowsTotal.jobs);
    const costRows = costFromTotals(model, jobsWithTokens, Number(rowsTotal.inp), Number(rowsTotal.outp));
    const costCounters = costFromTotals(model, Math.max(jobsWithTokens, 1), dIn, dOut);
    const estimated = runs.reduce((s, r) => s + r.estimate.costUsd, 0);
    push(
      ...table(
        ['nguồn', 'token vào', 'token ra', 'chi phí ước tính', 'ghi chú'],
        [
          ['hàng word_enrichment_jobs của các từ đã gửi', n(Number(rowsTotal.inp)), n(Number(rowsTotal.outp)), costRows === null ? '-' : usd(costRows), `${n(jobsWithTokens)} job có gọi Haiku; chỉ lưu token của lần chạy cuối của mỗi job`],
          ['bộ đếm api_usage_counters, mức tăng từ trước lần gửi đầu', n(dIn), n(dOut), costCounters === null ? '-' : usd(costCounters), 'MỌI lần gọi Haiku trong thời gian đó, kể cả lần thử lại (và việc khác dùng Haiku cùng lúc, nếu có)'],
          ['ước tính trước khi gửi (dry-run)', '-', '-', usd(estimated), `${n(runs.reduce((s, r) => s + r.estimate.words, 0))} từ; nguồn: ${runs.map((r) => r.estimate.costSource).join(', ')}`],
        ]
      ),
      ''
    );
    if (costRows !== null && costCounters !== null) push(`Lần thử lại và lần gọi bị mất ở hàng sổ làm chênh lệch: bộ đếm cao hơn hàng sổ ${usd(Math.max(0, costCounters - costRows))}. Chi phí thực tính cả lần thử lại: **${usd(costCounters)}** (${jobsWithTokens > 0 ? usd(costCounters / jobsWithTokens) : '-'} mỗi job có gọi Haiku). Bảng giá là nhập tay (\`services/enrichment/pricing.ts\`) và giả định ${n(7859)} token system prompt đọc từ cache mỗi job: hóa đơn của Anthropic mới là số chính xác.`, '');
    if (costCounters !== null && estimated > 0) {
      const ratio = costCounters / estimated;
      push(`Chi phí thực bằng ${ratio.toFixed(2)} lần ước tính (dừng khẩn cấp khi vượt 2 lần) — ${ratio > 2 ? '**VƯỢT**' : 'đạt'}.`, '');
    }
    const attempts = new Map<number, number>();
    for (const j of jobs) attempts.set(j.attempts, (attempts.get(j.attempts) ?? 0) + 1);
    push(`Số lần chạy mỗi từ: trung bình ${rowsTotal.attempts === null ? '-' : Number(rowsTotal.attempts).toFixed(2)} (theo hàng sổ); phân bố ${pairs([...attempts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [`${k} lần:`, v]))}.`, '');
  }

  // 5 ─ time
  push('## 5. Thời gian', '');
  if (jobs.length === 0) push('(chưa có)', '');
  else {
    const spans = jobs.filter((j) => j.finished_at).map((j) => (new Date(j.finished_at as Date).getTime() - new Date(j.created_at).getTime()) / 1000);
    const lastDone = jobs.reduce((m, j) => (j.finished_at && new Date(j.finished_at).getTime() > m ? new Date(j.finished_at).getTime() : m), 0);
    push(`Từ lúc bắt đầu gửi đến job xong cuối cùng: ${runs[0] && lastDone ? formatDuration((lastDone - new Date(runs[0].startedAt).getTime()) / 1000) : '-'} cho ${n(jobs.length)} từ.`);
    push(`Từ lúc job được tạo đến lúc xong (gồm thời gian chờ trong hàng đợi): trung vị ${percentile(spans, 50) === null ? '-' : `${percentile(spans, 50)!.toFixed(1)} giây`}, p95 ${percentile(spans, 95) === null ? '-' : `${percentile(spans, 95)!.toFixed(1)} giây`}.`, '');
    if (i.workerLog) {
      const stats = parseWorkerLog(fs.readFileSync(i.workerLog, 'utf8'));
      push(
        `Theo log của worker (\`${path.basename(i.workerLog)}\`, ${n(stats.jobs)} dòng \`enrich\`): thời gian chạy MỘT job trung vị ${stats.medianMs === null ? '-' : `${(stats.medianMs / 1000).toFixed(1)} giây`}, p95 ${stats.p95Ms === null ? '-' : `${(stats.p95Ms / 1000).toFixed(1)} giây`}, lâu nhất ${stats.maxMs === null ? '-' : `${(stats.maxMs / 1000).toFixed(1)} giây`}; lần gọi Haiku trung bình ${stats.meanHaikuMs === null ? '-' : `${(stats.meanHaikuMs / 1000).toFixed(1)} giây`}; dòng \`enrich_retry\`: ${stats.retries}; theo lần chạy ${pairs(Object.entries(stats.attempts).map(([k, v]) => [`lần ${k}:`, v]))}.`,
        ''
      );
    }
  }

  // 6 ─ CEFR
  push('## 6. Phân bố CEFR: Oxford so với Haiku', '');
  if (entries.length === 0) push('(chưa có mục từ mới)', '');
  else {
    const ids = new Set(entries.map((e) => e.id));
    const decisions = (await planCefr(i.db, p.words)).filter((d) => ids.has(d.entry.id));
    push('```', ...formatMatrix(buildMatrix(decisions)), '```', '');
    const marked = decisions.filter((d) => d.action === 'already').length;
    push(`Mức CEFR đã được áp theo Oxford (\`npm run oxford:apply-cefr\`) cho ${n(marked)}/${n(decisions.length)} mục từ; phần còn lại vẫn mang mức Haiku ước tính. Cột "Haiku" của mục đã áp được đọc lại từ \`entry_edit_history\`.`, '');
  }

  // 7 ─ topics
  push('## 7. Phân bố chủ đề', '');
  if (entries.length === 0) push('(chưa có mục từ mới)', '');
  else {
    const topics = (
      await i.db.query(`SELECT t.name, count(*)::int AS n FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = ANY($1::uuid[]) AND t.name = ANY($2::text[]) GROUP BY 1 ORDER BY 2 DESC, 1`, [entries.map((e) => e.id), [...TOPIC_NAMES]])
    ).rows;
    const withTopic = (await i.db.query(`SELECT count(DISTINCT et.entry_id)::int AS n FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = ANY($1::uuid[]) AND t.name = ANY($2::text[])`, [entries.map((e) => e.id), [...TOPIC_NAMES]])).rows[0].n;
    push(...table(['chủ đề', 'số mục từ'], topics.map((t) => [t.name, t.n])), '');
    push(`${n(withTopic)}/${n(entries.length)} mục từ có ít nhất một chủ đề; ${n(entries.length - withTopic)} mục không có chủ đề nào.`, '');
  }

  // 8 ─ missing pieces
  push('## 8. Mục thiếu IPA, audio, ví dụ; nghĩa và ghi chú', '');
  if (entries.length === 0) push('(chưa có mục từ mới)', '');
  else {
    const senseCount = new Map<string, number>();
    const meaningCount = new Map<string, number>();
    for (const s of senseRows) {
      senseCount.set(s.entry_id, (senseCount.get(s.entry_id) ?? 0) + 1);
      meaningCount.set(s.entry_id, (meaningCount.get(s.entry_id) ?? 0) + String(s.definition_vi ?? '').split(';').map((x) => x.trim()).filter(Boolean).length);
    }
    const total = entries.length;
    const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
    push(
      ...table(
        ['chỉ tiêu', 'số mục từ', `trên ${total}`],
        [
          ['thiếu cả ipa_us và ipa_uk', entries.filter((e) => !e.ipa_us && !e.ipa_uk).length, ''],
          ['thiếu ipa_us', entries.filter((e) => !e.ipa_us).length, ''],
          ['thiếu cả audio_us_url và audio_uk_url', entries.filter((e) => !e.audio_us_url && !e.audio_uk_url).length, ''],
          ['không có ví dụ nào', entries.filter((e) => e.examples === 0).length, ''],
          ['không có chủ đề', '(mục 7)', ''],
          ['đã xuất bản (published)', entries.filter((e) => e.published).length, ''],
        ]
      ),
      ''
    );
    push(`Số nghĩa (sense) trung bình: ${(sum(senseCount) / total).toFixed(2)}; số nghĩa tiếng Việt (tách \`definition_vi\` bằng ";") trung bình: ${(sum(meaningCount) / total).toFixed(2)}.`, '');
    const withNotes = entries.map((e) => ({ headword: e.headword as string, notes: parseAutoNote(e.admin_note).review_notes })).filter((e) => e.notes.length > 0);
    const cat = new Map<string, number>();
    let blocking = 0;
    for (const e of withNotes) {
      let blocks = false;
      for (const note of e.notes) {
        const c = classifyReviewNote(note);
        cat.set(c.label, (cat.get(c.label) ?? 0) + 1);
        if (c.blocks) blocks = true;
      }
      if (blocks) blocking++;
    }
    push(`Mục từ có \`notes_for_review\` của Haiku: ${n(withNotes.length)}/${n(total)}; trong đó ${n(blocking)} có ghi chú thuộc nhóm "cần xem" (chặn xuất bản hàng loạt). Theo nhóm: ${pairs([...cat.entries()].sort((a, b) => b[1] - a[1]))}.`, '');
  }

  // 9 ─ DB size
  push('## 9. Dung lượng cơ sở dữ liệu', '');
  if (!firstRun) push('(chưa có)', '');
  else {
    const m = await measureDb(i.db, now);
    push(
      ...table(
        ['', 'trước lần gửi đầu', 'bây giờ', 'tăng'],
        [
          ['toàn cơ sở dữ liệu (pg_database_size)', mb(firstRun.before.dbBytes), mb(m.dbBytes), mb(m.dbBytes - firstRun.before.dbBytes)],
          [`các bảng bị ghi (${Object.keys(m.perTable).length}, gồm chỉ mục và TOAST)`, mb(firstRun.before.tableBytes), mb(m.tableBytes), mb(m.tableBytes - firstRun.before.tableBytes)],
        ]
      ),
      '',
      'Dung lượng trên đĩa gần như không đổi khi hàng mới dùng lại chỗ trống do các hàng đã xóa để lại (cơ sở dữ liệu vừa được dọn 38 mục từ), nên con số dưới đây mới là con số co giãn được: tổng kích thước DỮ LIỆU của các hàng thuộc những mục từ mới (chưa tính chỉ mục).',
      ''
    );
    if (createdIds.length > 0) {
      const payload = await payloadBytes(i.db, createdIds);
      const perEntry = payload.total / createdIds.length;
      const remaining = Math.max(0, p.words.length - excluded.length);
      push(
        `Dữ liệu của ${n(createdIds.length)} mục từ mới: ${mb(payload.total)} (trung bình ${(perEntry / 1024).toFixed(1)} KB mỗi mục từ). Với ${n(remaining)} từ còn có thể gửi, dự kiến thêm khoảng ${mb(perEntry * remaining)} dữ liệu, chưa tính chỉ mục. Theo bảng: ${pairs(Object.entries(payload.perTable).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [`${k}`, Math.round(v / 1024)]))} (KB).`,
        ''
      );
    }
  }

  // 10 ─ random words
  push('## 10. 30 từ ngẫu nhiên kèm nghĩa', '');
  if (entries.length === 0) push('(chưa có)', '');
  else {
    const pick = [...entries].sort((a, b) => stableHash(a.id) - stableHash(b.id)).slice(0, 30);
    push(...table(['từ', 'loại từ', 'CEFR', 'nghĩa (meaning_vi)'], pick.map((e) => [e.headword, (e.pos ?? []).join(', '), e.cefr_level ?? '-', String(e.meaning_vi ?? '').slice(0, 120)])), '');
  }

  // 10b ─ thirty random entries that pass the bulk-publish rule
  push('## 10b. 30 mục ngẫu nhiên ĐỦ ĐIỀU KIỆN xuất bản (tiêu chí của nút xuất bản hàng loạt)', '');
  if (entries.length === 0) push('(chưa có)', '');
  else {
    const verdict = await evaluate(i.db, entries.map((e) => ({ id: e.id, headword: e.headword, cefr_level: e.cefr_level, admin_note: e.admin_note })));
    const eligibleIds = new Set(verdict.eligible.map((e) => e.id));
    const held = new Map<string, number>();
    for (const s of verdict.skipped) for (const label of s.reason === 'tier_a_incomplete' ? ['thiếu tầng A'] : [...new Set((s.blocking ?? []).map((b) => b.label))]) held.set(label, (held.get(label) ?? 0) + 1);
    push(`${n(eligibleIds.size)}/${n(entries.length)} mục từ mới đủ điều kiện (đủ tầng A, không có ghi chú "cần xem"); giữ lại ${n(verdict.skipped.length)} mục, một mục có thể có nhiều lý do: ${pairs([...held.entries()].sort((a, b) => b[1] - a[1]))}. Chưa mục nào được xuất bản.`, '');
    const pick = entries.filter((e) => eligibleIds.has(e.id)).sort((a, b) => stableHash(`${a.id}pub`) - stableHash(`${b.id}pub`)).slice(0, 30);
    if (pick.length > 0) {
      const senses = (await i.db.query(`SELECT entry_id, pos, definition_vi FROM entry_senses WHERE entry_id = ANY($1::uuid[]) ORDER BY entry_id, sense_order`, [pick.map((e) => e.id)])).rows;
      const meanings = (id: string) => senses.filter((s) => s.entry_id === id).map((s) => `(${s.pos}) ${s.definition_vi}`).join(' · ');
      push(...table(['từ', 'loại từ', 'CEFR', 'các nghĩa tiếng Việt (mỗi sense một nhóm)'], pick.map((e) => [e.headword, (e.pos ?? []).join(', '), e.cefr_level ?? '-', meanings(e.id)])), '');
    }
  }

  // 11 ─ ten complete entries
  push('## 11. Mười mục từ đầy đủ nội dung (ngẫu nhiên)', '');
  if (entries.length === 0) push('(chưa có)', '');
  else {
    const pick = [...entries].sort((a, b) => stableHash(`${a.id}full`) - stableHash(`${b.id}full`)).slice(0, 10);
    for (const e of pick) {
      const detail = await i.db.query(
        `SELECT s.pos, s.sense_order, s.definition_en, s.definition_vi,
                COALESCE((SELECT json_agg(json_build_object('en', x.example_en, 'vi', x.example_vi) ORDER BY x.sort_order, x.id) FROM sense_examples x WHERE x.sense_id = s.id), '[]'::json) AS examples
           FROM entry_senses s WHERE s.entry_id = $1 ORDER BY s.sense_order`,
        [e.id]
      );
      push(`### ${e.headword}  _(${(e.pos ?? []).join(', ')} · ${e.cefr_level ?? '-'} · ${e.published ? 'published' : 'chờ duyệt'})_`, '');
      push(`- IPA: ${e.ipa_us ?? '-'} / ${e.ipa_uk ?? '-'} · audio: ${e.audio_us_url || e.audio_uk_url ? 'có' : 'không'} · \`meaning_vi\`: ${e.meaning_vi}`);
      for (const s of detail.rows) {
        push(`- (${s.pos}) ${s.definition_en} → **${s.definition_vi}**`);
        for (const ex of s.examples) push(`  - ${ex.en} — ${ex.vi ?? ''}`);
      }
      push(`- admin_note: ${String(e.admin_note ?? '').slice(0, 400)}`, '');
    }
  }

  // 12 ─ SQL
  push('## 12. Câu SQL để tự kiểm tra', '', '```sql', SQL_CHECKS, '```', '');
  return out;
}

/** A stable, well-spread number from a string (for a reproducible "random" order); not security-relevant. */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const TEMPLATE_NOTES = `
## Ghi chú các giai đoạn (viết tay)

(chưa có)
`;

export async function writeReport(i: ReportInput & { outFile?: string }): Promise<{ lines: number; file: string }> {
  const file = i.outFile ?? path.resolve(process.cwd(), REPORT_FILE);
  const body = await buildReport(i);
  let tail = TEMPLATE_NOTES;
  try {
    const existing = fs.readFileSync(file, 'utf8');
    const at = existing.indexOf(END_MARK);
    if (at >= 0) tail = existing.slice(at + END_MARK.length);
  } catch {
    /* first run: no file yet */
  }
  const head = ['# Báo cáo nạp Oxford 5000', '', 'Đợt nạp các từ của danh sách Oxford 5000 chưa có trong từ điển, qua đường ống làm giàu P6. Cách chạy: `docs/lookup-runbook.md` mục 13. Oxford chỉ cung cấp danh sách từ, loại từ và mức CEFR; nội dung do đường ống tự viết.', '', BEGIN_MARK, ''];
  const text = [...head, ...body, END_MARK].join('\n') + tail;
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return { lines: text.split('\n').length, file };
}
