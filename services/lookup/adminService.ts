import pool from '../../config/db';
import * as AutoEntry from '../../models/AutoEntry';
import * as JobAdmin from '../../models/EnrichmentJobAdmin';
import { isAutoNote, parseAutoNote, type ParsedAutoNote } from '../../utils/autoEntryNote';
import type { EnrichmentEnqueuer } from './enqueuer';
import {
  DEFAULT_PAGE_SIZE,
  JOB_STATUSES,
  MAX_BULK_PUBLISH,
  MAX_PAGE_SIZE,
  MAX_WORDS_PER_REQUEST,
  RETRYABLE_REASONS,
  flagMeanings,
  retryBlock,
  splitMeanings,
  tierAMissing,
  toWordList,
  type MeaningView,
  type RetryBlock,
} from './adminRules';
import { getEnrichmentEnqueuer } from './index';
import { getLookupHealthService, type HealthSnapshot } from './health';

/**
 * What the admin pages of the enrichment queue and the review of auto-created entries do (P8). The HTTP layer
 * (controllers/lookupAdmin*.ts) only turns requests into calls to this class and results into responses.
 *
 * Rules that live here: which jobs may be sent again, the limits on a request, which entries a bulk publish may publish, what
 * an entry's admin_note says. Everything that sends a job goes through the EnrichmentEnqueuer (daily cap, one active job per
 * word, "already in the dictionary"); nothing here writes to word_enrichment_jobs.
 */

/** An expected refusal: becomes an error response with this status and code. */
export class AdminHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export interface TxClient extends AutoEntry.Queryable {
  release(err?: Error | boolean): void;
}

export interface LookupAdminDeps {
  db: AutoEntry.Queryable & { connect(): Promise<TxClient> };
  /** Resolved on every use, so a replaced enqueuer (tests) is picked up. */
  getEnqueuer: () => EnrichmentEnqueuer;
  health: { getSnapshot(): Promise<HealthSnapshot> };
}

export interface PageInfo {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface Paged<T> {
  items: T[];
  pagination: PageInfo;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASON = /^[a-z_]{1,40}$/;

function validationError(message: string, details?: unknown): AdminHttpError {
  return new AdminHttpError(400, 'VALIDATION_ERROR', message, details);
}

function pageParams(raw: { page?: unknown; limit?: unknown }): { page: number; limit: number } {
  const page = Math.max(1, parseInt(String(raw.page ?? '1'), 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(String(raw.limit ?? DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE));
  return { page, limit };
}

function pageInfo(r: { page: number; limit: number; total: number; totalPages: number }): PageInfo {
  return { page: r.page, limit: r.limit, total: r.total, total_pages: r.totalPages };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// ── shapes returned ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EntryLink {
  id: string;
  headword: string | null;
  published: boolean | null;
  is_auto: boolean;
  url: string;
}

export interface JobItem {
  id: string;
  word: string;
  status: string;
  reason: string | null;
  attempts: number;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
  finished_at: Date | null;
  entry: EntryLink | null;
  retryable: boolean;
  retry_blocked: RetryBlock | null;
}

export type AddWordStatus = 'queued' | 'already_queued' | 'skipped' | 'disabled' | 'error';

export interface AddWordResult {
  word: string;
  status: AddWordStatus;
  reason?: string;
}

export interface AutoEntryItem {
  id: string;
  headword: string;
  lemma: string;
  pos: string[];
  meaning_vi: string | null;
  cefr_level: string | null;
  published: boolean;
  created_at: Date;
  sense_count: number;
  tier_a_complete: boolean;
  tier_a_missing: string[];
  review_note_count: number;
  /** a bulk publish would publish it: not published yet, tier A complete, no notes_for_review */
  eligible_for_bulk_publish: boolean;
}

export type BulkSkipReason = 'not_found' | 'not_auto' | 'already_published' | 'tier_a_incomplete' | 'has_review_notes';

export interface PublishOutcome {
  id: string;
  headword: string;
  published: boolean;
  /** false when the entry already had this value (nothing written) */
  changed: boolean;
  tier_a_missing: string[];
}

function entryLink(id: string, headword: string | null, published: boolean | null, isAuto: boolean): EntryLink {
  return { id, headword, published, is_auto: isAuto, url: isAuto ? `/lookup/review?status=all&entry=${id}` : `/dictionary/${id}` };
}

export class LookupAdminService {
  constructor(private readonly deps: LookupAdminDeps) {}

  // ── jobs ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  async listJobs(raw: Record<string, unknown>): Promise<Paged<JobItem>> {
    const status = str(raw.status);
    const reason = str(raw.reason);
    const from = str(raw.from);
    const to = str(raw.to);
    if (status && !(JOB_STATUSES as readonly string[]).includes(status)) throw validationError('status không hợp lệ', { allowed: JOB_STATUSES });
    if (reason && reason !== 'none' && !REASON.test(reason)) throw validationError('reason không hợp lệ');
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value && (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) throw validationError(`${name} phải có dạng YYYY-MM-DD`);
    }
    if (from && to && from > to) throw validationError('from phải trước hoặc bằng to');

    const { page, limit } = pageParams(raw);
    const result = await JobAdmin.listJobs({ status, reason, q: str(raw.q).slice(0, 100), from, to }, page, limit);
    return { items: result.rows.map(toJobItem), pagination: pageInfo(result) };
  }

  /** Sends each word through the enqueuer, one after the other. Never more than MAX_WORDS_PER_REQUEST words. */
  async addWords(input: unknown): Promise<{ results: AddWordResult[]; summary: Record<string, number> }> {
    const typed = toWordList(input);
    if (typed.length === 0) throw validationError('Cần ít nhất một từ');
    if (typed.length > MAX_WORDS_PER_REQUEST) {
      throw validationError(`Tối đa ${MAX_WORDS_PER_REQUEST} từ mỗi lần (đã nhận ${typed.length})`, { max: MAX_WORDS_PER_REQUEST, received: typed.length });
    }

    // the same word typed twice is sent once
    const seen = new Set<string>();
    const words = typed.filter((w) => {
      const key = w.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const enqueuer = this.deps.getEnqueuer();
    const results: AddWordResult[] = [];
    let broken = false;
    for (const word of words) {
      const shown = word.slice(0, 100);
      if (broken) {
        // the queue is failing: do not write one audit row per remaining word
        results.push({ word: shown, status: 'error', reason: 'not_attempted' });
        continue;
      }
      try {
        const info = await enqueuer.enqueue({ word, requestedBy: null, ebookId: null });
        results.push({ word: shown, status: info.status, ...(info.reason ? { reason: info.reason } : {}) });
      } catch {
        broken = true;
        results.push({ word: shown, status: 'error', reason: 'queue_error' });
      }
    }

    const summary: Record<string, number> = { requested: typed.length, processed: words.length, queued: 0, already_queued: 0, skipped: 0, disabled: 0, error: 0 };
    for (const r of results) summary[r.status] += 1;
    return { results, summary };
  }

  /** A new job for the word of a failed / skipped job, through the enqueuer. */
  async retryJob(jobId: string): Promise<{ previous_job_id: string; word: string; result: { status: string; reason?: string } }> {
    const job = isUuid(jobId) ? await JobAdmin.findJob(jobId) : null;
    if (!job) throw new AdminHttpError(404, 'NOT_FOUND', 'Không tìm thấy job');

    const block = retryBlock(job, job.word_active);
    if (block === 'word_active') {
      throw new AdminHttpError(409, 'WORD_ALREADY_ACTIVE', `Từ "${job.word}" đang nằm trong hàng đợi hoặc đang chạy`, { word: job.word });
    }
    if (block) {
      throw new AdminHttpError(409, 'JOB_NOT_RETRYABLE', 'Chỉ thử lại được job failed hoặc skipped có lý do upstream_error, budget, daily_cap, stale, queue_error hoặc dead_letter', {
        status: job.status,
        reason: job.reason,
        retryable_reasons: RETRYABLE_REASONS,
      });
    }

    let info;
    try {
      info = await this.deps.getEnqueuer().enqueue({ word: job.word, requestedBy: null, ebookId: null });
    } catch {
      throw new AdminHttpError(503, 'QUEUE_UNAVAILABLE', 'Không gửi được job vào hàng đợi, xem log máy chủ');
    }
    if (info.status === 'disabled') throw new AdminHttpError(409, 'ENRICHMENT_DISABLED', 'Làm giàu từ điển đang tắt trên máy chủ này (ENRICHMENT_ENABLED=false)');
    if (info.status === 'already_queued') {
      throw new AdminHttpError(409, 'WORD_ALREADY_ACTIVE', `Từ "${job.word}" đang nằm trong hàng đợi hoặc đang chạy`, { word: job.word });
    }
    return { previous_job_id: job.id, word: job.word, result: { status: info.status, ...(info.reason ? { reason: info.reason } : {}) } };
  }

  // ── entries made by the job ────────────────────────────────────────────────────────────────────────────────────────

  async listAutoEntries(raw: Record<string, unknown>): Promise<Paged<AutoEntryItem>> {
    const status = str(raw.status) || 'pending';
    if (status !== 'pending' && status !== 'published' && status !== 'all') {
      throw validationError('status phải là pending, published hoặc all', { allowed: ['pending', 'published', 'all'] });
    }
    const { page, limit } = pageParams(raw);
    const result = await AutoEntry.listAutoEntries({ status, q: str(raw.q).slice(0, 100) }, page, limit);
    const facts = await AutoEntry.tierAFactsFor(this.deps.db, result.rows.map((r) => r.id));

    const items = result.rows.map((r): AutoEntryItem => {
      const missing = facts.has(r.id) ? tierAMissing(facts.get(r.id) as any) : ['headword'];
      const notes = parseAutoNote(r.admin_note).review_notes;
      return {
        id: r.id,
        headword: r.headword,
        lemma: r.lemma,
        pos: r.pos ?? [],
        meaning_vi: r.meaning_vi,
        cefr_level: r.cefr_level,
        published: r.published,
        created_at: r.created_at,
        sense_count: r.sense_count,
        tier_a_complete: missing.length === 0,
        tier_a_missing: missing,
        review_note_count: notes.length,
        eligible_for_bulk_publish: !r.published && missing.length === 0 && notes.length === 0,
      };
    });
    return { items, pagination: pageInfo(result) };
  }

  /** Everything a reviewer needs about one entry made by the job, or a 404 when it is not one of those. */
  async getAutoEntryDetail(id: string) {
    const parts = isUuid(id) ? await AutoEntry.loadAutoEntry(id) : null;
    if (!parts) throw new AdminHttpError(404, 'NOT_FOUND', 'Không tìm thấy mục từ tự tạo');
    const { entry } = parts;

    const note = parseAutoNote(entry.admin_note);
    const facts = await AutoEntry.tierAFactsFor(this.deps.db, [entry.id]);
    const missing = tierAMissing(facts.get(entry.id) as any);

    const by = <T extends { sense_id: string }>(rows: T[], senseId: string) => rows.filter((r) => r.sense_id === senseId);
    const senses = parts.senses.map((s) => {
      const meanings: MeaningView[] = flagMeanings(splitMeanings(s.definition_vi), note.review_notes);
      return {
        id: s.id,
        order: s.sense_order,
        pos: s.pos,
        definition_en: s.definition_en,
        definition_vi: s.definition_vi,
        meanings_vi: meanings,
        register: s.register,
        domain: s.domain,
        region: s.region,
        grammar_note: s.grammar_note,
        usage_note: s.usage_note,
        examples: by(parts.examples, s.id).map((x) => ({ example_en: x.example_en, example_vi: x.example_vi })),
        synonyms: by(parts.senseSynonyms, s.id).map((x: any) => x.synonym_text),
        antonyms: by(parts.senseAntonyms, s.id).map((x: any) => x.antonym_text),
      };
    });

    const entryMeanings = flagMeanings(splitMeanings(entry.meaning_vi), note.review_notes);
    const hasFlags = senses.some((s) => s.meanings_vi.some((m) => m.too_long || m.in_review_notes)) || entryMeanings.some((m) => m.too_long || m.in_review_notes);

    return {
      id: entry.id,
      headword: entry.headword,
      lemma: entry.lemma,
      pos: entry.pos ?? [],
      ipa_us: entry.ipa_us,
      ipa_uk: entry.ipa_uk,
      audio_us_url: entry.audio_us_url,
      audio_uk_url: entry.audio_uk_url,
      meaning_vi: entry.meaning_vi,
      meanings_vi: entryMeanings,
      meaning_en: entry.meaning_en,
      example_en: entry.example_en,
      example_vi: entry.example_vi,
      cefr_level: entry.cefr_level,
      frequency_rank: entry.frequency_rank,
      register: entry.register,
      is_countable: entry.is_countable,
      is_transitive: entry.is_transitive,
      etymology: entry.etymology,
      source: entry.source,
      published: entry.published,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
      admin_note: entry.admin_note,
      note: noteView(note),
      tier_a_complete: missing.length === 0,
      tier_a_missing: missing,
      eligible_for_bulk_publish: !entry.published && missing.length === 0 && note.review_notes.length === 0,
      has_flagged_meanings: hasFlags,
      senses,
      topics: parts.tags.map((t) => t.name),
      synonyms: parts.entrySynonyms,
      antonyms: parts.entryAntonyms,
      word_forms: parts.forms,
      idioms: parts.idioms,
      phrasal_verbs: parts.phrasalVerbs,
      collocations: parts.collocations,
      history: parts.history,
      job: parts.latestJob,
    };
  }

  /** Publishes or hides ONE entry made by the job. The change and its entry_edit_history line commit together. */
  async setPublished(id: string, published: boolean, adminId: string): Promise<PublishOutcome> {
    if (!isUuid(id)) throw new AdminHttpError(404, 'NOT_FOUND', 'Không tìm thấy mục từ tự tạo');
    return this.inTransaction(async (tx) => {
      const [row] = await AutoEntry.lockEntries(tx, [id]);
      if (!row || !isAutoNote(row.admin_note)) throw new AdminHttpError(404, 'NOT_FOUND', 'Không tìm thấy mục từ tự tạo');

      const changed = (await AutoEntry.setPublished(tx, [id], published, adminId)).length > 0;
      const facts = await AutoEntry.tierAFactsFor(tx, [id]);
      return { id, headword: row.headword, published, changed, tier_a_missing: tierAMissing(facts.get(id) as any) };
    });
  }

  /**
   * Publishes the entries that satisfy ALL of: made by the job ('[auto]'), tier A complete, no notes_for_review. The rest are
   * reported with the reason. One transaction, rows locked: either every eligible entry is published with its history line, or none.
   */
  async bulkPublish(ids: unknown, adminId: string) {
    if (!Array.isArray(ids) || ids.length === 0) throw validationError('Cần ít nhất một entry_id');
    if (ids.length > MAX_BULK_PUBLISH) {
      throw validationError(`Tối đa ${MAX_BULK_PUBLISH} mục từ mỗi lần (đã nhận ${ids.length})`, { max: MAX_BULK_PUBLISH, received: ids.length });
    }
    if (!ids.every(isUuid)) throw validationError('entry_ids phải là danh sách UUID');
    const wanted = [...new Set(ids.map((i: string) => i.toLowerCase()))];

    return this.inTransaction(async (tx) => {
      const rows = new Map((await AutoEntry.lockEntries(tx, wanted)).map((r) => [r.id, r]));
      const facts = await AutoEntry.tierAFactsFor(tx, [...rows.keys()]);

      const eligible: string[] = [];
      const skipped: Array<{ id: string; headword: string | null; reason: BulkSkipReason; tier_a_missing?: string[] }> = [];
      for (const id of wanted) {
        const row = rows.get(id);
        if (!row) {
          skipped.push({ id, headword: null, reason: 'not_found' });
        } else if (!isAutoNote(row.admin_note)) {
          skipped.push({ id, headword: row.headword, reason: 'not_auto' });
        } else if (row.published) {
          skipped.push({ id, headword: row.headword, reason: 'already_published' });
        } else {
          const missing = tierAMissing(facts.get(id) as any);
          if (missing.length > 0) skipped.push({ id, headword: row.headword, reason: 'tier_a_incomplete', tier_a_missing: missing });
          else if (parseAutoNote(row.admin_note).review_notes.length > 0) skipped.push({ id, headword: row.headword, reason: 'has_review_notes' });
          else eligible.push(id);
        }
      }

      const changed = new Set(await AutoEntry.setPublished(tx, eligible, true, adminId));
      return {
        requested: wanted.length,
        published: eligible.filter((id) => changed.has(id)).map((id) => ({ id, headword: (rows.get(id) as any).headword as string })),
        skipped,
      };
    });
  }

  // ── health and demand ──────────────────────────────────────────────────────────────────────────────────────────────

  getHealth(): Promise<HealthSnapshot> {
    return this.deps.health.getSnapshot();
  }

  /** The words readers looked up most (7 or 30 days) that the dictionary cannot serve yet, top 50. */
  async missingWords(rawDays: unknown) {
    const days = rawDays === undefined || rawDays === '' ? 7 : Number(rawDays);
    if (days !== 7 && days !== 30) throw validationError('days phải là 7 hoặc 30', { allowed: [7, 30] });

    const rows = await JobAdmin.topMissingWords(days, 50);
    return {
      days,
      items: rows.map((r) => ({
        word: r.word,
        lookups: r.lookups,
        last_lookup_at: r.last_lookup_at,
        job: r.job_status ? { status: r.job_status, reason: r.job_reason } : null,
        entry: r.entry_id ? entryLink(r.entry_id, null, r.entry_published, Boolean(r.entry_is_auto)) : null,
        can_enqueue: !r.entry_id && r.job_status !== 'queued' && r.job_status !== 'running',
      })),
    };
  }

  private async inTransaction<T>(work: (tx: AutoEntry.Queryable) => Promise<T>): Promise<T> {
    const client = await this.deps.db.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        discard = true; // unknown transaction state: do not pool this connection again
      });
      throw err;
    } finally {
      client.release(discard ? true : undefined);
    }
  }
}

function toJobItem(r: JobAdmin.JobListRow): JobItem {
  const block = retryBlock(r, r.word_active);
  return {
    id: r.id,
    word: r.word,
    status: r.status,
    reason: r.reason,
    attempts: r.attempts,
    model: r.model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    created_at: r.created_at,
    finished_at: r.finished_at,
    entry: r.entry_id ? entryLink(r.entry_id, r.entry_headword, r.entry_published, Boolean(r.entry_is_auto)) : null,
    retryable: block === null,
    retry_blocked: block,
  };
}

/** The note as shown to a reviewer: the parts the job wrote, without the raw text. */
function noteView(n: ParsedAutoNote) {
  return {
    sources: n.sources,
    model: n.model,
    job_id: n.job_id,
    publish_note: n.publish_note,
    tier_a_missing: n.tier_a_missing,
    tier_b_missing: n.tier_b_missing,
    estimated: n.estimated,
    review_notes: n.review_notes,
    other: n.other,
  };
}

let instance: LookupAdminService | undefined;

/** The production instance: the shared pool, this process's enqueuer and health service. */
export function getLookupAdminService(): LookupAdminService {
  instance ??= new LookupAdminService({
    db: pool as any,
    getEnqueuer: () => getEnrichmentEnqueuer(),
    health: { getSnapshot: () => getLookupHealthService().getSnapshot() },
  });
  return instance;
}
