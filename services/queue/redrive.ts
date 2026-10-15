import * as Jobs from '../../models/EnrichmentJob';
import type { EnrichmentJobDb } from '../../models/EnrichmentJob';
import type { EnrichmentEnqueuer } from '../lookup/enqueuer';
import type { EnrichmentInfo } from '../lookup/types';
import { ENRICH_DLQ, type EnrichJobData } from './constants';
import { ENTRY_EXISTS_SQL } from './pgBossEnqueuer';

/**
 * Redrive of the dead letter queue (npm run enrich:redrive, procedure in docs/lookup-runbook.md).
 *
 * Why this is not just boss.redrive(): our DLQ has its own worker (services/queue/enrichmentWorker.ts, handleDeadLetter), which
 * completes a dead-lettered job within seconds. pg-boss's redrive() only moves jobs that are still waiting (state < active),
 * so by the time an operator looks, there is nothing left for it to move. The job's data is still there (retained 7 days
 * by default), so a redrive here is a fresh enqueue of the same word through the SAME enqueuer the lookup API uses:
 * it keeps every guard (an entry already exists, an active row, the daily cap, singletonKey) and leaves the failed ledger
 * row as history.
 *
 * Planning only reads. Nothing is sent unless apply() is called, and the command-line tool calls it only with --confirm.
 */

export interface RedriveSelection {
  /** Normalized words. Empty / missing = any word. */
  words?: string[];
  /** Ids of dead-lettered pg-boss jobs. */
  dlqJobIds?: string[];
  /** Only jobs whose ledger row carries one of these reasons (dead_letter, upstream_error, stale, ...). */
  reasons?: string[];
  /** How many dead-lettered jobs to look at, newest first. Default 20, at most 500. */
  limit?: number;
}

export type RedriveSkip = 'entry_exists' | 'active_row' | 'ledger_not_failed' | 'newer_dead_letter' | 'bad_payload' | 'reason_filter';

export interface RedriveItem {
  dlqJobId: string;
  deadLetteredAt: string;
  word: string | null;
  requestedBy: string | null;
  ebookId: string | null;
  jobRowId: string | null;
  ledgerStatus: string | null;
  ledgerReason: string | null;
  ledgerAttempts: number | null;
  verdict: 'redrive' | 'skip';
  skip?: RedriveSkip;
}

export interface RedrivePlan {
  schema: string;
  scanned: number;
  items: RedriveItem[];
}

export interface RedriveDb extends EnrichmentJobDb {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/i;
export const DEFAULT_REDRIVE_LIMIT = 20;
export const MAX_REDRIVE_LIMIT = 500;

/** Reads the dead-lettered jobs and decides, for each, whether a redrive makes sense. Writes nothing. */
export async function planRedrive(deps: { db: RedriveDb; schema: string }, selection: RedriveSelection = {}): Promise<RedrivePlan> {
  if (!IDENTIFIER.test(deps.schema)) throw new Error('invalid queue schema name');
  const limit = Math.min(Math.max(Math.floor(selection.limit ?? DEFAULT_REDRIVE_LIMIT), 1), MAX_REDRIVE_LIMIT);
  const words = selection.words?.length ? selection.words.map((w) => w.trim().toLowerCase()) : null;
  const ids = selection.dlqJobIds?.length ? selection.dlqJobIds : null;

  // The schema name is an identifier (checked above), everything else is a bound parameter.
  const { rows } = await deps.db.query(
    `SELECT id, data, created_on FROM "${deps.schema}".job
      WHERE name = $1
        AND ($2::text[] IS NULL OR data->>'word' = ANY($2::text[]))
        AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
      ORDER BY created_on DESC
      LIMIT $4`,
    [ENRICH_DLQ, words, ids, limit]
  );

  const seenWords = new Set<string>();
  const items: RedriveItem[] = [];
  for (const r of rows) {
    const data = (r.data ?? {}) as Partial<EnrichJobData>;
    const item: RedriveItem = {
      dlqJobId: r.id,
      deadLetteredAt: new Date(r.created_on).toISOString(),
      word: typeof data.word === 'string' && data.word ? data.word : null,
      requestedBy: data.requestedBy ?? null,
      ebookId: data.ebookId ?? null,
      jobRowId: data.jobRowId ?? null,
      ledgerStatus: null,
      ledgerReason: null,
      ledgerAttempts: null,
      verdict: 'skip',
    };
    items.push(item);

    if (!item.word) {
      item.skip = 'bad_payload';
      continue;
    }
    if (seenWords.has(item.word)) {
      item.skip = 'newer_dead_letter'; // the newest dead letter of a word decides; older ones are history
      continue;
    }
    seenWords.add(item.word);

    const row = item.jobRowId ? await Jobs.findById(deps.db, item.jobRowId) : null;
    if (row) {
      item.ledgerStatus = row.status;
      item.ledgerReason = row.reason;
      item.ledgerAttempts = row.attempts;
    }

    if ((await deps.db.query(ENTRY_EXISTS_SQL, [item.word])).rows[0]?.found) item.skip = 'entry_exists';
    else if (await Jobs.hasActiveForWord(deps.db, item.word)) item.skip = 'active_row';
    else if (row && row.status !== 'failed') item.skip = 'ledger_not_failed';
    else if (selection.reasons?.length && !selection.reasons.includes(row?.reason ?? '')) item.skip = 'reason_filter';
    else item.verdict = 'redrive';
  }
  return { schema: deps.schema, scanned: rows.length, items };
}

export interface RedriveResult {
  attempted: number;
  /** status of the enqueuer's answer → how many */
  byStatus: Record<string, number>;
  /** word → what the enqueuer said, in order */
  outcomes: Array<{ word: string; info: EnrichmentInfo }>;
  /** true when the daily cap ended the run early */
  stoppedByDailyCap: boolean;
}

/** Sends the items marked "redrive" through the enqueuer, oldest first. Stops at the daily cap. */
export async function applyRedrive(deps: { enqueuer: EnrichmentEnqueuer }, plan: RedrivePlan): Promise<RedriveResult> {
  const result: RedriveResult = { attempted: 0, byStatus: {}, outcomes: [], stoppedByDailyCap: false };
  const todo = plan.items.filter((i) => i.verdict === 'redrive' && i.word);
  for (const item of [...todo].reverse()) {
    const info = await deps.enqueuer.enqueue({ word: item.word as string, requestedBy: item.requestedBy, ebookId: item.ebookId });
    result.attempted++;
    const key = info.reason ? `${info.status}:${info.reason}` : info.status;
    result.byStatus[key] = (result.byStatus[key] ?? 0) + 1;
    result.outcomes.push({ word: item.word as string, info });
    if (info.status === 'skipped' && info.reason === 'daily_cap') {
      result.stoppedByDailyCap = true;
      break;
    }
  }
  return result;
}
