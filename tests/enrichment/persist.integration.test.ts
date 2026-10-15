/**
 * S6 on a REAL PostgreSQL (the database in .env, like the other suites): the pipeline code and persist.ts run for real, the
 * sources (Wiktionary, Free Dictionary, Datamuse) and Claude Haiku are faked. No network.
 *
 * Every fixture lemma is "qzq<run>…" (random per run) and is deleted at the end (all child tables cascade), so a run never
 * touches real entries. A run that crashes may leave "qzq%" entries behind: delete them by hand.
 */
import pool from '../../config/db';
import { countRows } from '../../services/enrichment/assemble';
import type { DraftSuccess } from '../../services/enrichment/draft';
import type { Draft } from '../../services/enrichment/haiku/schema';
import { createPipeline, runPipeline, type EnrichmentJob, type PipelineDeps } from '../../services/enrichment/pipeline';
import { findExistingEntry, linkFormOnly, persistEntry, type PersistClient, type PersistPool } from '../../services/enrichment/persist';
import { loadTopicIds } from '../../services/enrichment/topics';
import type { SourceBundle } from '../../services/enrichment/types';
import { makeBundle, makeDraft, makeSense, wrow } from './fixtures';

jest.setTimeout(120_000);

const RUN = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const fx = (tag: string) => `qzq${RUN}${tag}`;
const writePool = pool as unknown as PersistPool;

const USAGE = { inputTokens: 600, outputTokens: 400, cacheCreationInputTokens: 0, cacheReadInputTokens: 7800, calls: 1 };
const noFlags = { onlyFormRows: false, onlyVariantRows: false, onlyProperNounRows: false, noSourceRecognizesWord: false };

/** Rows of the Wiktionary fixture for `lemma`; `withForms` puts the inflections into the row (as the dump does). */
function lemmaBundle(lemma: string, withForms = false): SourceBundle {
  return makeBundle({
    word: lemma,
    expectedLemma: lemma,
    wiktionaryRows: [
      wrow({
        word: lemma,
        pos: 'verb',
        senses: [{ glosses: ['To move quickly on foot.'], tags: ['intransitive'] }],
        ...(withForms
          ? { forms: [{ form: fx('ran'), tags: ['past'] }, { form: fx('running'), tags: ['participle', 'present'] }, { form: fx('runs'), tags: ['present', 'singular', 'third-person'] }] }
          : {}),
      }),
    ],
  });
}

function formBundle(word: string, lemma: string, tags: string[]): SourceBundle {
  return makeBundle({
    word,
    expectedLemma: lemma,
    formLemmas: [lemma],
    wiktionaryRows: [wrow({ word, pos: 'verb', lemma_of: lemma, senses: [{ glosses: [`form of ${lemma}`], tags: ['form-of', ...tags], form_of: [{ word: lemma }] }] })],
    lemmaRows: [wrow({ word: lemma, pos: 'verb' })],
    flags: { ...noFlags, onlyFormRows: true },
    datamuse: null,
  });
}

/** A rich draft: 2 senses (one with 4 meanings), synonyms, an idiom, a phrasal verb, a collocation, 2 topics. */
function richDraft(lemma: string, over: Partial<Draft> = {}): Draft {
  return makeDraft({
    headword: lemma,
    lemma,
    cefr_level: 'A1',
    topics: ['sports_recreation', 'health_medicine'],
    senses: [
      makeSense({
        pos: 'verb',
        definition_en: 'to move quickly on foot',
        meanings_vi: ['chạy', 'chạy bộ', 'chạy nhanh', 'chạy vội'],
        synonyms: ['sprint', 'dash'],
        antonyms: ['walk'],
        examples: [{ example_en: 'I run every morning.', example_vi: 'Sáng nào tôi cũng chạy bộ.' }, { example_en: 'Run, or you will miss it!', example_vi: 'Chạy đi, kẻo lỡ!' }],
      }),
      makeSense({ pos: 'noun', definition_en: 'an act of running', meanings_vi: ['cuộc chạy', 'buổi chạy'], synonyms: ['jog'], examples: [{ example_en: 'a morning run', example_vi: 'một buổi chạy sáng' }] }),
    ],
    idioms: [{ idiom_text: 'run out of steam', definition_en: 'to lose energy', definition_vi: 'hết hơi', example_en: 'He ran out of steam.', example_vi: 'Anh ấy hết hơi.' }],
    phrasal_verbs: [{ phrasal_verb: 'run into', particle: 'into', is_separable: false, definition_en: 'to meet by chance', definition_vi: 'tình cờ gặp', example_en: 'I ran into her.', example_vi: 'Tôi tình cờ gặp cô ấy.' }],
    collocations: [{ collocation: 'run a business', pattern: 'verb + noun', example_en: 'She runs a business.', example_vi: 'Cô ấy điều hành một doanh nghiệp.' }],
    is_transitive: true,
    is_countable: true,
    ...over,
  });
}

interface Harness {
  deps: PipelineDeps;
  haikuCalls: string[];
  collectCalls: string[];
}

function harness(opts: { policy?: 'review' | 'auto'; bundles?: Record<string, SourceBundle>; draft?: (word: string) => Draft; pool?: PersistPool } = {}): Harness {
  const haikuCalls: string[] = [];
  const collectCalls: string[] = [];
  const bundles = opts.bundles ?? {};
  const deps: PipelineDeps = {
    ensureTopics: () => loadTopicIds(pool),
    publishPolicy: () => opts.policy ?? 'review',
    findExisting: (words) => findExistingEntry(pool, words),
    collectSources: async (word) => {
      collectCalls.push(word);
      const b = bundles[word];
      if (!b) throw new Error(`no fixture bundle for ${word}`);
      return b;
    },
    generateDraft: async (bundle) => {
      haikuCalls.push(bundle.word);
      const draft = (opts.draft ?? ((w: string) => richDraft(w)))(bundle.word);
      const ok: DraftSuccess = { ok: true, draft, usage: { ...USAGE }, repaired: false, firstIssues: [], model: 'test-model', requestIds: [], callMs: [1] };
      return ok;
    },
    persist: (entry, ctx) => persistEntry(opts.pool ?? writePool, entry, ctx),
    linkForm: (id, form, type) => linkFormOnly(opts.pool ?? writePool, id, form, type),
  };
  return { deps, haikuCalls, collectCalls };
}

const job = (word: string, n = 1): EnrichmentJob => ({ word, requestedBy: null, ebookId: null, jobRowId: `it-${RUN}-${word}-${n}`, attempt: 1 });

const CHILD_TABLES = ['entry_senses', 'word_forms', 'entry_tags', 'entry_answer_aliases', 'entry_idioms', 'phrasal_verbs', 'collocations', 'entry_edit_history', 'entry_synonyms', 'entry_antonyms'];

async function entryRow(lemma: string) {
  return (await pool.query(`SELECT * FROM dictionary_entries WHERE lemma = $1`, [lemma])).rows;
}

async function counts(entryId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of CHILD_TABLES) out[t] = (await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE entry_id = $1`, [entryId])).rows[0].n;
  out.sense_examples = (await pool.query(`SELECT count(*)::int AS n FROM sense_examples x JOIN entry_senses s ON s.id = x.sense_id WHERE s.entry_id = $1`, [entryId])).rows[0].n;
  out.sense_synonyms = (await pool.query(`SELECT count(*)::int AS n FROM sense_synonyms x JOIN entry_senses s ON s.id = x.sense_id WHERE s.entry_id = $1`, [entryId])).rows[0].n;
  out.sense_antonyms = (await pool.query(`SELECT count(*)::int AS n FROM sense_antonyms x JOIN entry_senses s ON s.id = x.sense_id WHERE s.entry_id = $1`, [entryId])).rows[0].n;
  return out;
}

async function cleanup() {
  await pool.query(`DELETE FROM word_families WHERE family_root LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM dictionary_entries WHERE lemma LIKE $1 OR headword LIKE $1`, [`qzq${RUN}%`]);
}

beforeAll(async () => {
  await loadTopicIds(pool); // throws topics_not_seeded when docs/seed-topics.sql was not run
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await cleanup();
});

describe('one job → one entry with its child rows', () => {
  const L = fx('one');

  it('writes the entry and every child table with the expected number of rows, unpublished under the review policy', async () => {
    const h = harness({ bundles: { [L]: lemmaBundle(L) } });
    const report = await runPipeline(job(L), h.deps);
    expect(report.outcome).toMatchObject({ status: 'succeeded', model: 'test-model', inputTokens: 8400, outputTokens: 400 });
    const entryId = report.outcome.entryId!;

    const rows = await entryRow(L);
    expect(rows).toHaveLength(1);
    const e = rows[0];
    expect(e).toMatchObject({ id: entryId, headword: L, source: 'wiktionary', published: false, created_by: null, cefr_level: 'A1', pos: ['verb', 'noun'], is_transitive: false });
    expect(e.admin_note.startsWith('[auto] ')).toBe(true);
    expect(e.admin_note).toContain(`job: it-${RUN}-${L}-1`);
    expect(e.meaning_vi).toBe('chạy; cuộc chạy; chạy bộ; buổi chạy; chạy nhanh; chạy vội');
    expect(e.meaning_en).toBe('to move quickly on foot');
    expect(e.example_en).toBe('I run every morning.');
    expect(e.frequency_rank).toBe(705);

    const senses = (await pool.query(`SELECT pos, sense_order, definition_vi FROM entry_senses WHERE entry_id = $1 ORDER BY sense_order`, [entryId])).rows;
    expect(senses).toEqual([
      { pos: 'verb', sense_order: 0, definition_vi: 'chạy; chạy bộ; chạy nhanh; chạy vội' },
      { pos: 'noun', sense_order: 1, definition_vi: 'cuộc chạy; buổi chạy' },
    ]);

    // the rows written are exactly the rows assembleEntry planned
    const planned = countRows(report.assembled!);
    expect(planned).toMatchObject({ entry_senses: 2, sense_examples: 3, sense_synonyms: 3, sense_antonyms: 1, entry_tags: 2, entry_idioms: 1, phrasal_verbs: 1, collocations: 1 });
    const actual = await counts(entryId);
    for (const [table, n] of Object.entries(planned)) {
      if (table === 'dictionary_entries') continue;
      expect([table, actual[table]]).toEqual([table, n]);
    }
    expect(actual.entry_edit_history).toBe(1);
    expect(report.rows).toMatchObject({ entry_senses: 2, sense_examples: 3, entry_edit_history: 1 });
  });

  it('writes tags, aliases, the history line and the answer aliases the way spec §10 says', async () => {
    const [e] = await entryRow(L);
    const tags = (await pool.query(`SELECT t.name FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = $1 ORDER BY t.name`, [e.id])).rows.map((r) => r.name);
    expect(tags).toEqual(['health_medicine', 'sports_recreation']);

    const aliases = (await pool.query(`SELECT answer_text, normalized_answer, source, status, created_by FROM entry_answer_aliases WHERE entry_id = $1`, [e.id])).rows;
    expect(aliases).toEqual([]); // 6 meanings fit into meaning_vi, nothing is left over

    const history = (await pool.query(`SELECT field_name, admin_id, old_value, new_value FROM entry_edit_history WHERE entry_id = $1`, [e.id])).rows;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ field_name: 'auto_created', admin_id: null, old_value: null });
    expect(JSON.parse(history[0].new_value)).toEqual({ job_id: `it-${RUN}-${L}-1`, sources: expect.arrayContaining(['wiktionary', 'haiku']), model: 'test-model' });
  });

  it('meanings that do not fit into meaning_vi become answer aliases (source ai_accepted, status active, normalized)', async () => {
    const lemma = fx('alias');
    const draft = richDraft(lemma, {
      senses: [makeSense({ pos: 'verb', meanings_vi: ['Một', 'hai', 'ba', 'bốn'] }), makeSense({ pos: 'noun', meanings_vi: ['năm', 'sáu', 'bảy', 'Tám'] })],
    });
    const h = harness({ bundles: { [lemma]: lemmaBundle(lemma) }, draft: () => draft });
    const report = await runPipeline(job(lemma), h.deps);
    const aliases = (await pool.query(`SELECT answer_text, normalized_answer, source, status, created_by FROM entry_answer_aliases WHERE entry_id = $1 ORDER BY normalized_answer`, [report.outcome.entryId])).rows;
    // meaning_vi takes Một, năm, hai, sáu, ba, bảy (round robin, 6 of them); bốn and Tám are left over
    expect(aliases.map((a) => a.normalized_answer)).toEqual(['bốn', 'tám']);
    expect(aliases.every((a) => a.source === 'ai_accepted' && a.status === 'active' && a.created_by === null)).toBe(true);
  });

  it('the same job again adds nothing: skipped / exists, Haiku not called again, no new rows', async () => {
    const h = harness({ bundles: { [L]: lemmaBundle(L) } });
    const [e] = await entryRow(L);
    const before = await counts(e.id);
    const again = await runPipeline(job(L, 2), h.deps);
    expect(again.outcome).toMatchObject({ status: 'skipped', reason: 'exists', entryId: e.id });
    expect(h.haikuCalls).toEqual([]);
    expect(h.collectCalls).toEqual([]);
    expect(await counts(e.id)).toEqual(before);
    expect(await entryRow(L)).toHaveLength(1);
  });

  it('persisting the same assembled entry a second time (a re-run that got past S0) creates nothing', async () => {
    const [e] = await entryRow(L);
    const before = await counts(e.id);
    const h = harness({ bundles: { [L]: lemmaBundle(L) } });
    const dry = await runPipeline(job(L, 3), { ...h.deps, findExisting: async () => null }); // S0 blind: as if another job had just written it
    expect(dry.outcome).toMatchObject({ status: 'skipped', reason: 'exists', entryId: e.id });
    expect(await counts(e.id)).toEqual(before);
  });
});

describe('10 parallel jobs for the same word', () => {
  it('produce exactly ONE entry with exactly one set of child rows', async () => {
    const L = fx('ten');
    const h = harness({ bundles: { [L]: lemmaBundle(L) } });
    const pipeline = createPipeline(h.deps);
    const outcomes = await Promise.all(Array.from({ length: 10 }, (_, i) => pipeline(job(L, i))));

    expect(outcomes.filter((o) => o.status === 'succeeded')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'skipped' && o.reason === 'exists')).toHaveLength(9);
    expect(h.haikuCalls.length).toBeGreaterThanOrEqual(2); // they really raced: S0 did not stop them, the lock in S6 did
    const rows = await entryRow(L);
    expect(rows).toHaveLength(1);
    const c = await counts(rows[0].id);
    expect(c).toMatchObject({ entry_senses: 2, entry_tags: 2, entry_idioms: 1, phrasal_verbs: 1, collocations: 1, entry_edit_history: 1, sense_examples: 3 });
    expect(new Set(outcomes.map((o) => o.entryId)).size).toBe(1);
  });
});

describe('ran and running (inflections of the same lemma)', () => {
  const L = fx('run');
  const RAN = fx('ran');
  const RUNNING = fx('running');
  const bundles = { [L]: lemmaBundle(L), [RAN]: formBundle(RAN, L, ['past']), [RUNNING]: formBundle(RUNNING, L, ['gerund', 'participle', 'present']) };

  it('two jobs at the same time give ONE entry of the lemma, and its word_forms hold both forms once each', async () => {
    const h = harness({ bundles });
    const pipeline = createPipeline(h.deps);
    const [a, b] = await Promise.all([pipeline(job(RAN)), pipeline(job(RUNNING))]);

    expect([a.status, b.status].sort()).toEqual(['succeeded', 'succeeded']);
    expect([a.reason, b.reason].filter(Boolean)).toEqual(['form_linked']); // one wrote the lemma (no reason), the other linked its form
    const rows = await entryRow(L);
    expect(rows).toHaveLength(1);
    expect(a.entryId).toBe(b.entryId);
    const forms = (await pool.query(`SELECT form_type, form_value FROM word_forms WHERE entry_id = $1 ORDER BY form_value`, [rows[0].id])).rows;
    expect(forms).toEqual([
      { form_type: 'past_simple', form_value: RAN },
      { form_type: 'present_participle', form_value: RUNNING },
    ]);
    // each job enriched the LEMMA, never the inflected form
    expect(h.haikuCalls.every((w) => w === L)).toBe(true);
  });

  it('afterwards a job for one of the forms is "exists" at S0 — no sources, no Haiku', async () => {
    const h = harness({ bundles });
    const out = await createPipeline(h.deps)(job(RAN, 2));
    expect(out).toMatchObject({ status: 'skipped', reason: 'exists' });
    expect(h.collectCalls).toEqual([]);
    expect(h.haikuCalls).toEqual([]);
  });

  it('an inflection whose lemma entry exists is only linked (succeeded / form_linked) without Haiku, and never twice', async () => {
    const lemma = fx('go');
    const WENT = fx('went');
    const GOING = fx('going');
    const b = { [lemma]: lemmaBundle(lemma), [WENT]: formBundle(WENT, lemma, ['past']), [GOING]: formBundle(GOING, lemma, ['gerund', 'participle', 'present']) };
    const h0 = harness({ bundles: b });
    expect((await runPipeline(job(lemma), h0.deps)).outcome.status).toBe('succeeded');

    const h = harness({ bundles: b });
    const first = await runPipeline(job(WENT), h.deps);
    const second = await runPipeline(job(GOING), h.deps);
    expect(first.outcome).toMatchObject({ status: 'succeeded', reason: 'form_linked' });
    expect(second.outcome).toMatchObject({ status: 'succeeded', reason: 'form_linked' });
    expect(h.haikuCalls).toEqual([]);
    expect(h.collectCalls).toEqual([WENT, GOING]); // the lemma's sources are not fetched
    const [e] = await entryRow(lemma);
    const forms = (await pool.query(`SELECT form_type, form_value FROM word_forms WHERE entry_id = $1 ORDER BY form_value`, [e.id])).rows;
    expect(forms).toEqual([
      { form_type: 'present_participle', form_value: GOING },
      { form_type: 'past_simple', form_value: WENT },
    ]);

    // linking the same form again (direct call) adds no row, whatever the type
    expect(await linkFormOnly(writePool, e.id, WENT, 'past_simple')).toEqual({ linked: true });
    expect(await linkFormOnly(writePool, e.id, WENT.toUpperCase(), 'past_participle')).toEqual({ linked: true });
    expect((await pool.query(`SELECT count(*)::int AS n FROM word_forms WHERE entry_id = $1`, [e.id])).rows[0].n).toBe(2);
    // an unknown form type is not written
    expect(await linkFormOnly(writePool, e.id, fx('xyz'), null)).toEqual({ linked: false });
  });

  it('forms listed by Wiktionary for the lemma are written with the entry', async () => {
    const lemma = fx('walk');
    const h = harness({ bundles: { [lemma]: lemmaBundle(lemma, true) } });
    const out = await runPipeline(job(lemma), h.deps);
    const forms = (await pool.query(`SELECT form_type, form_value FROM word_forms WHERE entry_id = $1 ORDER BY form_value`, [out.outcome.entryId])).rows;
    expect(forms.map((f) => [f.form_type, f.form_value])).toEqual([
      ['past_simple', fx('ran')],
      ['present_participle', fx('running')],
      ['third_person_singular', fx('runs')],
    ]);
  });
});

describe('publication', () => {
  it('under the auto policy an entry that lacks a tier A field (no example) is NOT published', async () => {
    const lemma = fx('noex');
    const draft = richDraft(lemma, { senses: [makeSense({ pos: 'verb', examples: [] })] });
    const h = harness({ policy: 'auto', bundles: { [lemma]: lemmaBundle(lemma) }, draft: () => draft });
    const out = await runPipeline(job(lemma), h.deps);
    const [e] = await entryRow(lemma);
    expect(out.outcome.status).toBe('succeeded');
    expect(e.published).toBe(false);
    expect(e.admin_note).toContain('thiếu tầng A');
  });

  it('under the auto policy a complete entry is published, and missing tier B fields are listed but do not stop it', async () => {
    const lemma = fx('full');
    const h = harness({ policy: 'auto', bundles: { [lemma]: lemmaBundle(lemma) } });
    await runPipeline(job(lemma), h.deps);
    const [e] = await entryRow(lemma);
    expect(e.published).toBe(true);
    expect(e.admin_note).toMatch(/thiếu tầng B: [^·]*ipa/);
    await pool.query(`UPDATE dictionary_entries SET published = FALSE WHERE id = $1`, [e.id]); // fixtures never stay visible
  });

  it('under the review policy nothing is published, however complete', async () => {
    const lemma = fx('rev');
    await runPipeline(job(lemma), harness({ policy: 'review', bundles: { [lemma]: lemmaBundle(lemma) } }).deps);
    expect((await entryRow(lemma))[0].published).toBe(false);
  });
});

describe('a failure in any child table rolls the WHOLE transaction back', () => {
  /** A pool whose connections throw when the SQL contains `fragment` (after the earlier statements really ran). */
  const failingPool = (fragment: string, error: any = new Error('injected failure')): PersistPool => ({
    connect: async () => {
      const client = await pool.connect();
      const wrapped: PersistClient = {
        query: (sql, params) => {
          if (sql.includes(fragment)) return Promise.reject(error);
          return client.query(sql, params) as any;
        },
        release: () => client.release(),
      };
      return wrapped;
    },
  });

  it.each([
    'INSERT INTO entry_senses',
    'INSERT INTO sense_examples',
    'INSERT INTO word_forms',
    'INSERT INTO sense_synonyms',
    'INSERT INTO sense_antonyms',
    'INSERT INTO entry_tags',
    'INSERT INTO entry_answer_aliases',
    'INSERT INTO entry_idioms',
    'INSERT INTO phrasal_verbs',
    'INSERT INTO collocations',
    'INSERT INTO entry_edit_history',
  ])('%s fails → no entry, no orphan row, and a later clean run works', async (fragment) => {
    const lemma = fx('rb' + fragment.split(' ').pop()!.replace(/_/g, ''));
    const bundles = { [lemma]: lemmaBundle(lemma, true) };
    const draft = richDraft(lemma, {
      senses: [makeSense({ pos: 'verb', meanings_vi: ['a1', 'a2', 'a3', 'a4'], synonyms: ['x'], antonyms: ['y'] }), makeSense({ pos: 'noun', meanings_vi: ['b1', 'b2', 'b3', 'b4'] })],
    });

    const bad = harness({ bundles, draft: () => draft, pool: failingPool(fragment) });
    await expect(runPipeline(job(lemma), bad.deps)).rejects.toThrow('injected failure');

    expect(await entryRow(lemma)).toHaveLength(0);
    for (const t of ['entry_senses', 'word_forms', 'entry_idioms', 'phrasal_verbs', 'collocations', 'entry_edit_history', 'entry_answer_aliases']) {
      const orphan = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE entry_id NOT IN (SELECT id FROM dictionary_entries)`);
      expect(orphan.rows[0].n).toBe(0);
    }

    const good = harness({ bundles, draft: () => draft });
    expect((await runPipeline(job(lemma, 2), good.deps)).outcome).toMatchObject({ status: 'succeeded' });
    expect(await entryRow(lemma)).toHaveLength(1);
  });

  it('a unique violation (23505) from a parallel writer is treated as "already exists"', async () => {
    const lemma = fx('race');
    // The other writer commits an entry of the same lemma (headword in capitals, so the two rows do not block each other) and our
    // statement then fails with a unique violation.
    const racing: PersistPool = {
      connect: async () => {
        const client = await pool.connect();
        let raced = false;
        return {
          query: async (sql: string, params?: any[]) => {
            if (!raced && sql.includes('INSERT INTO entry_senses')) {
              raced = true;
              await pool.query(`INSERT INTO dictionary_entries (headword, lemma, meaning_vi, source, published) VALUES ($1, $2, 'đối thủ', 'wiktionary', FALSE)`, [lemma.toUpperCase(), lemma]);
              throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
            }
            return client.query(sql, params) as any;
          },
          release: () => client.release(),
        };
      },
    };
    const h = harness({ bundles: { [lemma]: lemmaBundle(lemma) }, pool: racing });
    const out = await runPipeline(job(lemma), h.deps);
    expect(out.outcome).toMatchObject({ status: 'skipped', reason: 'exists' });
    const rows = await entryRow(lemma);
    expect(rows).toHaveLength(1);
    expect(rows[0].meaning_vi).toBe('đối thủ'); // the other writer's entry is untouched
    expect((await counts(rows[0].id)).entry_senses).toBe(0); // and none of OUR rows was left behind
  });

  it('ON CONFLICT (headword, lemma) DO NOTHING: an entry that appears at INSERT time is "exists" too', async () => {
    const lemma = fx('conf');
    const racing: PersistPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, params?: any[]) => {
            if (sql.includes('INSERT INTO dictionary_entries')) {
              await pool.query(`INSERT INTO dictionary_entries (headword, lemma, meaning_vi, source, published) VALUES ($1, $1, 'đối thủ', 'wiktionary', FALSE) ON CONFLICT DO NOTHING`, [lemma]);
            }
            return client.query(sql, params) as any;
          },
          release: () => client.release(),
        };
      },
    };
    const out = await runPipeline(job(lemma), harness({ bundles: { [lemma]: lemmaBundle(lemma) }, pool: racing }).deps);
    expect(out.outcome).toMatchObject({ status: 'skipped', reason: 'exists' });
    expect(await entryRow(lemma)).toHaveLength(1);
  });
});

describe('relations that need existing entries', () => {
  it('entry_synonyms / word_families link ONLY to entries that already exist and are published; nothing is created to be linked', async () => {
    const friend = fx('friend');
    const lemma = fx('rel');
    // an existing published entry that the new entry names as a synonym and a derived word
    const { rows } = await pool.query(`INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, source, published) VALUES ($1, $1, '{noun}', 'bạn', 'manual', TRUE) RETURNING id`, [friend]);
    const friendId = rows[0].id;
    try {
      const bundle = lemmaBundle(lemma);
      bundle.wiktionaryRows[0].data.derived = [{ word: friend }, { word: fx('ghost') }];
      const draft = richDraft(lemma, { senses: [makeSense({ pos: 'verb', synonyms: [friend, fx('nothing')], antonyms: [] })] });
      const out = await runPipeline(job(lemma), harness({ bundles: { [lemma]: bundle }, draft: () => draft }).deps);
      const id = out.outcome.entryId!;

      expect((await pool.query(`SELECT synonym_id FROM entry_synonyms WHERE entry_id = $1`, [id])).rows).toEqual([{ synonym_id: friendId }]);
      const senseSyn = (await pool.query(`SELECT x.synonym_text, x.synonym_entry_id FROM sense_synonyms x JOIN entry_senses s ON s.id = x.sense_id WHERE s.entry_id = $1 ORDER BY x.synonym_text`, [id])).rows;
      expect(senseSyn.find((r) => r.synonym_text === friend)!.synonym_entry_id).toBe(friendId);
      expect(senseSyn.find((r) => r.synonym_text === fx('nothing'))!.synonym_entry_id).toBeNull();
      expect((await pool.query(`SELECT count(*)::int AS n FROM dictionary_entries WHERE lemma = ANY($1)`, [[fx('nothing'), fx('ghost')]])).rows[0].n).toBe(0);

      const family = (await pool.query(`SELECT f.family_root, m.entry_id, m.relation FROM word_families f JOIN word_family_members m ON m.family_id = f.id WHERE f.family_root = $1 ORDER BY m.relation`, [lemma])).rows;
      expect(family).toEqual([
        { family_root: lemma, entry_id: friendId, relation: 'noun_form' },
        { family_root: lemma, entry_id: id, relation: 'root' },
      ]);
    } finally {
      await pool.query(`DELETE FROM dictionary_entries WHERE id = $1`, [friendId]);
    }
  });

  it('an unpublished entry is never linked', async () => {
    const hidden = fx('hidden');
    const lemma = fx('rel2');
    const { rows } = await pool.query(`INSERT INTO dictionary_entries (headword, lemma, pos, meaning_vi, source, published) VALUES ($1, $1, '{noun}', 'ẩn', 'manual', FALSE) RETURNING id`, [hidden]);
    const draft = richDraft(lemma, { senses: [makeSense({ pos: 'verb', synonyms: [hidden] })] });
    const out = await runPipeline(job(lemma), harness({ bundles: { [lemma]: lemmaBundle(lemma) }, draft: () => draft }).deps);
    expect((await pool.query(`SELECT count(*)::int AS n FROM entry_synonyms WHERE entry_id = $1`, [out.outcome.entryId])).rows[0].n).toBe(0);
    await pool.query(`DELETE FROM dictionary_entries WHERE id = $1`, [rows[0].id]);
  });
});

describe('findExistingEntry', () => {
  it('matches headword, lemma and word_forms case-insensitively, published or not, and prefers headword over lemma over form', async () => {
    const lemma = fx('find');
    const form = fx('findforms');
    await runPipeline(job(lemma), harness({ bundles: { [lemma]: lemmaBundle(lemma) } }).deps);
    const [e] = await entryRow(lemma);
    await pool.query(`INSERT INTO word_forms (entry_id, form_type, form_value) VALUES ($1, 'plural', $2)`, [e.id, form]);

    expect(await findExistingEntry(pool, [lemma.toUpperCase()])).toMatchObject({ id: e.id, via: 'headword', published: false });
    expect(await findExistingEntry(pool, [form.toUpperCase()])).toMatchObject({ id: e.id, via: 'form' });
    expect(await findExistingEntry(pool, [fx('nothing')])).toBeNull();
    expect(await findExistingEntry(pool, [])).toBeNull();
    expect(await findExistingEntry(pool, ['  '])).toBeNull();
  });
});
