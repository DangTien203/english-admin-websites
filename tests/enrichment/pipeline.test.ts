import type { DraftFailure, DraftSuccess } from '../../services/enrichment/draft';
import { EnrichmentConfigError } from '../../services/enrichment/errors';
import type { Draft } from '../../services/enrichment/haiku/schema';
import { createPipeline, resolveFormType, runPipeline, type EnrichmentJob, type PipelineDeps } from '../../services/enrichment/pipeline';
import type { SourceBundle } from '../../services/enrichment/types';
import { BudgetExceeded, UpstreamConfigError, UpstreamUnavailable } from '../../services/upstream/errors';
import { makeBundle, makeDraft, makeSense, wrow } from './fixtures';

const TOPICS = new Map<string, string>([['business_economy', 'tag-business']]);
const USAGE = { inputTokens: 600, outputTokens: 400, cacheCreationInputTokens: 0, cacheReadInputTokens: 7800, calls: 1 };

const job = (word: string, over: Partial<EnrichmentJob> = {}): EnrichmentJob => ({ word, requestedBy: null, ebookId: null, jobRowId: 'job-1', attempt: 1, ...over });

const success = (draft: Draft): DraftSuccess => ({ ok: true, draft, usage: { ...USAGE }, repaired: false, firstIssues: [], model: 'test-model', requestIds: ['req_1'], callMs: [5] });
const failure = (): DraftFailure => ({
  ok: false,
  reason: 'invalid_output',
  details: [{ path: 'senses[0].meanings_vi[0]', code: 'parenthesis', message: 'x' }],
  firstIssues: [],
  usage: { ...USAGE, calls: 2 },
  model: 'test-model',
  requestIds: [],
  callMs: [1, 1],
});

const flags = (over: Partial<SourceBundle['flags']> = {}): SourceBundle['flags'] => ({ onlyFormRows: false, onlyVariantRows: false, onlyProperNounRows: false, noSourceRecognizesWord: false, ...over });

/** The bundle of an inflected form ("ran" of "run"): one form row pointing at the lemma, and the lemma's own rows. */
const formBundle = (word: string, lemma: string, tags: string[] = ['past']): SourceBundle =>
  makeBundle({
    word,
    expectedLemma: lemma,
    formLemmas: [lemma],
    wiktionaryRows: [wrow({ word, pos: 'verb', lemma_of: lemma, senses: [{ glosses: [`past tense of ${lemma}`], tags: ['form-of', ...tags], form_of: [{ word: lemma }] }] })],
    lemmaRows: [wrow({ word: lemma, pos: 'verb' })],
    flags: flags({ onlyFormRows: true }),
    datamuse: null,
  });

/** A plain bundle for `word` (its own Wiktionary row, so lemma_mismatch is not about missing rows). */
const plainBundle = (word: string, over: Partial<SourceBundle> = {}): SourceBundle =>
  makeBundle({ word, expectedLemma: word, wiktionaryRows: [wrow({ word, pos: 'noun', senses: [{ glosses: ['A thing.'], tags: ['countable'] }] })], ...over });

const draftFor = (word: string, over: Partial<Draft> = {}): Draft => makeDraft({ headword: word, lemma: word, ...over });

type Mocked = Record<'ensureTopics' | 'publishPolicy' | 'findExisting' | 'collectSources' | 'generateDraft' | 'persist' | 'linkForm', jest.Mock>;
const asDeps = (d: Mocked): PipelineDeps => d as unknown as PipelineDeps;

function makeDeps(over: Partial<Mocked> = {}): Mocked {
  const deps: Mocked = {
    ensureTopics: jest.fn(async () => TOPICS),
    publishPolicy: jest.fn(() => 'review' as const),
    findExisting: jest.fn(async (_words: string[]) => null as any),
    collectSources: jest.fn(async (word: string, _o: { signal?: AbortSignal }) => plainBundle(word)),
    generateDraft: jest.fn(async (bundle: SourceBundle, _o: { signal?: AbortSignal }) => success(draftFor(bundle.word)) as any),
    persist: jest.fn(async (_entry: any, _ctx: any) => ({ status: 'created', entryId: 'entry-1', rows: { dictionary_entries: 1 } }) as any),
    linkForm: jest.fn(async (_id: string, _form: string, _type: any) => ({ linked: true })),
    ...over,
  };
  return deps;
}

const run = (word: string, deps: Mocked) => createPipeline(asDeps(deps))(job(word));

describe('S0 — an entry already exists', () => {
  it('skipped / exists, no external service is called', async () => {
    const deps = makeDeps({ findExisting: jest.fn(async () => ({ id: 'e-1', published: false, via: 'headword', headword: 'bank', lemma: 'bank' })) });
    const out = await run('bank', deps);
    expect(out).toMatchObject({ status: 'skipped', reason: 'exists', entryId: 'e-1' });
    expect(deps.findExisting).toHaveBeenCalledWith(['bank']);
    expect(deps.collectSources).not.toHaveBeenCalled();
    expect(deps.generateDraft).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });
});

describe('S2 — decisions made before Haiku', () => {
  it('every row a misspelling / obsolete form → skipped / variant_form, Haiku NOT called', async () => {
    const deps = makeDeps({ collectSources: jest.fn(async (w: string) => makeBundle({ word: w, expectedLemma: null, flags: flags({ onlyVariantRows: true }) })) });
    const out = await run('recieve', deps);
    expect(out).toMatchObject({ status: 'skipped', reason: 'variant_form' });
    expect(deps.generateDraft).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('no source recognizes the word → rejected / unknown_word, Haiku NOT called', async () => {
    const deps = makeDeps({ collectSources: jest.fn(async (w: string) => makeBundle({ word: w, expectedLemma: null, wiktionaryRows: [], frequency: null, flags: flags({ noSourceRecognizesWord: true }) })) });
    const out = await run('asdfghjk', deps);
    expect(out).toMatchObject({ status: 'rejected', reason: 'unknown_word' });
    expect(deps.generateDraft).not.toHaveBeenCalled();
  });

  it('inflected form, entry of the lemma exists → only the form is added: succeeded / form_linked, Haiku NOT called', async () => {
    const deps = makeDeps({
      collectSources: jest.fn(async (w: string) => formBundle(w, 'run')),
      findExisting: jest.fn(async (words: string[]) => (words[0] === 'run' ? { id: 'e-run', published: false, via: 'lemma', headword: 'run', lemma: 'run' } : null)),
    });
    const out = await run('ran', deps);
    expect(out).toMatchObject({ status: 'succeeded', reason: 'form_linked', entryId: 'e-run' });
    expect(deps.linkForm).toHaveBeenCalledWith('e-run', 'ran', 'past_simple');
    expect(deps.generateDraft).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.collectSources).toHaveBeenCalledTimes(1); // the lemma's sources are not fetched again
    expect(out.inputTokens).toBeUndefined();
  });

  it('the form type comes from the tags of the form row (running → present_participle)', async () => {
    const deps = makeDeps({
      collectSources: jest.fn(async (w: string) => formBundle(w, 'run', ['gerund', 'participle', 'present'])),
      findExisting: jest.fn(async (words: string[]) => (words[0] === 'run' ? { id: 'e-run', published: true, via: 'headword', headword: 'run', lemma: 'run' } : null)),
    });
    await run('running', deps);
    expect(deps.linkForm).toHaveBeenCalledWith('e-run', 'running', 'present_participle');
  });

  it('inflected form whose type Wiktionary does not give → nothing to write: skipped / exists', async () => {
    const deps = makeDeps({
      collectSources: jest.fn(async (w: string) => formBundle(w, 'run', [])),
      findExisting: jest.fn(async (words: string[]) => (words[0] === 'run' ? { id: 'e-run', published: true, via: 'lemma', headword: 'run', lemma: 'run' } : null)),
      linkForm: jest.fn(async () => ({ linked: false })),
    });
    const out = await run('rans', deps);
    expect(out).toMatchObject({ status: 'skipped', reason: 'exists', entryId: 'e-run' });
    expect(deps.linkForm).toHaveBeenCalledWith('e-run', 'rans', null);
  });

  it('the lemma is itself found only as a form of another entry → skipped / exists, no form hung on a form', async () => {
    const deps = makeDeps({
      collectSources: jest.fn(async (w: string) => formBundle(w, 'run')),
      findExisting: jest.fn(async (words: string[]) => (words[0] === 'run' ? { id: 'e-x', published: true, via: 'form', headword: 'x', lemma: 'x' } : null)),
    });
    expect(await run('ran', deps)).toMatchObject({ status: 'skipped', reason: 'exists' });
    expect(deps.linkForm).not.toHaveBeenCalled();
  });

  it('inflected form, NO entry of the lemma → S1 again for the LEMMA, Haiku writes the lemma, the form is added in the same transaction', async () => {
    const collect = jest.fn(async (w: string) => (w === 'ran' ? formBundle('ran', 'run') : plainBundle('run')));
    const deps = makeDeps({ collectSources: collect });
    const out = await run('ran', deps);

    expect(collect.mock.calls.map((c) => c[0])).toEqual(['ran', 'run']);
    expect(deps.generateDraft).toHaveBeenCalledTimes(1);
    expect(deps.generateDraft.mock.calls[0][0].word).toBe('run'); // the draft is about the lemma
    const [entry, ctx] = deps.persist.mock.calls[0];
    expect(entry).toMatchObject({ headword: 'run', lemma: 'run' });
    expect(ctx.formLink).toEqual({ form: 'ran', type: 'past_simple' });
    expect(out).toMatchObject({ status: 'succeeded', entryId: 'entry-1', model: 'test-model' });
    expect(out.reason).toBeUndefined();
  });

  it('...and when another job wrote the lemma first, the form is still linked: succeeded / form_linked', async () => {
    const deps = makeDeps({
      collectSources: jest.fn(async (w: string) => (w === 'ran' ? formBundle('ran', 'run') : plainBundle('run'))),
      persist: jest.fn(async () => ({ status: 'exists', entryId: 'e-run', published: false, formLinked: true }) as any),
    });
    expect(await run('ran', deps)).toMatchObject({ status: 'succeeded', reason: 'form_linked', entryId: 'e-run' });
  });

  it('...and an entry that exists with nothing to link → skipped / exists (tokens are still reported)', async () => {
    const deps = makeDeps({ persist: jest.fn(async () => ({ status: 'exists', entryId: 'e-1', published: true, formLinked: false }) as any) });
    expect(await run('bank', deps)).toMatchObject({ status: 'skipped', reason: 'exists', entryId: 'e-1', inputTokens: 8400, outputTokens: 400 });
  });

  it('a lemma that is itself an inflected form of something else → skipped / lemma_mismatch (one hop only)', async () => {
    const deps = makeDeps({ collectSources: jest.fn(async (w: string) => (w === 'ran' ? formBundle('ran', 'run') : formBundle('run', 'rin'))) });
    expect(await run('ran', deps)).toMatchObject({ status: 'skipped', reason: 'lemma_mismatch' });
    expect(deps.generateDraft).not.toHaveBeenCalled();
  });

  it('a lemma whose rows are all misspellings → skipped / variant_form', async () => {
    const deps = makeDeps({ collectSources: jest.fn(async (w: string) => (w === 'ran' ? formBundle('ran', 'run') : makeBundle({ word: w, flags: flags({ onlyVariantRows: true }) }))) });
    expect(await run('ran', deps)).toMatchObject({ status: 'skipped', reason: 'variant_form' });
    expect(deps.generateDraft).not.toHaveBeenCalled();
  });
});

describe('S3 / S4 — what Haiku says', () => {
  it('proper noun → rejected / proper_noun (the tokens are reported)', async () => {
    const deps = makeDeps({ generateDraft: jest.fn(async (b: SourceBundle) => success(draftFor(b.word, { is_proper_noun: true, senses: [], pos: [], cefr_level: null, topics: [] })) as any) });
    const out = await run('london', deps);
    expect(out).toMatchObject({ status: 'rejected', reason: 'proper_noun', model: 'test-model', inputTokens: 8400, outputTokens: 400 });
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('not English → rejected / not_english', async () => {
    const deps = makeDeps({ generateDraft: jest.fn(async (b: SourceBundle) => success(draftFor(b.word, { is_english_word: false, senses: [], pos: [], cefr_level: null, topics: [] })) as any) });
    expect(await run('xin', deps)).toMatchObject({ status: 'rejected', reason: 'not_english' });
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('variant_of → skipped / variant_form', async () => {
    const deps = makeDeps({ generateDraft: jest.fn(async (b: SourceBundle) => success(draftFor(b.word, { variant_of: 'receive', senses: [], pos: [], cefr_level: null, topics: [] })) as any) });
    expect(await run('recieve', deps)).toMatchObject({ status: 'skipped', reason: 'variant_form' });
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('the draft\'s lemma is not the word → skipped / lemma_mismatch, no entry is created', async () => {
    const deps = makeDeps({
      collectSources: jest.fn(async (w: string) => makeBundle({ word: w, expectedLemma: null, wiktionaryRows: [] })),
      generateDraft: jest.fn(async () => success(draftFor('goose')) as any),
    });
    const out = await run('geese', deps);
    expect(out).toMatchObject({ status: 'skipped', reason: 'lemma_mismatch', model: 'test-model' });
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('invalid after the repair → failed / invalid_output, not retried (an outcome, not an error)', async () => {
    const deps = makeDeps({ generateDraft: jest.fn(async () => failure() as any) });
    const out = await run('bank', deps);
    expect(out).toMatchObject({ status: 'failed', reason: 'invalid_output', inputTokens: 8400, outputTokens: 400 });
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('a draft that cannot give a meaning_vi → failed / invalid_output, nothing written', async () => {
    const deps = makeDeps({ generateDraft: jest.fn(async (b: SourceBundle) => success(draftFor(b.word, { senses: [makeSense({ meanings_vi: [' '] })] })) as any) });
    expect(await run('bank', deps)).toMatchObject({ status: 'failed', reason: 'invalid_output' });
    expect(deps.persist).not.toHaveBeenCalled();
  });
});

describe('errors are thrown, not returned', () => {
  it('BudgetExceeded from Haiku propagates (the worker closes the row as skipped / budget)', async () => {
    const deps = makeDeps({ generateDraft: jest.fn(async () => { throw new BudgetExceeded('anthropic', 'spend_limit'); }) });
    await expect(run('bank', deps)).rejects.toBeInstanceOf(BudgetExceeded);
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('UpstreamUnavailable from a source (Free Dictionary failing) propagates so pg-boss retries', async () => {
    const deps = makeDeps({ collectSources: jest.fn(async () => { throw new UpstreamUnavailable('free_dictionary', 'timeout'); }) });
    await expect(run('bank', deps)).rejects.toBeInstanceOf(UpstreamUnavailable);
  });

  it('UpstreamUnavailable from Haiku propagates', async () => {
    const deps = makeDeps({ generateDraft: jest.fn(async () => { throw new UpstreamUnavailable('anthropic', 'http_5xx'); }) });
    await expect(run('bank', deps)).rejects.toBeInstanceOf(UpstreamUnavailable);
  });

  it('UpstreamConfigError propagates (the worker closes the row as failed / config_error)', async () => {
    const deps = makeDeps({ generateDraft: jest.fn(async () => { throw new UpstreamConfigError('anthropic', 'HTTP 401'); }) });
    await expect(run('bank', deps)).rejects.toBeInstanceOf(UpstreamConfigError);
  });

  it('a database error while writing propagates (transient: the job is retried)', async () => {
    const deps = makeDeps({ persist: jest.fn(async () => { throw new Error('connection terminated'); }) });
    await expect(run('bank', deps)).rejects.toThrow('connection terminated');
  });

  it('missing topic tags (topics_not_seeded) stop the job before anything else runs', async () => {
    const deps = makeDeps({ ensureTopics: jest.fn(async () => { throw new EnrichmentConfigError('topics_not_seeded', 'topics_not_seeded: 3 of 30'); }) });
    await expect(run('bank', deps)).rejects.toBeInstanceOf(EnrichmentConfigError);
    expect(deps.findExisting).not.toHaveBeenCalled();
  });
});

describe('the whole path, and what is passed on', () => {
  it('S0 → S5 → S6: a new entry is created and the outcome carries the entry id, the model, the tokens and the stage times', async () => {
    const deps = makeDeps();
    const out = await run('bank', deps);
    expect(out).toMatchObject({ status: 'succeeded', entryId: 'entry-1', model: 'test-model', inputTokens: 8400, outputTokens: 400 });
    expect(Object.keys(out.stagesMs!)).toEqual(['s0_exists', 's1_sources', 's3_haiku', 's5_assemble', 's6_persist']);
    const [entry, ctx] = deps.persist.mock.calls[0];
    expect(ctx).toEqual({ jobId: 'job-1', model: 'test-model', formLink: undefined });
    expect(entry.adminNote).toContain('job: job-1');
  });

  it('the publish policy decides published: review never, auto when tier A is complete', async () => {
    const review = makeDeps();
    await run('bank', review);
    expect(review.persist.mock.calls[0][0].published).toBe(false);

    const auto = makeDeps({ publishPolicy: jest.fn(() => 'auto' as const) });
    await run('bank', auto);
    expect(auto.persist.mock.calls[0][0].published).toBe(true);
  });

  it('the abort signal reaches every source call and Haiku', async () => {
    const controller = new AbortController();
    const collect = jest.fn(async (w: string, _o: { signal?: AbortSignal }) => (w === 'ran' ? formBundle('ran', 'run') : plainBundle('run')));
    const deps = makeDeps({ collectSources: collect });
    await createPipeline(asDeps(deps))(job('ran', { signal: controller.signal }));
    expect(collect.mock.calls.every((c) => c[1].signal === controller.signal)).toBe(true);
    expect(deps.generateDraft.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('dry run: S0–S5 only, nothing is written, the entry and the row counts are reported', async () => {
    const deps = makeDeps();
    const report = await runPipeline(job('bank'), asDeps(deps), { dryRun: true });
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.linkForm).not.toHaveBeenCalled();
    expect(report.outcome).toMatchObject({ status: 'succeeded', reason: 'dry_run' });
    expect(report.assembled?.headword).toBe('bank');
    expect(report.rows).toMatchObject({ dictionary_entries: 1, entry_senses: 1 });
  });

  it('dry run of an inflected form with an existing lemma entry does not link anything', async () => {
    const deps = makeDeps({
      collectSources: jest.fn(async (w: string) => formBundle(w, 'run')),
      findExisting: jest.fn(async (words: string[]) => (words[0] === 'run' ? { id: 'e-run', published: true, via: 'lemma', headword: 'run', lemma: 'run' } : null)),
    });
    const report = await runPipeline(job('ran'), asDeps(deps), { dryRun: true });
    expect(deps.linkForm).not.toHaveBeenCalled();
    expect(report.outcome).toMatchObject({ status: 'succeeded', reason: 'form_linked' });
    expect(report.formLink).toEqual({ form: 'ran', type: 'past_simple', lemma: 'run' });
  });

  it('reports every stage to onStage', async () => {
    const seen: string[] = [];
    await runPipeline(job('bank'), asDeps(makeDeps()), { onStage: (e) => seen.push(e.stage) });
    expect(seen).toEqual(['s0_exists', 's1_sources', 's3_haiku', 's5_assemble', 's6_persist']);
  });
});

describe('resolveFormType', () => {
  it('uses the tags of the sense of the form row that points at the lemma', () => {
    expect(resolveFormType(formBundle('ran', 'run', ['past']), 'run')).toBe('past_simple');
    expect(resolveFormType(formBundle('run', 'run2', ['past', 'participle']), 'run2')).toBe('past_participle');
    expect(resolveFormType(formBundle('children', 'child', ['plural']), 'child')).toBe('plural');
  });

  it('falls back to the forms listed by the lemma\'s own rows', () => {
    const b = formBundle('went', 'go', []);
    b.lemmaRows = [wrow({ word: 'go', pos: 'verb', forms: [{ form: 'went', tags: ['past'] }, { form: 'gone', tags: ['participle', 'past'] }] })];
    expect(resolveFormType(b, 'go')).toBe('past_simple');
  });

  it('is null when nothing says (no guess)', () => {
    expect(resolveFormType(formBundle('x', 'y', []), 'y')).toBeNull();
  });
});
