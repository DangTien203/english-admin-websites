import { redactSecrets } from '../../utils/redact';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../upstream/errors';
import type { EnrichmentEnqueuer } from './enqueuer';
import type { FastTranslator } from './fastTranslator';
import { isKnownInReferenceData, lookupLocal, recordForm, resolveViaForms } from './localLookup';
import { composeTemporary, mergeOutcome } from './merge';
import { lookupMetrics, type LookupMetrics } from './metrics';
import type { UserRateLimiter } from './rateLimiter';
import type { SingleFlight } from './singleFlight';
import type { Db, EnrichmentInfo, LookupInput, LookupResult, UpstreamBundle } from './types';
import { fetchUpstream, UpstreamConfig, UpstreamDeps } from './upstream';

/**
 * The fast path of POST /ebooks/:id/lookup AFTER F1–F3 (word cleaning, paragraph check, counter),
 * docs/lookup-spec.md §5 F4–F12. Dependencies are injected so every branch is unit-testable.
 *
 *   F4/F4b local dictionary  →  F5 flag  →  F6 per-user limit  →  F7 single-flight  →  F8/F9 upstream
 *   →  F10 merge (§6 matrix)  →  response  ⇢  F11 send the enrichment job  ⇢  F12 word_lookups
 *
 * F11 and F12 run AFTER the answer has been handed to the caller (spec 1.5): the deadline only bounds the outside calls, and a job
 * send (~0.5 s on a remote database) or an insert must not add its time to the visitor's wait. Whatever goes wrong there is logged
 * (structured, never the response); the word is still missing from the dictionary, so the next lookup tries to send the job again.
 *
 * Nothing about a temporary result is cached or stored in dictionary tables.
 */

export interface LookupServiceDeps {
  db: Db;
  /** Database holding ref_* tables (the main one unless REFDATA_DATABASE_URL is set). */
  refDb: Db;
  /** Step 1: short Vietnamese meanings (Google or Haiku, chosen by LOOKUP_FAST_TRANSLATOR). */
  translator: FastTranslator;
  /** Step 2 (definition translation) is always Google. */
  google: UpstreamDeps['google'];
  freeDictionary: UpstreamDeps['freeDictionary'];
  enqueuer: EnrichmentEnqueuer;
  rateLimiter: Pick<UserRateLimiter, 'check'>;
  singleFlight: Pick<SingleFlight<UpstreamBundle>, 'run'>;
  config: UpstreamConfig & {
    translationFallbackEnabled: boolean;
    enrichmentEnabled: boolean;
  };
  now?: () => number;
  /** Structured log sink (spec §12.1). Defaults to console.info(JSON). */
  log?: (record: Record<string, unknown>) => void;
  /** In-memory counters (spec §12.2). Defaults to the process-wide instance read by LookupHealthService. */
  metrics?: Pick<LookupMetrics, 'record'>;
}

/** After an outage the job waits this long so the upstream can recover (spec §6, last row). */
export const OUTAGE_JOB_DELAY_SECONDS = 60;

/** How long "the ref_wiktionary_en table is empty / populated" is remembered (spec §5 F4b: skip when empty). */
export const REF_PROBE_TTL_MS = 300_000;

export class WordLookupService {
  private refProbe?: { populated: boolean; at: number };
  /** Work started after a response (job send, word_lookups insert) that has not finished yet. */
  private readonly pending = new Set<Promise<void>>();
  /** Words whose job send is running right now in this process (see sendOnce). */
  private readonly sending = new Set<string>();
  private readonly now: () => number;
  private readonly log: (record: Record<string, unknown>) => void;
  private readonly metrics: Pick<LookupMetrics, 'record'>;

  constructor(private readonly deps: LookupServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((r) => console.info(redactSecrets(JSON.stringify(r))));
    this.metrics = deps.metrics ?? lookupMetrics;
  }

  async lookup(input: LookupInput): Promise<LookupResult> {
    const started = this.now();
    const word = input.word.normalized;

    // F4 / F4b — local, no external service is called.
    const local = await this.findLocally(word);
    const localMs = this.now() - started;
    if (local) {
      this.recordLookup(input, local.entry.id, 'dictionary');
      this.logLookup(input, { outcome: 'hit', source: 'dictionary', partial: false, started, localMs });
      return { kind: 'dictionary', entry: local.entry, matchedForm: local.matchedForm };
    }

    // F5 — emergency switch.
    if (!this.deps.config.translationFallbackEnabled) {
      this.recordLookup(input, null, 'not_found');
      this.logLookup(input, { outcome: 'not_found', source: 'none', partial: false, started, localMs, reason: 'fallback_disabled' });
      return { kind: 'not_found' };
    }

    // F6 — per-user limit for lookups that cost money.
    const gate = this.deps.rateLimiter.check(input.userId);
    if (!gate.allowed) {
      this.logLookup(input, { outcome: 'rate_limited', source: 'none', partial: false, started, localMs });
      return { kind: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil((gate.retryAfterMs ?? 1000) / 1000)) };
    }

    // F7 + F8 + F9 — one shared upstream flight per word.
    const { value: bundle, shared } = await this.deps.singleFlight.run(word, () =>
      fetchUpstream(
        word,
        { translator: this.deps.translator, google: this.deps.google, freeDictionary: this.deps.freeDictionary, config: this.deps.config, now: this.now },
        { startedAt: started }
      )
    );

    // F10 — merge.
    const merged = mergeOutcome(bundle, this.deps.config.maxMeanings);

    if (merged.kind === 'not_found') {
      // The word is unknown to both sources: no job (it is probably not a real word).
      this.recordLookup(input, null, 'not_found');
      this.logLookup(input, { outcome: 'not_found', source: 'none', partial: false, started, localMs, bundle, shared });
      return { kind: 'not_found' };
    }

    if (merged.kind === 'unavailable') {
      this.recordLookup(input, null, 'not_found');
      // Both sources failed, but the word may be real: try again in the background later (the check of the word and the send both
      // happen after the 503 has gone out; there is no body to carry the answer anyway).
      const enabled = this.deps.config.enrichmentEnabled;
      if (enabled) this.sendOnce(input, () => this.sendIfTrusted(input, false, OUTAGE_JOB_DELAY_SECONDS));
      this.logLookup(input, { outcome: 'unavailable', source: 'none', partial: false, started, localMs, bundle, shared, enrichment: { status: enabled ? 'deferred' : 'disabled' } });
      return { kind: 'unavailable' };
    }

    // F11 — decide what the response says about the job; the job itself is sent after the response (never able to break it).
    const plan = await this.planEnrichment(input, bundle.fd.status === 'found');
    const body = composeTemporary(merged, bundle, input.word.display, plan.info);
    if (plan.send) this.sendOnce(input, () => this.sendJob(input));

    // F12
    this.recordLookup(input, null, 'translation');
    this.logLookup(input, { outcome: 'temporary', source: 'translation', partial: body.partial, started, localMs, bundle, shared, enrichment: plan.info });
    return { kind: 'temporary', body };
  }

  /** Resolves when everything started after a response has finished (tests; a caller that wants to drain before it exits). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ── F4 / F4b ───────────────────────────────────────────────────────────────

  private async findLocally(word: string): Promise<{ entry: any; matchedForm?: string } | null> {
    const direct = await lookupLocal(this.deps.db, word);
    if (direct) return direct;

    // F4b is optional: a missing, empty or unreadable ref table must never break (or slow) a lookup.
    try {
      if (!(await this.isRefPopulated())) return null;
      const viaForm = await resolveViaForms(this.deps.db, this.deps.refDb, word);
      if (!viaForm) return null;
      void recordForm(this.deps.db, viaForm).catch((err) => console.error('[lookup] recording word form failed:', err?.message ?? err));
      return { entry: viaForm.entry, matchedForm: viaForm.matchedForm };
    } catch (err: any) {
      console.error('[lookup] form resolution skipped:', err?.message ?? err);
      return null;
    }
  }

  /** One cheap probe per REF_PROBE_TTL_MS instead of one ref query per dictionary miss while the table is empty. */
  private async isRefPopulated(): Promise<boolean> {
    const t = this.now();
    if (this.refProbe && t - this.refProbe.at < REF_PROBE_TTL_MS) return this.refProbe.populated;
    let populated = false;
    try {
      const { rows } = await this.deps.refDb.query(`SELECT EXISTS (SELECT 1 FROM ref_wiktionary_en LIMIT 1) AS populated`);
      populated = rows[0]?.populated === true;
    } catch (err: any) {
      console.error('[lookup] ref_wiktionary_en probe failed, form resolution skipped:', err?.message ?? err);
    }
    this.refProbe = { populated, at: t };
    return populated;
  }

  // ── F11 ────────────────────────────────────────────────────────────────────

  /**
   * What the response says about the job, decided WITHOUT sending it (spec 1.5):
   *   disabled                  ENRICHMENT_ENABLED=false
   *   skipped / unknown_word    the word is not trusted (§7): no job will be sent
   *   queued                    the job is handed over to the background send. This is a promise to try, not a receipt: the real
   *                             answer (queued, already_queued, daily cap, queue error) is in the `lookup_enrich` log line.
   * The trust check is a database read, so it is only made when Free Dictionary did not already vouch for the word.
   */
  private async planEnrichment(input: LookupInput, fdFound: boolean): Promise<{ info: EnrichmentInfo; send: boolean }> {
    if (!this.deps.config.enrichmentEnabled) return { info: { status: 'disabled' }, send: false };
    if (!(await this.isTrusted(input, fdFound))) return { info: { status: 'skipped', reason: 'unknown_word' }, send: false };
    return { info: { status: 'queued' }, send: true };
  }

  /** §7 "trusted word": Free Dictionary has it, or the local reference data knows it. */
  private async isTrusted(input: LookupInput, fdFound: boolean): Promise<boolean> {
    return fdFound || (await isKnownInReferenceData(this.deps.refDb, input.word.normalized).catch(() => false));
  }

  /**
   * Starts a background send, unless one for the same word is already running in this process. A burst of lookups of one word
   * (single-flight lets hundreds share one upstream call) would otherwise start one send each, all at once and with nobody waiting for
   * them any more; the queue admits one job per word anyway (policy exclusive, spec §7), so the extra sends could only come back
   * "already_queued". If the running send fails, the next lookup of the word sends again.
   */
  private sendOnce(input: LookupInput, work: () => Promise<void>): void {
    const word = input.word.normalized;
    if (this.sending.has(word)) return;
    this.sending.add(word);
    this.afterResponse('enrich', input, () => work().finally(() => this.sending.delete(word)));
  }

  /** Background: check the word, then send (used after a 503, where no response body exists to carry a plan). */
  private async sendIfTrusted(input: LookupInput, fdFound: boolean, startAfterSeconds?: number): Promise<void> {
    if (!(await this.isTrusted(input, fdFound))) {
      this.log({ evt: 'lookup_enrich', word: input.word.normalized, status: 'skipped', reason: 'unknown_word', delayed_s: startAfterSeconds ?? null });
      return;
    }
    await this.sendJob(input, startAfterSeconds);
  }

  /** Background: the send itself. An exception is reported by afterResponse(); a refusal (daily cap, already queued) is a normal answer. */
  private async sendJob(input: LookupInput, startAfterSeconds?: number): Promise<void> {
    const t0 = this.now();
    const result = await this.deps.enqueuer.enqueue({
      word: input.word.normalized,
      requestedBy: input.userId,
      ebookId: input.ebookId,
      startAfterSeconds,
    });
    this.log({
      evt: 'lookup_enrich',
      word: input.word.normalized,
      status: result.status,
      reason: result.reason ?? null,
      delayed_s: startAfterSeconds ?? null,
      enqueue_ms: this.now() - t0,
    });
  }

  // ── after the response ─────────────────────────────────────────────────────

  /**
   * Runs `work` after the current turn of the event loop, so the caller has already got its answer (a promise continuation, which
   * is where the route writes the response, runs before a setImmediate callback). Nobody waits for it. If it fails, ONE structured
   * error line is written; it never reaches the response, the metrics of the lookup or the next lookup.
   */
  private afterResponse(task: 'enrich' | 'word_lookups', input: LookupInput, work: () => Promise<void>): void {
    const run = new Promise<void>((resolve) => {
      setImmediate(() => {
        Promise.resolve()
          .then(work)
          .catch((err) => this.logBackgroundError(task, input, err))
          .then(() => resolve());
      });
    });
    this.pending.add(run);
    void run.then(() => this.pending.delete(run));
  }

  private logBackgroundError(task: string, input: LookupInput, err: unknown): void {
    try {
      console.error(redactSecrets(JSON.stringify({ evt: 'lookup_background_error', task, word: input.word.normalized, error: String((err as Error)?.message ?? err).slice(0, 200) })));
    } catch {
      /* reporting must never fail either */
    }
  }

  // ── F12 / logging ──────────────────────────────────────────────────────────

  private recordLookup(input: LookupInput, entryId: string | null, result: 'dictionary' | 'translation' | 'not_found'): void {
    this.afterResponse('word_lookups', input, async () => {
      await this.deps.db.query(
        `INSERT INTO word_lookups (user_id, entry_id, word_text, source, lookup_result, ebook_id, paragraph_id)
         VALUES ($1, $2, $3, 'ebook', $4, $5, $6)`,
        [input.userId, entryId, input.word.display, result, input.ebookId, input.paragraphId]
      );
    });
  }

  private logLookup(
    input: LookupInput,
    d: { outcome: string; source: string; partial: boolean; started: number; localMs?: number; reason?: string; bundle?: UpstreamBundle; shared?: boolean; enrichment?: { status: string } }
  ): void {
    try {
      this.metrics.record({ outcome: d.outcome, source: d.source, partial: d.partial, latencyMs: this.now() - d.started });
    } catch {
      /* counting must never break a lookup */
    }
    try {
      if (d.bundle) this.reportConfigProblems(d.bundle);
    } catch {
      /* neither must reporting */
    }
    try {
      this.log({
        evt: 'lookup',
        word: input.word.normalized,
        outcome: d.outcome,
        source: d.source,
        partial: d.partial,
        latency_ms: this.now() - d.started,
        local_ms: d.localMs ?? null,
        translator: d.bundle ? translatorLabel(d.bundle) : null,
        translation_ms: d.bundle?.translation.ms ?? null,
        // kept for the §12.1 field list: the Google headline time (null when Haiku answered)
        google_ms: d.bundle && d.bundle.translation.status === 'ok' && d.bundle.translation.engine === 'google' ? d.bundle.translation.ms : null,
        fallback_reason: d.bundle?.translation.status === 'ok' ? (d.bundle.translation.fallback?.reason ?? null) : null,
        haiku_tokens_in: d.bundle?.translation.status === 'ok' ? (d.bundle.translation.usage?.inputTokens ?? null) : null,
        haiku_tokens_out: d.bundle?.translation.status === 'ok' ? (d.bundle.translation.usage?.outputTokens ?? null) : null,
        fd_ms: d.bundle?.fd.ms ?? null,
        step2_ms: d.bundle?.step2.ms ?? null,
        google: d.bundle ? describe(d.bundle.translation) : null,
        fd: d.bundle ? describe(d.bundle.fd) : null,
        step2: d.bundle?.step2.status ?? null,
        shared: d.shared ?? false,
        enrichment_status: d.enrichment?.status ?? null,
        reason: d.reason ?? null,
      });
    } catch {
      /* logging must never break a lookup */
    }
  }

  /**
   * Spec §11.3: a 400 / 401 / 403 from a provider is a CONFIGURATION error (wrong key, no permission): it is logged at the
   * error level so it gets noticed, whatever the visitor sees. The provider's own spend / quota limit (§11.4) is the same kind
   * of problem. Our own monthly character counter is not: it shows in the lookup line (google: error:budget_monthly_chars).
   */
  private reportConfigProblems(bundle: UpstreamBundle): void {
    const outcomes: Array<[string, { status: string; error?: unknown }]> = [
      ['translation', bundle.translation],
      ['free_dictionary', bundle.fd],
      ['definitions', bundle.step2],
    ];
    for (const [where, o] of outcomes) {
      if (o.status !== 'error' && o.status !== 'failed') continue;
      const e = o.error;
      if (e instanceof UpstreamConfigError) {
        console.error(JSON.stringify({ evt: 'upstream_config_error', where, provider: e.provider, http_status: e.status ?? null }));
      } else if (e instanceof BudgetExceeded && e.reason !== 'monthly_chars') {
        console.error(JSON.stringify({ evt: 'upstream_budget_exceeded', where, provider: e.provider, reason: e.reason }));
      }
    }
  }
}

/** 'google', 'haiku' or 'google_fallback' (Haiku failed, Google answered) — for the logs. */
function translatorLabel(b: UpstreamBundle): string {
  const t = b.translation;
  if (t.status !== 'ok') return 'none';
  return t.fallback ? 'google_fallback' : t.engine;
}

/** Short, content-free description of one upstream outcome for the log. */
function describe(o: { status: string; error?: unknown }): string {
  if (o.status !== 'error') return o.status;
  const e = o.error;
  if (e instanceof UpstreamUnavailable) return `error:${e.reason}`;
  if (e instanceof BudgetExceeded) return `error:budget_${e.reason}`;
  if (e instanceof UpstreamConfigError) return `error:config_${e.status ?? 'none'}`;
  return `error:${(e as Error)?.name ?? 'unknown'}`;
}
