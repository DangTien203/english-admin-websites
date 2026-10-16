module.exports = [
  {
    file: 'services/lookup/lookupService.ts',
    edits: [
      // ── header ──────────────────────────────────────────────────────────────────────────────────────────────
      [
        ` *   →  F10 merge (§6 matrix)  →  F11 enrichment hook  →  F12 word_lookups
 *
 * Nothing about a temporary result is cached or stored in dictionary tables.
 */`,
        ` *   →  F10 merge (§6 matrix)  →  response  ⇢  F11 send the enrichment job  ⇢  F12 word_lookups
 *
 * F11 and F12 run AFTER the answer has been handed to the caller (spec 1.5): the deadline only bounds the outside calls, and a job
 * send (~0.5 s on a remote database) or an insert must not add its time to the visitor's wait. Whatever goes wrong there is logged
 * (structured, never the response); the word is still missing from the dictionary, so the next lookup tries to send the job again.
 *
 * Nothing about a temporary result is cached or stored in dictionary tables.
 */`,
      ],
      // ── instance state ───────────────────────────────────────────────────────────────────────────────────────
      [
        `export class WordLookupService {
  private refProbe?: { populated: boolean; at: number };`,
        `export class WordLookupService {
  private refProbe?: { populated: boolean; at: number };
  /** Work started after a response (job send, word_lookups insert) that has not finished yet. */
  private readonly pending = new Set<Promise<void>>();`,
      ],
      // ── the 503 branch ───────────────────────────────────────────────────────────────────────────────────────
      [
        `      this.recordLookup(input, null, 'not_found');
      // Both sources failed, but the word may be real: try again in the background later.
      const enrichment = await this.enrich(input, false, OUTAGE_JOB_DELAY_SECONDS);
      this.logLookup(input, { outcome: 'unavailable', source: 'none', partial: false, started, localMs, bundle, shared, enrichment });
      return { kind: 'unavailable' };`,
        `      this.recordLookup(input, null, 'not_found');
      // Both sources failed, but the word may be real: try again in the background later (the check of the word and the send both
      // happen after the 503 has gone out; there is no body to carry the answer anyway).
      const enabled = this.deps.config.enrichmentEnabled;
      if (enabled) this.afterResponse('enrich', input, () => this.sendIfTrusted(input, false, OUTAGE_JOB_DELAY_SECONDS));
      this.logLookup(input, { outcome: 'unavailable', source: 'none', partial: false, started, localMs, bundle, shared, enrichment: { status: enabled ? 'deferred' : 'disabled' } });
      return { kind: 'unavailable' };`,
      ],
      // ── the temporary answer ─────────────────────────────────────────────────────────────────────────────────
      [
        `    // F11 — enrichment hook (never able to break the response).
    const enrichment = await this.enrich(input, bundle.fd.status === 'found');
    const body = composeTemporary(merged, bundle, input.word.display, enrichment);

    // F12
    this.recordLookup(input, null, 'translation');
    this.logLookup(input, { outcome: 'temporary', source: 'translation', partial: body.partial, started, localMs, bundle, shared, enrichment });
    return { kind: 'temporary', body };`,
        `    // F11 — decide what the response says about the job; the job itself is sent after the response (never able to break it).
    const plan = await this.planEnrichment(input, bundle.fd.status === 'found');
    const body = composeTemporary(merged, bundle, input.word.display, plan.info);
    if (plan.send) this.afterResponse('enrich', input, () => this.sendJob(input));

    // F12
    this.recordLookup(input, null, 'translation');
    this.logLookup(input, { outcome: 'temporary', source: 'translation', partial: body.partial, started, localMs, bundle, shared, enrichment: plan.info });
    return { kind: 'temporary', body };`,
      ],
      // ── a way to wait for the background work ────────────────────────────────────────────────────────────────
      [
        `  // ── F4 / F4b ───────────────────────────────────────────────────────────────`,
        `  /** Resolves when everything started after a response has finished (tests; a caller that wants to drain before it exits). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ── F4 / F4b ───────────────────────────────────────────────────────────────`,
      ],
      // ── F11 ──────────────────────────────────────────────────────────────────────────────────────────────────
      [
        `  private async enrich(input: LookupInput, fdFound: boolean, startAfterSeconds?: number): Promise<EnrichmentInfo> {
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

  // ── F12 / logging ──────────────────────────────────────────────────────────`,
        `  /**
   * What the response says about the job, decided WITHOUT sending it (spec 1.5):
   *   disabled                  ENRICHMENT_ENABLED=false
   *   skipped / unknown_word    the word is not trusted (§7): no job will be sent
   *   queued                    the job is handed over to the background send. This is a promise to try, not a receipt: the real
   *                             answer (queued, already_queued, daily cap, queue error) is in the \`lookup_enrich\` log line.
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
   * Runs \`work\` after the current turn of the event loop, so the caller has already got its answer (a promise continuation, which
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

  // ── F12 / logging ──────────────────────────────────────────────────────────`,
      ],
      [
        `bundle?: UpstreamBundle; shared?: boolean; enrichment?: EnrichmentInfo }`,
        `bundle?: UpstreamBundle; shared?: boolean; enrichment?: { status: string } }`,
      ],
      [
        `  private recordLookup(input: LookupInput, entryId: string | null, result: 'dictionary' | 'translation' | 'not_found'): void {
    void this.deps.db
      .query(
        \`INSERT INTO word_lookups (user_id, entry_id, word_text, source, lookup_result, ebook_id, paragraph_id)
         VALUES ($1, $2, $3, 'ebook', $4, $5, $6)\`,
        [input.userId, entryId, input.word.display, result, input.ebookId, input.paragraphId]
      )
      .catch((err) => console.error('[ebooks] word_lookups insert failed:', err?.message ?? err));
  }`,
        `  private recordLookup(input: LookupInput, entryId: string | null, result: 'dictionary' | 'translation' | 'not_found'): void {
    this.afterResponse('word_lookups', input, async () => {
      await this.deps.db.query(
        \`INSERT INTO word_lookups (user_id, entry_id, word_text, source, lookup_result, ebook_id, paragraph_id)
         VALUES ($1, $2, $3, 'ebook', $4, $5, $6)\`,
        [input.userId, entryId, input.word.display, result, input.ebookId, input.paragraphId]
      );
    });
  }`,
      ],
    ],
  },
];
