import { inferFormType, tagsForLemma, type FormType } from '../lookup/localLookup';
import { assembleEntry, countRows, type AssembleContext, type AssembledEntry, type PublishPolicy } from './assemble';
import { isDraftFailure, isDraftSuccess, type DraftResult } from './draft';
import type { ExistingEntry, PersistContext, PersistResult } from './persist';
import { isPrimaryRow } from './sources/wiktionary';
import type { SourceBundle } from './types';

/**
 * The enrichment pipeline called by the queue worker (docs/lookup-spec.md §8; full description in docs/lookup-enrichment.md).
 *
 *   S0  an entry already matches the word (headword, lemma, word_forms; published or not)        → skipped / exists
 *   S1  collect sources (Wiktionary, frequency, Datamuse; Free Dictionary only without Wiktionary)
 *   S2  decide:  every row a misspelling / obsolete form        → skipped / variant_form          (no Haiku)
 *               no source knows the word                         → rejected / unknown_word        (no Haiku)
 *               an inflected form of lemma L, entry of L exists  → add the form to word_forms     → succeeded / form_linked (no Haiku)
 *               an inflected form of L, no entry of L yet        → S1 again for L, enrich L, add the form in the same transaction
 *               otherwise                                        → enrich the word itself
 *   S3/S4  Haiku draft + validation (one repair at most)   invalid after the repair → failed / invalid_output
 *          proper noun → rejected / proper_noun · not English → rejected / not_english · variant_of → skipped / variant_form
 *          draft lemma ≠ the word → skipped / lemma_mismatch (no entry is created; an admin decides)
 *   S5  assembleEntry (pure)        S6  persistEntry (one transaction)
 *   S7  the outcome goes back to the worker, which writes word_enrichment_jobs and the `enrich` log line; token usage
 *       is added to api_usage_counters right after each Haiku call (services/enrichment/usage.ts), so it is counted even
 *       when a later stage fails.
 *
 * Contract with the worker (services/queue/enrichmentWorker.ts):
 *   - RETURN an outcome for every business result, including the "negative" ones (rejected, skipped,
 *     failed with invalid_output): the job is then completed and never retried.
 *   - THROW UpstreamUnavailable (or any unexpected error) for a transient problem: the worker puts the
 *     row back to `queued` and pg-boss retries with backoff. A Free Dictionary failure that is not a 404 is one of these.
 *   - THROW UpstreamConfigError or EnrichmentConfigError for a configuration problem (row → failed / config_error,
 *     no retry). Example: the 30 topic tags are missing from the `tags` table (topics_not_seeded).
 *   - THROW BudgetExceeded when a spend limit is hit (row → skipped / budget, no retry).
 *   - Honor `signal`: it aborts when the job expires or the process is shutting down.
 */

export interface EnrichmentJob {
  /** Normalized (lowercase) word. */
  word: string;
  requestedBy: string | null;
  ebookId: string | null;
  /** word_enrichment_jobs.id */
  jobRowId: string;
  /** Attempt number of this run (word_enrichment_jobs.attempts after the increment): 1, 2, 3, ... */
  attempt: number;
  signal?: AbortSignal;
}

export type EnrichmentOutcomeStatus = 'succeeded' | 'rejected' | 'skipped' | 'failed';

export interface EnrichmentOutcome {
  status: EnrichmentOutcomeStatus;
  /** Short code (docs/lookup-queue.md §9): unknown_word, proper_noun, not_english, variant_form, lemma_mismatch, exists, form_linked, invalid_output */
  reason?: string;
  entryId?: string | null;
  model?: string | null;
  /** All prompt tokens of the Haiku calls: input + cache writes + cache reads. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Milliseconds per stage (s0_exists, s1_sources, s1b_lemma_sources, s3_haiku, s5_assemble, s6_persist). */
  stagesMs?: Record<string, number>;
  /**
   * Only for failed / invalid_output: WHICH rules the last draft broke (validator code and field path, no text of the draft), and the
   * rules the first answer broke before the repair. Logged by the worker so that a batch with many invalid_output can be explained.
   */
  issues?: OutcomeIssue[];
  firstIssues?: OutcomeIssue[];
}

export interface OutcomeIssue {
  path: string;
  code: string;
}

const MAX_OUTCOME_ISSUES = 8;
const toOutcomeIssues = (list: ReadonlyArray<{ path: string; code: string }> | undefined): OutcomeIssue[] =>
  (list ?? []).slice(0, MAX_OUTCOME_ISSUES).map((i) => ({ path: String(i.path).slice(0, 80), code: String(i.code).slice(0, 40) }));

export const OUTCOME_STATUSES: readonly EnrichmentOutcomeStatus[] = ['succeeded', 'rejected', 'skipped', 'failed'];

export type RunEnrichment = (job: EnrichmentJob) => Promise<EnrichmentOutcome>;

export interface PipelineDeps {
  /**
   * Makes sure the environment can enrich at all and returns tags.id of the 30 topics. Throws
   * EnrichmentConfigError("topics_not_seeded") when the tags are missing.
   */
  ensureTopics: () => Promise<ReadonlyMap<string, string>>;
  publishPolicy: () => PublishPolicy;
  /** S0 and S2: an entry (published or not) matching any of these words. */
  findExisting: (words: string[]) => Promise<ExistingEntry | null>;
  collectSources: (word: string, opts: { signal?: AbortSignal }) => Promise<SourceBundle>;
  generateDraft: (bundle: SourceBundle, opts: { signal?: AbortSignal }) => Promise<DraftResult>;
  persist: (entry: AssembledEntry, ctx: PersistContext) => Promise<PersistResult>;
  linkForm: (entryId: string, form: string, type: FormType | null) => Promise<{ linked: boolean }>;
  assemble?: typeof assembleEntry;
}

export interface StageEvent {
  stage: string;
  ms: number;
  info?: Record<string, unknown>;
}

export interface RunOptions {
  /** Run S0–S5 (Haiku is called) and stop before S6: nothing is written. */
  dryRun?: boolean;
  onStage?: (event: StageEvent) => void;
}

/** What a run did, for the command-line tools and the tests. */
export interface PipelineReport {
  outcome: EnrichmentOutcome;
  /** The bundle the draft was written from (the lemma's own bundle when the word is an inflected form). */
  bundle?: SourceBundle;
  draft?: DraftResult;
  assembled?: AssembledEntry;
  persisted?: PersistResult;
  /** The form that was (or, in a dry run, would be) added to word_forms. */
  formLink?: { form: string; type: FormType | null; lemma: string };
  /** Rows per table (dry run: what would be written; real run: what was written). */
  rows?: Record<string, number>;
}

/** word_forms.form_type of `bundle.word` as an inflection of `lemma`, or null when Wiktionary does not say (nothing is guessed). */
export function resolveFormType(bundle: SourceBundle, lemma: string): FormType | null {
  for (const row of bundle.wiktionaryRows.filter((r) => isPrimaryRow(bundle.word, r) && r.lemma_of === lemma)) {
    const type = inferFormType(tagsForLemma(row.data, lemma));
    if (type) return type;
  }
  for (const row of bundle.lemmaRows) {
    for (const f of Array.isArray(row.data?.forms) ? row.data.forms : []) {
      if (String(f?.form ?? '').toLowerCase() !== bundle.word) continue;
      const tags = (Array.isArray(f?.tags) ? f.tags : []).filter((t: unknown): t is string => typeof t === 'string');
      const type = inferFormType(tags);
      if (type) return type;
    }
  }
  return null;
}

const totalInput = (u: { inputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }): number =>
  u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;

export async function runPipeline(job: EnrichmentJob, deps: PipelineDeps, options: RunOptions = {}): Promise<PipelineReport> {
  const stagesMs: Record<string, number> = {};
  const signal = job.signal;
  const assemble = deps.assemble ?? assembleEntry;

  const stage = async <T>(name: string, fn: () => Promise<T> | T, info?: (result: T) => Record<string, unknown>): Promise<T> => {
    const started = Date.now();
    try {
      const result = await fn();
      stagesMs[name] = Date.now() - started;
      options.onStage?.({ stage: name, ms: stagesMs[name], info: info?.(result) });
      return result;
    } catch (err) {
      stagesMs[name] = Date.now() - started;
      throw err;
    }
  };

  const done = (outcome: EnrichmentOutcome, rest: Omit<PipelineReport, 'outcome'> = {}): PipelineReport => ({ outcome: { ...outcome, stagesMs: { ...stagesMs } }, ...rest });

  const topicIds = await deps.ensureTopics();

  // ── S0: quick existence check, no lock (the advisory lock is only taken inside the S6 transaction) ──
  const existing = await stage('s0_exists', () => deps.findExisting([job.word]), (e) => ({ found: e ? `${e.via}:${e.id}` : null }));
  if (existing) return done({ status: 'skipped', reason: 'exists', entryId: existing.id });

  // ── S1: sources of the word itself ──
  const first = await stage(
    's1_sources',
    () => deps.collectSources(job.word, { signal }),
    (b) => ({ wiktionaryRows: b.wiktionaryRows.length, freeDictionary: b.freeDictionary.status, frequency: b.frequency?.rank ?? null, flags: b.flags, errors: b.sourceErrors })
  );

  // ── S2: decide ──
  if (first.flags.onlyVariantRows) return done({ status: 'skipped', reason: 'variant_form' }, { bundle: first });
  if (first.flags.noSourceRecognizesWord) return done({ status: 'rejected', reason: 'unknown_word' }, { bundle: first });

  let work = first;
  let formLink: PipelineReport['formLink'];
  if (first.flags.onlyFormRows && first.expectedLemma && first.expectedLemma !== first.word) {
    const lemma = first.expectedLemma;
    const type = resolveFormType(first, lemma);
    formLink = { form: first.word, type, lemma };
    options.onStage?.({ stage: 's2_decide', ms: 0, info: { inflectedFormOf: lemma, formType: type } });

    const lemmaEntry = await stage('s2_lemma_entry', () => deps.findExisting([lemma]), (e) => ({ found: e ? `${e.via}:${e.id}` : null }));
    if (lemmaEntry) {
      if (lemmaEntry.via === 'form') {
        // "run" is itself only a form of another entry: do not hang a form on a form.
        return done({ status: 'skipped', reason: 'exists', entryId: lemmaEntry.id }, { bundle: first, formLink });
      }
      if (options.dryRun) return done({ status: 'succeeded', reason: 'form_linked', entryId: lemmaEntry.id }, { bundle: first, formLink });
      const linked = await stage('s6_persist', () => deps.linkForm(lemmaEntry.id, first.word, type), (r) => ({ linked: r.linked }));
      return linked.linked
        ? done({ status: 'succeeded', reason: 'form_linked', entryId: lemmaEntry.id }, { bundle: first, formLink })
        : done({ status: 'skipped', reason: 'exists', entryId: lemmaEntry.id }, { bundle: first, formLink }); // the form type is unknown: nothing to write
    }

    // No entry of the lemma yet: enrich the LEMMA (its own rows, its own frequency, its own Datamuse candidates).
    work = await stage(
      's1b_lemma_sources',
      () => deps.collectSources(lemma, { signal }),
      (b) => ({ wiktionaryRows: b.wiktionaryRows.length, frequency: b.frequency?.rank ?? null, flags: b.flags })
    );
    if (work.flags.onlyVariantRows) return done({ status: 'skipped', reason: 'variant_form' }, { bundle: work, formLink });
    if (work.flags.noSourceRecognizesWord) return done({ status: 'rejected', reason: 'unknown_word' }, { bundle: work, formLink });
    if (work.flags.onlyFormRows && work.expectedLemma && work.expectedLemma !== work.word) {
      // A form of a form (one hop only): an admin decides.
      return done({ status: 'skipped', reason: 'lemma_mismatch' }, { bundle: work, formLink });
    }
  }

  // ── S3 / S4: Haiku draft and its validation ──
  const draft = await stage(
    's3_haiku',
    () => deps.generateDraft(work, { signal }),
    (r) => ({ ok: r.ok, calls: r.usage.calls, repaired: isDraftSuccess(r) ? r.repaired : undefined, inputTokens: totalInput(r.usage), outputTokens: r.usage.outputTokens })
  );
  const tokens = { inputTokens: totalInput(draft.usage), outputTokens: draft.usage.outputTokens, model: draft.model };

  if (isDraftFailure(draft)) {
    return done({ status: 'failed', reason: 'invalid_output', ...tokens, issues: toOutcomeIssues(draft.details), firstIssues: toOutcomeIssues(draft.firstIssues) }, { bundle: work, draft, formLink });
  }
  const d = draft.draft;
  if (d.is_proper_noun) return done({ status: 'rejected', reason: 'proper_noun', ...tokens }, { bundle: work, draft, formLink });
  if (!d.is_english_word) return done({ status: 'rejected', reason: 'not_english', ...tokens }, { bundle: work, draft, formLink });
  if (d.variant_of) return done({ status: 'skipped', reason: 'variant_form', ...tokens }, { bundle: work, draft, formLink });
  if (d.lemma.toLowerCase() !== work.word) {
    // No entry is created: the word would not be found by its own spelling. An admin decides.
    return done({ status: 'skipped', reason: 'lemma_mismatch', ...tokens }, { bundle: work, draft, formLink });
  }

  // ── S5: merge ──
  const ctx: AssembleContext = { jobId: job.jobRowId, model: draft.model ?? '', publishPolicy: deps.publishPolicy(), topicIds };
  const assembled = await stage('s5_assemble', () => assemble(work, d, ctx));
  if (assembled.status === 'invalid_output') {
    // not a rule of the validator: the entry could not be assembled (for example no usable meaning_vi)
    return done({ status: 'failed', reason: 'invalid_output', ...tokens, issues: [{ path: '$', code: 'assemble' }] }, { bundle: work, draft, formLink });
  }
  const entry = assembled.entry;

  if (options.dryRun) {
    return done({ status: 'succeeded', reason: 'dry_run', ...tokens }, { bundle: work, draft, assembled: entry, formLink, rows: countRows(entry) });
  }

  // ── S6: one transaction ──
  const persisted = await stage('s6_persist', () => deps.persist(entry, { jobId: job.jobRowId, model: draft.model, formLink: formLink ? { form: formLink.form, type: formLink.type } : undefined }), (r) => ({ result: r.status }));
  const rest = { bundle: work, draft, assembled: entry, persisted, formLink };
  if (persisted.status === 'created') return done({ status: 'succeeded', entryId: persisted.entryId, ...tokens }, { ...rest, rows: persisted.rows });
  // Another job wrote this lemma first.
  return persisted.formLinked
    ? done({ status: 'succeeded', reason: 'form_linked', entryId: persisted.entryId, ...tokens }, rest)
    : done({ status: 'skipped', reason: 'exists', entryId: persisted.entryId, ...tokens }, rest);
}

/** The worker-facing function: runPipeline without the report. */
export function createPipeline(deps: PipelineDeps): RunEnrichment {
  return async (job) => (await runPipeline(job, deps)).outcome;
}

let defaultPipeline: RunEnrichment | undefined;

/**
 * The real pipeline (real database, Wiktionary reference data, Free Dictionary, Datamuse, Claude Haiku). Built on first use so that
 * importing this module (the worker tests do) does not construct the upstream clients.
 */
export const runEnrichment: RunEnrichment = async (job) => {
  if (!defaultPipeline) {
    const { createProductionDeps } = await import('./wiring');
    defaultPipeline = createPipeline(createProductionDeps());
  }
  return defaultPipeline(job);
};
