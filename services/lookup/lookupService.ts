import { UpstreamUnavailable } from '../upstream/errors';
import type { EnrichmentEnqueuer } from './enqueuer';
import { isKnownInReferenceData, lookupLocal, recordForm, resolveViaForms } from './localLookup';
import { composeTemporary, mergeOutcome } from './merge';
import type { UserRateLimiter } from './rateLimiter';
import type { SingleFlight } from './singleFlight';
import type { Db, EnrichmentInfo, LookupInput, LookupResult, UpstreamBundle } from './types';
import { fetchUpstream, UpstreamConfig, UpstreamDeps } from './upstream';

/**
 * The fast path of POST /ebooks/:id/lookup AFTER F1–F3 (word cleaning, paragraph check, counter),
 * docs/lookup-spec.md §5 F4–F12. Dependencies are injected so every branch is unit-testable.
 *
 *   F4/F4b local dictionary  →  F5 flag  →  F6 per-user limit  →  F7 single-flight  →  F8/F9 upstream
 *   →  F10 merge (§6 matrix)  →  F11 enrichment hook  →  F12 word_lookups
 *
 * Nothing about a temporary result is cached or stored in dictionary tables.
 */

export interface LookupServiceDeps {
  db: Db;
  /** Database holding ref_* tables (the main one unless REFDATA_DATABASE_URL is set). */
  refDb: Db;
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
}

/** After an outage the job waits this long so the upstream can recover (spec §6, last row). */
export const OUTAGE_JOB_DELAY_SECONDS = 60;

/** How long "the ref_wiktionary_en table is empty / populated" is remembered (spec §5 F4b: skip when empty). */
export const REF_PROBE_TTL_MS = 300_000;

export class WordLookupService {
  private refProbe?: { populated: boolean; at: number };
  private readonly now: () => number;
  private readonly log: (record: Record<string, unknown>) => void;

  constructor(private readonly deps: LookupServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((r) => console.info(JSON.stringify(r)));
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
        { google: this.deps.google, freeDictionary: this.deps.freeDictionary, config: this.deps.config, now: this.now },
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
      // Both sources failed, but the word may be real: try again in the background later.
      const enrichment = await this.enrich(input, false, OUTAGE_JOB_DELAY_SECONDS);
      this.logLookup(input, { outcome: 'unavailable', source: 'none', partial: false, started, localMs, bundle, shared, enrichment });
      return { kind: 'unavailable' };
    }

    // F11 — enrichment hook (never able to break the response).
    const enrichment = await this.enrich(input, bundle.fd.status === 'found');
    const body = composeTemporary(merged, bundle, input.word.display, enrichment);

    // F12
    this.recordLookup(input, null, 'translation');
    this.logLookup(input, { outcome: 'temporary', source: 'translation', partial: body.partial, started, localMs, bundle, shared, enrichment });
    return { kind: 'temporary', body };
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

  private async enrich(input: LookupInput, fdFound: boolean, startAfterSeconds?: number): Promise<EnrichmentInfo> {
    if (!this.deps.config.enrichmentEnabled) return { status: 'disabled' };
    try {
      // §7 "trusted word": Free Dictionary has it, or the local reference data knows it.
      const trusted = fdFound || (await isKnownInReferenceData(this.deps.refDb, input.word.normalized).catch(() => false));
      if (!trusted) return { status: 'skipped', reason: 'unknown_word' };

      return await this.deps.enqueuer.enqueue({
        word: input.word.normalized,
        requestedBy: input.userId,
        ebookId: input.ebookId,
        startAfterSeconds,
      });
    } catch (err: any) {
      console.error('[lookup] enrichment enqueue failed:', err?.message ?? err);
      return { status: 'skipped', reason: 'queue_error' };
    }
  }

  // ── F12 / logging ──────────────────────────────────────────────────────────

  private recordLookup(input: LookupInput, entryId: string | null, result: 'dictionary' | 'translation' | 'not_found'): void {
    void this.deps.db
      .query(
        `INSERT INTO word_lookups (user_id, entry_id, word_text, source, lookup_result, ebook_id, paragraph_id)
         VALUES ($1, $2, $3, 'ebook', $4, $5, $6)`,
        [input.userId, entryId, input.word.display, result, input.ebookId, input.paragraphId]
      )
      .catch((err) => console.error('[ebooks] word_lookups insert failed:', err?.message ?? err));
  }

  private logLookup(
    input: LookupInput,
    d: { outcome: string; source: string; partial: boolean; started: number; localMs?: number; reason?: string; bundle?: UpstreamBundle; shared?: boolean; enrichment?: EnrichmentInfo }
  ): void {
    try {
      this.log({
        evt: 'lookup',
        word: input.word.normalized,
        outcome: d.outcome,
        source: d.source,
        partial: d.partial,
        latency_ms: this.now() - d.started,
        local_ms: d.localMs ?? null,
        google_ms: d.bundle?.google.ms ?? null,
        fd_ms: d.bundle?.fd.ms ?? null,
        step2_ms: d.bundle?.step2.ms ?? null,
        google: d.bundle ? describe(d.bundle.google) : null,
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
}

/** Short, content-free description of one upstream outcome for the log. */
function describe(o: { status: string; error?: unknown }): string {
  if (o.status !== 'error') return o.status;
  const e = o.error;
  return e instanceof UpstreamUnavailable ? `error:${e.reason}` : `error:${(e as Error)?.name ?? 'unknown'}`;
}
