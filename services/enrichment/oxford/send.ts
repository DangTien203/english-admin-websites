/**
 * Sending the chosen Oxford words through the enrichment enqueuer, and the checks that must pass first
 * (docs/lookup-runbook.md §13). The enqueuer is the real one of the lookup path (daily cap, singletonKey, one job per word); this
 * file only decides WHEN to send and WHEN to stop.
 */
import type { EnrichmentEnqueuer } from '../../lookup/enqueuer';
import { WORKER_INSTANCE_NAME } from '../../queue/boss';
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

/**
 * pg-boss processes that TAKE jobs and are alive: an instance named `enrichment-worker` (WORKER_INSTANCE_NAME), not stopped, with a heartbeat
 * inside the window. A process that only SENDS jobs (`enrichment-sender`: the API server of a deployment, a command-line tool) is in the same
 * table but takes nothing, so it is not counted: counting it made a healthy deployment look like a second worker.
 */
export async function liveWorkers(db: Queryable, schema: string, windowSeconds = 180, instanceName: string = WORKER_INSTANCE_NAME): Promise<WorkerInstance[]> {
  if (!IDENT.test(schema)) throw new Error('PGBOSS_SCHEMA is not a plain identifier');
  const { rows } = await db.query(
    `SELECT name, host, pid, started_on, heartbeat_on FROM "${schema}".instance
      WHERE name = $2 AND stopped_on IS NULL AND heartbeat_on > now() - ($1::int * interval '1 second') ORDER BY started_on DESC`,
    [windowSeconds, instanceName]
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

/** Errors that fail at once and leave nothing half done (the transaction is rolled back): worth trying the same word again. */
export const TRANSIENT_CONNECTION_ERROR = /ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|Connection terminated|57P01|57P03/i;

export class EnqueueTimeoutError extends Error {
  constructor(ms: number) {
    super(`enqueue timed out after ${ms} ms (a connection that no longer answers)`);
    this.name = 'EnqueueTimeoutError';
  }
}

export interface SendOptions {
  /** stop after this many errors in a row (a broken queue or database) */
  maxConsecutiveErrors?: number;
  /** one word must be sent within this time, otherwise it counts as an error and the run goes on to the next word (default 45 s) */
  perWordTimeoutMs?: number;
  /** how many more times a word that failed with a connection error is tried, with 1 s, 2 s… of waiting (default 2) */
  connectionRetries?: number;
  /** waiting before a retry, multiplied by the number of the retry (tests use 0) */
  retryDelayMs?: number;
  onProgress?: (done: number, total: number, report: SendReport) => void;
  progressEvery?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EnqueueTimeoutError(ms)), ms);
  });
  return Promise.race([promise, limit]).finally(() => timer && clearTimeout(timer));
}

export async function sendWords(enqueuer: EnrichmentEnqueuer, words: readonly string[], opts: SendOptions = {}): Promise<SendReport> {
  const maxErrors = opts.maxConsecutiveErrors ?? 3;
  const every = opts.progressEvery ?? 25;
  const timeoutMs = opts.perWordTimeoutMs ?? 45_000;
  const retries = opts.connectionRetries ?? 2;
  const retryDelay = opts.retryDelayMs ?? 1000;
  const report: SendReport = { queued: [], alreadyQueued: [], skipped: [], errors: [], notAttempted: [], stoppedBy: null };
  let consecutive = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    try {
      let info;
      for (let attempt = 0; ; attempt++) {
        try {
          info = await withTimeout(enqueuer.enqueue({ word, requestedBy: null, ebookId: null }), timeoutMs);
          break;
        } catch (err) {
          // a timeout is NOT retried: the first attempt may still hold its row on a connection that is dead but not yet closed
          if (attempt >= retries || err instanceof EnqueueTimeoutError || !TRANSIENT_CONNECTION_ERROR.test(String((err as Error)?.message ?? err))) throw err;
          if (retryDelay > 0) await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
        }
      }
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
