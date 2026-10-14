import { normalizeWord } from '../wordTranslationService';
import type { EnqueueInput, EnrichmentEnqueuer } from '../lookup/enqueuer';
import type { EnrichmentInfo } from '../lookup/types';
import { ApiUsage, currentPeriod } from '../upstream/apiUsage';
import * as Jobs from '../../models/EnrichmentJob';
import type { EnrichmentJobDb } from '../../models/EnrichmentJob';
import { ENRICH_QUEUE, ENRICHMENT_USAGE_PROVIDER, ENRICHMENT_USAGE_UNIT, type EnrichJobData } from './constants';
import { errMessage, incr, logEvent } from './log';

/**
 * The real EnrichmentEnqueuer (docs/lookup-spec.md §5 F11 and §7), used when ENRICHMENT_ENABLED=true.
 *
 * Order of checks (cheapest and free first, the daily cap only for a job that will really be created):
 *   a) clean the word        → skipped / invalid_word
 *   b) active row for it     → already_queued
 *   c) entry already exists  → skipped / exists
 *   d) reserve a daily slot  → skipped / daily_cap
 *   e) insert the job row    → conflict (parallel enqueue)  → already_queued
 *   f) boss.send             → null (pg-boss already has a job) → already_queued
 *
 * d, e and f run in ONE database transaction: pg-boss's send() accepts a `db` option, so the cap
 * counter, the ledger row and the pg-boss job commit together or not at all. Nothing needs to be
 * refunded or cleaned up after a conflict, an error or a crash in the middle.
 */

/** What the enqueuer needs from pg-boss. */
export interface BossSender {
  send(name: string, data: object, options?: Record<string, unknown>): Promise<string | null>;
}

export interface TxClient extends EnrichmentJobDb {
  release(err?: Error | boolean): void;
}

export interface TxPool extends EnrichmentJobDb {
  connect(): Promise<TxClient>;
}

/** The slice of ApiUsage used here (reserve / release). */
export interface UsageLedger {
  reserve(provider: string, unit: string, period: string, amount: number, limit: number): Promise<boolean>;
  release(provider: string, unit: string, period: string, amount: number): Promise<void>;
}

export interface PgBossEnqueuerDeps {
  pool: TxPool;
  getBoss: () => Promise<BossSender>;
  /** ENRICHMENT_MAX_JOBS_PER_DAY */
  maxJobsPerDay: number;
  /** Counter ledger bound to a connection; the transaction's client is passed so the reservation joins it. */
  usageFor?: (db: EnrichmentJobDb) => UsageLedger;
  /** The fast path's word cleaner. */
  normalize?: (raw: string) => { isValid: boolean; normalized: string };
  now?: () => Date;
  /** Tests use their own ledger key so they never touch the real daily counter. */
  usageProvider?: string;
  queueName?: string;
}

/** Entry in dictionary_entries (published or not) matching headword, lemma or any word form. */
const ENTRY_EXISTS_SQL = `
  SELECT (
    EXISTS (SELECT 1 FROM dictionary_entries WHERE LOWER(headword) = $1 OR LOWER(lemma) = $1)
    OR EXISTS (SELECT 1 FROM word_forms WHERE LOWER(form_value) = $1)
  ) AS found`;

export class PgBossEnrichmentEnqueuer implements EnrichmentEnqueuer {
  private readonly normalize: (raw: string) => { isValid: boolean; normalized: string };
  private readonly usageFor: (db: EnrichmentJobDb) => UsageLedger;
  private readonly now: () => Date;
  private readonly provider: string;
  private readonly queueName: string;

  constructor(private readonly deps: PgBossEnqueuerDeps) {
    this.normalize = deps.normalize ?? normalizeWord;
    this.usageFor = deps.usageFor ?? ((db) => new ApiUsage(db));
    this.now = deps.now ?? (() => new Date());
    this.provider = deps.usageProvider ?? ENRICHMENT_USAGE_PROVIDER;
    this.queueName = deps.queueName ?? ENRICH_QUEUE;
  }

  async enqueue(input: EnqueueInput): Promise<EnrichmentInfo> {
    // a) same cleaner as the fast path
    const cleaned = this.normalize(input.word);
    if (!cleaned.isValid) return this.skip('invalid_word');
    const word = cleaned.normalized;

    // b) a queued / running job for this word costs nothing and takes no slot of the daily cap
    if (await Jobs.hasActiveForWord(this.deps.pool, word)) return this.already(word, 'row');

    // c) already in the dictionary (published or not, headword / lemma / word form)
    const exists = await this.deps.pool.query(ENTRY_EXISTS_SQL, [word]);
    if (exists.rows[0]?.found) return this.skip('exists', word);

    // Start / reach pg-boss BEFORE taking a slot or a connection: if it is down, nothing was spent.
    const boss = await this.deps.getBoss();

    const client = await this.deps.pool.connect();
    let discard = false;
    let released = false;
    const releaseClient = () => {
      if (released) return;
      released = true;
      // A client whose ROLLBACK failed has an unknown transaction state: destroy it instead of pooling it.
      client.release(discard ? true : undefined);
    };
    try {
      await client.query('BEGIN');

      // d) daily cap (UTC day), reserved inside the transaction
      const usage = this.usageFor(client);
      const period = currentPeriod('day', this.now());
      const reserved = await usage.reserve(this.provider, ENRICHMENT_USAGE_UNIT, period, 1, this.deps.maxJobsPerDay);
      if (!reserved) {
        await client.query('ROLLBACK');
        logEvent('warn', 'enrich_daily_cap', { word, limit: this.deps.maxJobsPerDay, period });
        return this.skip('daily_cap');
      }

      // e) ledger row; a parallel enqueue of the same word wins the partial unique index and we lose quietly
      const jobRowId = await Jobs.insertQueued(client, { word, requestedBy: input.requestedBy });
      if (!jobRowId) {
        await client.query('ROLLBACK'); // takes the reserved slot back with it
        return this.already(word, 'conflict');
      }

      // f) the pg-boss job, in the same transaction
      const data: EnrichJobData = { word, requestedBy: input.requestedBy, ebookId: input.ebookId, jobRowId };
      const sendOptions: Record<string, unknown> = { singletonKey: word, db: asBossDb(client) };
      if (input.startAfterSeconds && input.startAfterSeconds > 0) sendOptions.startAfter = Math.ceil(input.startAfterSeconds);
      const bossJobId = await boss.send(this.queueName, data, sendOptions);

      if (bossJobId === null) {
        // pg-boss already holds a job for this word (exclusive policy). Keep an audit row, give the slot back.
        await Jobs.finish(client, jobRowId, { status: 'skipped', reason: 'duplicate' });
        await usage.release(this.provider, ENRICHMENT_USAGE_UNIT, period, 1);
        await client.query('COMMIT');
        return this.already(word, 'duplicate');
      }

      await client.query('COMMIT');
      incr('enqueue.queued');
      logEvent('info', 'enrich_enqueued', { word, job_row_id: jobRowId, job_id: bossJobId, start_after_s: sendOptions.startAfter ?? 0 });
      return { status: 'queued' };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        discard = true;
      });
      incr('enqueue.queue_error');
      logEvent('error', 'enrich_enqueue_failed', { word, error: errMessage(err) });
      // Give the connection back BEFORE the audit insert, which needs a pool connection of its own.
      releaseClient();
      await this.recordQueueError(word, input.requestedBy);
      throw err;
    } finally {
      releaseClient();
    }
  }

  /** Audit row so an outage shows up in word_enrichment_jobs; the cap was never consumed (rolled back). */
  private async recordQueueError(word: string, requestedBy: string | null): Promise<void> {
    try {
      await this.deps.pool.query(
        `INSERT INTO word_enrichment_jobs (word, status, reason, requested_by, finished_at)
         VALUES ($1, 'failed', 'queue_error', (SELECT id FROM users WHERE id = $2::uuid), NOW())`,
        [word, requestedBy]
      );
    } catch (err) {
      logEvent('warn', 'enrich_audit_failed', { word, error: errMessage(err) });
    }
  }

  private skip(reason: string, word?: string): EnrichmentInfo {
    incr(`enqueue.skipped.${reason}`);
    if (word) logEvent('info', 'enrich_skipped', { word, reason });
    return { status: 'skipped', reason };
  }

  private already(word: string, via: string): EnrichmentInfo {
    incr('enqueue.already_queued');
    logEvent('info', 'enrich_already_queued', { word, via });
    return { status: 'already_queued' };
  }
}

/** pg-boss only needs `executeSql(text, values)` from a custom database adapter. */
function asBossDb(client: EnrichmentJobDb) {
  return { executeSql: (text: string, values?: unknown[]) => client.query(text, values as any[]) };
}
