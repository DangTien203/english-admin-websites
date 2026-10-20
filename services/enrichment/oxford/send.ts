/**
 * Sending the chosen Oxford words through the enrichment enqueuer, and the checks that must pass first
 * (docs/lookup-runbook.md §13). The enqueuer is the real one of the lookup path (daily cap, singletonKey, one job per word); this
 * file only decides WHEN to send and WHEN to stop.
 */
import type { EnrichmentEnqueuer } from '../../lookup/enqueuer';
import type { Queryable } from './plan';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightInput {
  db: Queryable;
  enrichmentEnabled: boolean;
  publishPolicy: 'auto' | 'review';
  /** --allow-auto: the explicit extra flag without which a policy of "auto" is refused */
  allowAuto: boolean;
  /** pg-boss schema (PGBOSS_SCHEMA): where the list of workers lives */
  schema: string;
  /** host name of THIS machine: a worker on it is "yours" */
  hostname: string;
  /** resolves when the 30 topic tags exist, rejects with a message that names the missing ones */
  loadTopics: () => Promise<unknown>;
  now?: Date;
  /** a worker whose last heartbeat is older than this is not running */
  heartbeatWindowSeconds?: number;
  /** Tests give their own list of live workers; the real tool reads `<schema>.instance`. */
  listWorkers?: () => Promise<WorkerInstance[]>;
}

export interface WorkerInstance {
  name: string;
  host: string;
  pid: number;
  started_on: Date;
  heartbeat_on: Date;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

/** pg-boss workers that are alive: not stopped, and a heartbeat inside the window. */
export async function liveWorkers(db: Queryable, schema: string, windowSeconds = 180): Promise<WorkerInstance[]> {
  if (!IDENT.test(schema)) throw new Error('PGBOSS_SCHEMA is not a plain identifier');
  const { rows } = await db.query(
    `SELECT name, host, pid, started_on, heartbeat_on FROM "${schema}".instance
      WHERE stopped_on IS NULL AND heartbeat_on > now() - ($1::int * interval '1 second') ORDER BY started_on DESC`,
    [windowSeconds]
  );
  return rows;
}

export async function preflight(i: PreflightInput): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  checks.push({
    name: 'ENRICHMENT_ENABLED',
    ok: i.enrichmentEnabled,
    detail: i.enrichmentEnabled ? 'true' : 'false: the enqueuer would answer "disabled". Run with ENRICHMENT_ENABLED=true in the environment of this command (and of the worker)',
  });

  try {
    await i.loadTopics();
    checks.push({ name: '30 chủ đề trong bảng tags', ok: true, detail: 'đủ' });
  } catch (err) {
    checks.push({ name: '30 chủ đề trong bảng tags', ok: false, detail: `${(err as Error).message} — chạy docs/seed-topics.sql` });
  }

  if (i.publishPolicy === 'review') {
    checks.push({ name: 'ENRICHMENT_PUBLISH_POLICY', ok: true, detail: 'review (mục từ mới chờ duyệt, published = false)' });
  } else if (i.allowAuto) {
    checks.push({ name: 'ENRICHMENT_PUBLISH_POLICY', ok: true, detail: 'auto, CHẤP NHẬN vì có --allow-auto: mục từ đủ tầng A sẽ được xuất bản NGAY' });
  } else {
    checks.push({
      name: 'ENRICHMENT_PUBLISH_POLICY',
      ok: false,
      detail: 'auto: mục từ đủ tầng A sẽ được xuất bản ngay, không qua duyệt. Đặt ENRICHMENT_PUBLISH_POLICY=review (cả ở worker), hoặc thêm --allow-auto nếu thật sự muốn',
    });
  }

  try {
    const alive = i.listWorkers ? await i.listWorkers() : await liveWorkers(i.db, i.schema, i.heartbeatWindowSeconds);
    const own = alive.filter((w) => w.host === i.hostname);
    const foreign = alive.filter((w) => w.host !== i.hostname);
    const describe = (list: WorkerInstance[]) => list.map((w) => `${w.host}#${w.pid}`).join(', ');
    if (own.length === 0) {
      checks.push({ name: 'worker đang chạy', ok: false, detail: `không có worker nào của máy này (${i.hostname}) còn nhịp tim trong ${i.heartbeatWindowSeconds ?? 180} giây. Bật: npm run worker (và tắt khi nạp xong)` });
    } else if (foreign.length > 0) {
      checks.push({ name: 'worker đang chạy', ok: false, detail: `có worker KHÁC cùng nhận job: ${describe(foreign)}. Mọi worker nối vào cùng DB đều nhận job (cấu hình và mã của nó quyết định kết quả). Tắt nó trước` });
    } else {
      checks.push({ name: 'worker đang chạy', ok: true, detail: `chỉ có worker của máy này: ${describe(own)}` });
    }
  } catch (err) {
    checks.push({ name: 'worker đang chạy', ok: false, detail: `không đọc được ${i.schema}.instance: ${(err as Error).message}` });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export const SPEND_CAP_REMINDER =
  'Nhắc: so chi phí ước tính ở trên với trần chi tiêu hằng tháng của Anthropic (console.anthropic.com → Limits) trước khi gửi hàng loạt.';

// ── sending ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SendReport {
  /** new jobs created */
  queued: string[];
  /** a job for the word was already there */
  alreadyQueued: string[];
  /** the enqueuer refused (exists, invalid_word, …) */
  skipped: Array<{ word: string; reason: string }>;
  /** the enqueuer threw */
  errors: Array<{ word: string; error: string }>;
  /** words never attempted because the run stopped */
  notAttempted: string[];
  stoppedBy: 'daily_cap' | 'disabled' | 'errors' | null;
}

export interface SendOptions {
  /** stop after this many errors in a row (a broken queue or database) */
  maxConsecutiveErrors?: number;
  onProgress?: (done: number, total: number, report: SendReport) => void;
  progressEvery?: number;
}

export async function sendWords(enqueuer: EnrichmentEnqueuer, words: readonly string[], opts: SendOptions = {}): Promise<SendReport> {
  const maxErrors = opts.maxConsecutiveErrors ?? 3;
  const every = opts.progressEvery ?? 25;
  const report: SendReport = { queued: [], alreadyQueued: [], skipped: [], errors: [], notAttempted: [], stoppedBy: null };
  let consecutive = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    try {
      const info = await enqueuer.enqueue({ word, requestedBy: null, ebookId: null });
      consecutive = 0;
      if (info.status === 'queued') report.queued.push(word);
      else if (info.status === 'already_queued') report.alreadyQueued.push(word);
      else if (info.status === 'disabled') {
        report.stoppedBy = 'disabled';
      } else if (info.status === 'skipped' && info.reason === 'daily_cap') {
        report.stoppedBy = 'daily_cap';
      } else {
        report.skipped.push({ word, reason: info.status === 'skipped' ? info.reason ?? 'skipped' : info.status });
      }
    } catch (err) {
      consecutive++;
      report.errors.push({ word, error: String((err as Error)?.message ?? err).slice(0, 200) });
      if (consecutive >= maxErrors) report.stoppedBy = 'errors';
    }

    if (report.stoppedBy) {
      // the word that hit the stop was not sent either (cap, disabled) — except an error stop, where it was tried and recorded
      report.notAttempted = words.slice(report.stoppedBy === 'errors' ? i + 1 : i);
      break;
    }
    if (opts.onProgress && ((i + 1) % every === 0 || i + 1 === words.length)) opts.onProgress(i + 1, words.length, report);
  }
  return report;
}
