/**
 * The pure part of the acceptance script (P7b): takes what was OBSERVED for a word (an HTTP response, the rows of the job
 * ledger, the entry that the job wrote) and says pass or fail with the reasons. No I/O, no clock, so it can be unit-tested
 * with sample responses (tests/acceptance/evaluate.test.ts).
 *
 * The expectations are those of docs/lookup-runbook.md §12; a verdict is never softened to make a run green.
 */
import { jobExpectation, LATENCY_MARGIN_MS, TIMED_GROUPS, type Group } from './words';

/**
 * pass / fail / skip (a precondition of the database was wrong) / unevaluable: the expectation needs an outside source that was not
 * answering (Free Dictionary), so the word can be neither passed nor failed. Unevaluable is never turned into pass.
 */
export type VerdictKind = 'pass' | 'fail' | 'skip' | 'unevaluable';

export interface Verdict {
  verdict: VerdictKind;
  reasons: string[];
}

const pass = (): Verdict => ({ verdict: 'pass', reasons: [] });
const fromReasons = (reasons: string[]): Verdict => ({ verdict: reasons.length === 0 ? 'pass' : 'fail', reasons });

/**
 * skip beats fail beats unevaluable beats pass; the reasons of every part are kept. A real failure of one part (say, the job wrote
 * an entry with the wrong published flag) is not hidden by another part that could not be judged.
 */
export function combine(...parts: Verdict[]): Verdict {
  const reasons = parts.flatMap((p) => p.reasons);
  if (parts.some((p) => p.verdict === 'skip')) return { verdict: 'skip', reasons };
  if (parts.some((p) => p.verdict === 'fail')) return { verdict: 'fail', reasons };
  if (parts.some((p) => p.verdict === 'unevaluable')) return { verdict: 'unevaluable', reasons };
  return { verdict: 'pass', reasons };
}

// ── the fast path (one HTTP response) ───────────────────────────────────────────────────────────────────────────────

export interface FastObservation {
  status: number;
  /** wall-clock milliseconds of the request, measured by the caller (pacing sleeps excluded) */
  ms: number;
  /** the whole parsed JSON envelope: { success, data } or { success, error } ; null when the body was not JSON */
  body: any;
  /** true when the first answer was 429 and the request was repeated after Retry-After */
  retriedAfter429?: boolean;
}

export interface FastSummary {
  status: number;
  source: string | null;
  temporary: boolean | null;
  matchedForm: string | null;
  partial: boolean | null;
  missing: string[];
  meaningsCount: number | null;
  sensesCount: number | null;
  enrichmentStatus: string | null;
  errorCode: string | null;
  ms: number;
}

export function summarizeFast(obs: FastObservation): FastSummary {
  const data = obs.body?.data;
  return {
    status: obs.status,
    source: typeof data?.source === 'string' ? data.source : null,
    temporary: typeof data?.temporary === 'boolean' ? data.temporary : null,
    matchedForm: typeof data?.matched_form === 'string' ? data.matched_form : null,
    partial: typeof data?.partial === 'boolean' ? data.partial : null,
    missing: Array.isArray(data?.missing) ? data.missing.map(String) : [],
    meaningsCount: Array.isArray(data?.meanings_vi) ? data.meanings_vi.length : null,
    sensesCount: Array.isArray(data?.senses) ? data.senses.length : null,
    enrichmentStatus: typeof data?.enrichment?.status === 'string' ? data.enrichment.status : null,
    errorCode: typeof obs.body?.error?.code === 'string' ? obs.body.error.code : null,
    ms: obs.ms,
  };
}

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** Do two senses differ by part of speech or by short Vietnamese gloss? */
export function hasDistinctSenses(senses: unknown): boolean {
  if (!Array.isArray(senses) || senses.length < 2) return false;
  const keys = new Set(senses.map((s: any) => `${norm(s?.pos)}|${norm(s?.gloss_vi)}`));
  const poses = new Set(senses.map((s: any) => norm(s?.pos)));
  const glosses = new Set(senses.map((s: any) => norm(s?.gloss_vi)));
  return poses.size >= 2 || glosses.size >= 2 || keys.size >= 2;
}

export function evaluateFast(group: Group, word: string, obs: FastObservation): Verdict {
  const s = summarizeFast(obs);
  const data = obs.body?.data;
  const reasons: string[] = [];

  if (obs.status === 429) return fromReasons([`429 ${s.errorCode ?? 'LOOKUP_RATE_LIMITED'}${obs.retriedAfter429 ? ' (cả sau khi chờ Retry-After)' : ''}`]);

  switch (group) {
    case 'A':
      if (s.status !== 200) reasons.push(`HTTP ${s.status}${s.errorCode ? ` ${s.errorCode}` : ''}, mong đợi 200`);
      else {
        if (s.source !== 'dictionary') reasons.push(`source=${s.source}, mong đợi dictionary`);
        if (data?.temporary !== undefined) reasons.push(`có trường temporary (${JSON.stringify(data.temporary)}), mong đợi không có`);
      }
      break;
    case 'B':
      if (s.status !== 200) reasons.push(`HTTP ${s.status}${s.errorCode ? ` ${s.errorCode}` : ''}, mong đợi 200`);
      else {
        if (s.source !== 'dictionary') reasons.push(`source=${s.source}, mong đợi dictionary`);
        if (data?.temporary !== undefined) reasons.push(`có trường temporary, mong đợi không có`);
        if (s.matchedForm !== word) reasons.push(`matched_form=${JSON.stringify(s.matchedForm)}, mong đợi ${JSON.stringify(word)}`);
      }
      break;
    case 'C':
      if (s.status !== 200) reasons.push(`HTTP ${s.status}${s.errorCode ? ` ${s.errorCode}` : ''}, mong đợi 200`);
      else {
        if (s.source !== 'translation') reasons.push(`source=${s.source}, mong đợi translation`);
        if (s.temporary !== true) reasons.push(`temporary=${s.temporary}, mong đợi true`);
        const t = data?.translation_vi;
        if (t === null || t === undefined || norm(t) === '') reasons.push('translation_vi rỗng hoặc null');
        else if (norm(t) === norm(word)) reasons.push('translation_vi giống hệt từ gốc');
        if (s.enrichmentStatus !== 'queued') reasons.push(`enrichment.status=${s.enrichmentStatus}, mong đợi queued`);
      }
      break;
    case 'D':
      if (s.status === 404) reasons.push('HTTP 404 ENTRY_NOT_FOUND, mong đợi 200 (từ vay mượn không được bị coi là không có)');
      else if (s.status !== 200) reasons.push(`HTTP ${s.status}${s.errorCode ? ` ${s.errorCode}` : ''}, mong đợi 200`);
      else {
        if (s.source !== 'translation') reasons.push(`source=${s.source}, mong đợi translation`);
        const t = data?.translation_vi;
        if (t === null || t === undefined || norm(t) === '') reasons.push('translation_vi rỗng hoặc null');
      }
      break;
    case 'E':
      if (s.status !== 200) reasons.push(`HTTP ${s.status}${s.errorCode ? ` ${s.errorCode}` : ''}, mong đợi 200`);
      else if (s.source !== 'translation') reasons.push(`source=${s.source}, mong đợi translation`);
      break;
    case 'F':
      if (word === 'recieve') {
        if (s.status !== 200 && s.status !== 404) reasons.push(`HTTP ${s.status}, chấp nhận 200 hoặc 404`);
        else if (s.status === 200 && s.source !== 'translation') reasons.push(`source=${s.source}, mong đợi translation`);
      } else if (s.status !== 404) reasons.push(`HTTP ${s.status}${s.errorCode ? ` ${s.errorCode}` : ''}, mong đợi 404 ENTRY_NOT_FOUND`);
      else if (s.errorCode !== 'ENTRY_NOT_FOUND') reasons.push(`mã lỗi ${s.errorCode}, mong đợi ENTRY_NOT_FOUND`);
      break;
    case 'H':
      if (s.status !== 200) reasons.push(`HTTP ${s.status}${s.errorCode ? ` ${s.errorCode}` : ''}, mong đợi 200`);
      else {
        if (s.source !== 'translation') reasons.push(`source=${s.source}, mong đợi translation`);
        if (!hasDistinctSenses(data?.senses)) reasons.push(`senses=${s.sensesCount ?? 'null'}: cần ít nhất 2 phần tử khác loại từ hoặc khác gloss_vi`);
        if ((s.meaningsCount ?? 0) < 3) reasons.push(`meanings_vi có ${s.meaningsCount ?? 0} phần tử, mong đợi từ 3`);
      }
      break;
  }
  return fromReasons(reasons);
}

// ── Free Dictionary failing: "cannot be judged", not "failed" ─────────────────────────────────────────────────────────

/** What the report calls a row whose expectation needs a source that was not answering. */
export const UNEVALUABLE_LABEL = 'KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi';

export interface SourceHealth {
  /** Free Dictionary could not be relied on while this word was looked up (probe failed, or its circuit breaker was open) */
  unhealthy: boolean;
  /** short, content-free reason for the report */
  why: string;
}

/** 503 TRANSLATION_UNAVAILABLE: by docs/lookup-spec.md §6 ("không G, FDerr") it is only answered when Free Dictionary ERRORED. */
export function isSourceOutage(obs: FastObservation): boolean {
  return obs.status === 503 && obs.body?.error?.code === 'TRANSLATION_UNAVAILABLE';
}

/**
 * A fast-path verdict that fails ONLY because Free Dictionary was failing becomes "unevaluable" (never pass). Applied to
 *   - groups E and F: a 503. The word has no Google translation, so the answer waits for Free Dictionary; when that hangs or errors
 *     the matrix of §6 says 503, which is what the server did. The report says so; the expectation (E: 200, F: 404) cannot be checked.
 *   - group H: a 503, or, while Free Dictionary was unhealthy, an answer without the senses that only it provides.
 * Everything else keeps its verdict, so a wrong status or a wrong source is still a failure whatever Free Dictionary did.
 */
export function reclassifyForSource(group: Group, obs: FastObservation, verdict: Verdict, source: SourceHealth): Verdict {
  if (verdict.verdict !== 'fail') return verdict;
  const outage = isSourceOutage(obs);
  const reasons = (extra: string) => [extra, ...verdict.reasons.map((r) => `(${r})`)];

  if ((group === 'E' || group === 'F') && outage) {
    return {
      verdict: 'unevaluable',
      reasons: reasons('503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời'),
    };
  }
  if (group === 'H') {
    if (outage) return { verdict: 'unevaluable', reasons: reasons('503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi (spec §6), không có sense để chấm') };
    if (source.unhealthy && obs.status === 200 && obs.body?.data?.source === 'translation') {
      return { verdict: 'unevaluable', reasons: reasons(`Free Dictionary không khỏe lúc tra (${source.why}); các sense của nhóm H đến từ nguồn đó`) };
    }
  }
  return verdict;
}

// ── the form row written in the background (group B) ────────────────────────────────────────────────────────────────

export function evaluateFormRow(word: string, present: boolean): Verdict {
  return present ? pass() : { verdict: 'fail', reasons: [`không có dòng word_forms cho "${word}" sau khi chờ`] };
}

// ── Google characters (groups A and B must not call out) ─────────────────────────────────────────────────────────────

export function evaluateGoogleChars(before: number, after: number): Verdict {
  return after === before ? pass() : { verdict: 'fail', reasons: [`ký tự Google đổi từ ${before} thành ${after} (+${after - before}) trong lúc chạy nhóm A và B`] };
}

// ── the background job ──────────────────────────────────────────────────────────────────────────────────────────────

export interface JobRowObservation {
  id: string;
  status: string;
  reason: string | null;
  entryId: string | null;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface EntryObservation {
  id: string;
  headword: string;
  lemma: string;
  published: boolean;
  pos: string[];
  meaningVi: string | null;
  adminNote: string | null;
  senseCount: number;
  /** senses with both definition_en and definition_vi */
  completeSenseCount: number;
  /** examples with both example_en and example_vi */
  exampleCount: number;
}

export interface JobObservation {
  /** rows of word_enrichment_jobs for the word created since the run started, newest first */
  rows: JobRowObservation[];
  /** the entry whose headword or lemma is the word and whose admin_note starts with '[auto]' (written by the job), if any */
  entry: EntryObservation | null;
  /** ANY entry whose headword is the word, created by anyone */
  headwordEntryExists: boolean;
  /** the wait ran out while the newest row was still queued / running */
  timedOut: boolean;
}

export const TERMINAL_JOB_STATUSES: readonly string[] = ['succeeded', 'rejected', 'failed', 'skipped'];

export function meaningParts(meaningVi: string | null): string[] {
  return String(meaningVi ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Tier A of docs/lookup-spec.md §3: what an entry must have to be publishable. Returns the missing fields. */
export function tierAMissing(e: EntryObservation): string[] {
  const missing: string[] = [];
  if (!e.headword) missing.push('headword');
  if (!e.lemma) missing.push('lemma');
  if (e.pos.length === 0) missing.push('pos');
  if (!e.meaningVi || !e.meaningVi.trim()) missing.push('meaning_vi');
  if (e.completeSenseCount < 1) missing.push('sense có definition_en và definition_vi');
  if (e.exampleCount < 1) missing.push('ví dụ có example_en và example_vi');
  return missing;
}

export function evaluateJob(group: Group, word: string, job: JobObservation, publishPolicy: 'auto' | 'review'): Verdict {
  const expectation = jobExpectation(group, word);
  const reasons: string[] = [];
  const row = job.rows[0];

  if (expectation === 'none') {
    if (job.rows.length > 0) reasons.push(`không được có job nhưng có ${job.rows.length} (mới nhất: ${row.status}${row.reason ? ` / ${row.reason}` : ''})`);
    return fromReasons(reasons);
  }

  if (expectation === 'variant_if_any') {
    if (job.headwordEntryExists) reasons.push(`có mục từ mang headword "${word}" (không được tạo)`);
    if (row) {
      if (job.timedOut) reasons.push(`job chưa xong (${row.status})`);
      else if (row.status !== 'skipped' || row.reason !== 'variant_form') reasons.push(`job ${row.status}${row.reason ? ` / ${row.reason}` : ''}, mong đợi skipped / variant_form`);
    }
    return fromReasons(reasons);
  }

  // the job is required
  if (!row) return fromReasons(['không có job nào (enrichment không gửi job)']);
  if (job.timedOut || !TERMINAL_JOB_STATUSES.includes(row.status)) return fromReasons([`job chưa xong sau thời gian chờ (${row.status})`]);

  if (expectation === 'rejected_proper_noun') {
    if (row.status !== 'rejected' || row.reason !== 'proper_noun') reasons.push(`job ${row.status}${row.reason ? ` / ${row.reason}` : ''}, mong đợi rejected / proper_noun`);
    if (job.headwordEntryExists) reasons.push(`có mục từ mang headword "${word}" (không được tạo)`);
    return fromReasons(reasons);
  }

  // expectation === 'succeeded'
  if (row.status !== 'succeeded') return fromReasons([`job ${row.status}${row.reason ? ` / ${row.reason}` : ''}, mong đợi succeeded`]);
  const entry = job.entry;
  if (!entry) return fromReasons(['job succeeded nhưng không có mục từ [auto] nào cho từ này']);
  if (row.entryId && row.entryId !== entry.id) reasons.push('entry_id của job khác mục từ tìm thấy');

  const missing = tierAMissing(entry);
  if (missing.length > 0) reasons.push(`thiếu tầng A: ${missing.join(', ')}`);
  const expectedPublished = publishPolicy === 'auto' && missing.length === 0;
  if (entry.published !== expectedPublished) {
    reasons.push(`published=${entry.published}, mong đợi ${expectedPublished} (ENRICHMENT_PUBLISH_POLICY=${publishPolicy}${missing.length > 0 ? ', thiếu tầng A' : ''})`);
  }
  if (group === 'H') {
    if (entry.senseCount < 2) reasons.push(`mục từ có ${entry.senseCount} sense, mong đợi từ 2`);
    if (meaningParts(entry.meaningVi).length < 2) reasons.push(`meaning_vi có ${meaningParts(entry.meaningVi).length} nghĩa, mong đợi từ 2`);
  }
  return fromReasons(reasons);
}

// ── latency ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Nearest-rank percentile (p in 0..100). NaN for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export interface LatencyResult extends Verdict {
  p50: number;
  p95: number;
  limitMs: number;
  samples: number;
}

/** p95 of the fast path in groups C, D, E and H must not pass LOOKUP_TOTAL_DEADLINE_MS + 500 ms. */
export function evaluateLatency(samples: ReadonlyArray<{ group: Group; ms: number }>, totalDeadlineMs: number): LatencyResult {
  const limitMs = totalDeadlineMs + LATENCY_MARGIN_MS;
  const values = samples.filter((s) => TIMED_GROUPS.includes(s.group)).map((s) => s.ms);
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  if (values.length === 0) return { verdict: 'skip', reasons: ['không có mẫu thời gian của nhóm C, D, E, H'], p50, p95, limitMs, samples: 0 };
  const ok = p95 <= limitMs;
  return { verdict: ok ? 'pass' : 'fail', reasons: ok ? [] : [`p95 = ${Math.round(p95)} ms > ${limitMs} ms (LOOKUP_TOTAL_DEADLINE_MS ${totalDeadlineMs} + ${LATENCY_MARGIN_MS})`], p50, p95, limitMs, samples: values.length };
}
