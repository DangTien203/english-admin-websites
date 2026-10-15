import type { FormType } from '../lookup/localLookup';
import { COLUMN_LIMITS, EXAMPLE_SOURCE, cut, countRows, type AssembledEntry } from './assemble';

/**
 * S6 — write one assembled entry (docs/lookup-spec.md §10; column names from docs/lookup-schema-notes.md and the live schema).
 *
 *   - ONE transaction. The first statement after BEGIN is pg_advisory_xact_lock(hashtextextended('enrich:' || lemma, 0)):
 *     jobs for the same lemma (ran, running, run ...) queue up here, and the existence check is repeated once the lock is held.
 *     The lock is taken only now, never while the job waits for Wiktionary / Free Dictionary / Haiku (spec §8 S0).
 *   - An entry that already exists is never touched. If the job came from an inflected form, the form is added to word_forms.
 *   - Every statement is ON CONFLICT DO NOTHING (tables with a key) or INSERT ... WHERE NOT EXISTS (tables without one).
 *     Nothing is deleted and rewritten. Any error rolls the whole transaction back: no half-written entry.
 *   - 23505 (a parallel writer got there first) is handled like "already exists".
 *   - One statement per table (unnest of arrays), so a transaction costs about 15 round trips, not one per row.
 */

/** The part of a pg client this module needs; tests wrap it to inject a failure. */
export interface PersistClient {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
  release: () => void;
}

export interface PersistPool {
  connect: () => Promise<PersistClient>;
}

export interface Queryable {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export interface ExistingEntry {
  id: string;
  published: boolean;
  /** what matched: the headword, the lemma, or an entry of word_forms */
  via: 'headword' | 'lemma' | 'form';
  headword: string;
  lemma: string;
}

/**
 * S0 / S2 lookup: an entry (published or not) whose headword, lemma or word_forms.form_value equals one of `words`
 * (case-insensitive; uses the lower() indexes of migration 33). Headword beats lemma beats form.
 */
export async function findExistingEntry(db: Queryable, words: string[]): Promise<ExistingEntry | null> {
  const keys = [...new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean))];
  if (keys.length === 0) return null;
  const { rows } = await db.query(
    `SELECT e.id, e.published, e.headword, e.lemma,
            CASE WHEN lower(e.headword) = ANY($1::text[]) THEN 'headword'
                 WHEN lower(e.lemma) = ANY($1::text[]) THEN 'lemma'
                 ELSE 'form' END AS via
       FROM dictionary_entries e
      WHERE e.id IN (SELECT id FROM dictionary_entries WHERE lower(headword) = ANY($1::text[])
                     UNION
                     SELECT id FROM dictionary_entries WHERE lower(lemma) = ANY($1::text[])
                     UNION
                     SELECT wf.entry_id FROM word_forms wf WHERE lower(wf.form_value) = ANY($1::text[]))
      ORDER BY CASE WHEN lower(e.headword) = ANY($1::text[]) THEN 0 WHEN lower(e.lemma) = ANY($1::text[]) THEN 1 ELSE 2 END, e.created_at
      LIMIT 1`,
    [keys]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return { id: r.id, published: Boolean(r.published), via: r.via, headword: r.headword, lemma: r.lemma };
}

const LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('enrich:' || $1::text, 0))`;

const FORM_LINK_SQL = `
  INSERT INTO word_forms (entry_id, form_type, form_value, sort_order)
  SELECT $1::uuid, $2::text, $3::text,
         COALESCE((SELECT MAX(sort_order) + 1 FROM word_forms WHERE entry_id = $1::uuid), 0)
   WHERE NOT EXISTS (SELECT 1 FROM word_forms WHERE entry_id = $1::uuid AND lower(form_value) = lower($3::text))
  ON CONFLICT (entry_id, form_type, form_value) DO NOTHING`;

export interface PersistContext {
  /** word_enrichment_jobs.id (or a command-line run id) */
  jobId: string;
  model: string | null;
  /** The inflected form the job started from; added to word_forms of the entry (created or already there). */
  formLink?: { form: string; type: FormType | null };
}

export type PersistResult =
  | { status: 'created'; entryId: string; rows: Record<string, number> }
  | { status: 'exists'; entryId: string; published: boolean; formLinked: boolean };

async function begin(client: PersistClient, lemma: string): Promise<void> {
  await client.query('BEGIN');
  await client.query(LOCK_SQL, [lemma]);
}

async function rollback(client: PersistClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // the connection is gone; the server rolls the transaction back by itself
  }
}

/** Adds a form to an existing entry inside the open transaction. Returns whether the form is now linked (a row was added or was already there). */
async function linkForm(client: PersistClient, entryId: string, link: NonNullable<PersistContext['formLink']>): Promise<boolean> {
  const form = cut(link.form.trim(), COLUMN_LIMITS.formValue);
  if (!form) return false;
  if (link.type) {
    await client.query(FORM_LINK_SQL, [entryId, link.type, form]);
  }
  const { rows } = await client.query(`SELECT 1 FROM word_forms WHERE entry_id = $1 AND lower(form_value) = lower($2) LIMIT 1`, [entryId, form]);
  return rows.length > 0;
}

/**
 * Writes `entry` (S6). Returns `created`, or `exists` when an entry with this headword / lemma is already there
 * (then `formLinked` says whether the job's inflected form is now in word_forms).
 */
export async function persistEntry(pool: PersistPool, entry: AssembledEntry, ctx: PersistContext): Promise<PersistResult> {
  const client = await pool.connect();
  try {
    await begin(client, entry.lemma);

    // Re-check under the lock: another job may have written this lemma while we were waiting for Haiku.
    const existing = await findExistingEntry(client, [entry.lemma, entry.headword]);
    if (existing) {
      const formLinked = ctx.formLink ? await linkForm(client, existing.id, ctx.formLink) : false;
      await client.query('COMMIT');
      return { status: 'exists', entryId: existing.id, published: existing.published, formLinked };
    }

    const entryId = await insertEntry(client, entry);
    if (!entryId) {
      // ON CONFLICT (headword, lemma) swallowed our row: a parallel writer. Treat as "already exists".
      await rollback(client);
      return await existsAfterRace(pool, entry, ctx);
    }

    const rows = await insertChildren(client, entryId, entry, ctx);
    if (ctx.formLink) await linkForm(client, entryId, ctx.formLink);
    await client.query('COMMIT');
    return { status: 'created', entryId, rows };
  } catch (err: any) {
    await rollback(client);
    if (err?.code === '23505') return await existsAfterRace(pool, entry, ctx);
    throw err;
  } finally {
    client.release();
  }
}

/** After a unique-violation race: the entry must be there now; add the form to it. */
async function existsAfterRace(pool: PersistPool, entry: AssembledEntry, ctx: PersistContext): Promise<PersistResult> {
  const client = await pool.connect();
  try {
    await begin(client, entry.lemma);
    const existing = await findExistingEntry(client, [entry.lemma, entry.headword]);
    if (!existing) throw new Error(`unique violation while writing "${entry.lemma}" but no such entry was found`);
    const formLinked = ctx.formLink ? await linkForm(client, existing.id, ctx.formLink) : false;
    await client.query('COMMIT');
    return { status: 'exists', entryId: existing.id, published: existing.published, formLinked };
  } catch (err) {
    await rollback(client);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Adds an inflected form to an entry that already exists (job: ran → run, entry "run" present). No Haiku involved.
 * Returns `linked: false` when the form type is unknown (the CHECK of word_forms.form_type allows 9 values only: nothing is guessed)
 * or when the entry is gone.
 */
export async function linkFormOnly(pool: PersistPool, entryId: string, form: string, type: FormType | null): Promise<{ linked: boolean }> {
  if (!type) return { linked: false };
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT lemma FROM dictionary_entries WHERE id = $1`, [entryId]);
    if (rows.length === 0) return { linked: false };
    await begin(client, rows[0].lemma);
    const linked = await linkForm(client, entryId, { form, type });
    await client.query('COMMIT');
    return { linked };
  } catch (err) {
    await rollback(client);
    throw err;
  } finally {
    client.release();
  }
}

// ── statements ───────────────────────────────────────────────────────────────────────────────────────────────────

async function insertEntry(client: PersistClient, e: AssembledEntry): Promise<string | null> {
  const { rows } = await client.query(
    `INSERT INTO dictionary_entries
       (headword, lemma, pos, ipa_us, ipa_uk, audio_us_url, audio_uk_url, meaning_vi, meaning_en, example_en, example_vi,
        cefr_level, frequency_rank, register, is_countable, is_transitive, etymology, source, published, admin_note, created_by)
     VALUES ($1, $2, $3::varchar[], $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NULL)
     ON CONFLICT (headword, lemma) DO NOTHING
     RETURNING id`,
    [
      e.headword,
      e.lemma,
      e.pos,
      e.ipaUs,
      e.ipaUk,
      e.audioUsUrl,
      e.audioUkUrl,
      e.meaningVi,
      e.meaningEn,
      e.exampleEn,
      e.exampleVi,
      e.cefrLevel,
      e.frequencyRank,
      e.register,
      e.isCountable,
      e.isTransitive,
      e.etymology,
      e.source,
      e.published,
      e.adminNote,
    ]
  );
  return rows[0]?.id ?? null;
}

/** Order of spec §10.4: senses, examples, forms, sense synonyms / antonyms, entry synonyms / antonyms, tags, aliases, idioms, phrasal verbs, collocations, history. */
async function insertChildren(client: PersistClient, entryId: string, e: AssembledEntry, ctx: PersistContext): Promise<Record<string, number>> {
  const counts: Record<string, number> = { dictionary_entries: 1 };
  const run = async (table: string, sql: string, params: any[]) => {
    const r = await client.query(sql, params);
    counts[table] = (counts[table] ?? 0) + (r.rowCount ?? r.rows.length ?? 0);
    return r;
  };

  // entry_senses (sense_order starts at 0; UNIQUE (entry_id, pos, sense_order))
  const senseIds = new Map<number, string>();
  if (e.senses.length > 0) {
    const r = await run(
      'entry_senses',
      `INSERT INTO entry_senses (entry_id, pos, sense_order, definition_en, definition_vi, register, domain, grammar_note, usage_note, region)
       SELECT $1::uuid, u.pos, u.ord, u.def_en, u.def_vi, u.register, u.domain, u.grammar, u.usage, u.region
         FROM unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
              AS u(pos, ord, def_en, def_vi, register, domain, grammar, usage, region)
       ON CONFLICT (entry_id, pos, sense_order) DO NOTHING
       RETURNING id, sense_order`,
      [
        entryId,
        e.senses.map((s) => s.pos),
        e.senses.map((s) => s.senseOrder),
        e.senses.map((s) => s.definitionEn),
        e.senses.map((s) => s.definitionVi),
        e.senses.map((s) => s.register),
        e.senses.map((s) => s.domain),
        e.senses.map((s) => s.grammarNote),
        e.senses.map((s) => s.usageNote),
        e.senses.map((s) => s.region),
      ]
    );
    for (const row of r.rows) senseIds.set(row.sense_order, row.id);
  }
  const idOf = (senseOrder: number): string => {
    const id = senseIds.get(senseOrder);
    if (!id) throw new Error(`entry_senses row for sense ${senseOrder} was not created`);
    return id;
  };

  // sense_examples (no unique key: WHERE NOT EXISTS)
  const examples = e.senses.flatMap((s) => s.examples.map((x) => ({ sid: idOf(s.senseOrder), x })));
  if (examples.length > 0) {
    await run(
      'sense_examples',
      `INSERT INTO sense_examples (sense_id, example_en, example_vi, sort_order, source)
       SELECT u.sid, u.en, u.vi, u.ord, u.src
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::int[], $5::text[]) AS u(sid, en, vi, ord, src)
        WHERE NOT EXISTS (SELECT 1 FROM sense_examples x WHERE x.sense_id = u.sid AND x.example_en = u.en)`,
      [examples.map((r) => r.sid), examples.map((r) => r.x.exampleEn), examples.map((r) => r.x.exampleVi), examples.map((r) => r.x.sortOrder), examples.map(() => EXAMPLE_SOURCE)]
    );
  }

  // word_forms
  if (e.forms.length > 0) {
    await run(
      'word_forms',
      `INSERT INTO word_forms (entry_id, form_type, form_value, sort_order)
       SELECT $1::uuid, u.t, u.v, u.ord FROM unnest($2::text[], $3::text[], $4::int[]) AS u(t, v, ord)
       ON CONFLICT (entry_id, form_type, form_value) DO NOTHING`,
      [entryId, e.forms.map((f) => f.formType), e.forms.map((f) => f.formValue), e.forms.map((f) => f.sortOrder)]
    );
  }

  // sense_synonyms / sense_antonyms (the text is kept as written; the link to an entry is set only for an existing PUBLISHED entry)
  const syn = e.senses.flatMap((s) => s.synonyms.map((t) => ({ sid: idOf(s.senseOrder), t })));
  if (syn.length > 0) {
    await run(
      'sense_synonyms',
      `INSERT INTO sense_synonyms (sense_id, synonym_text, synonym_entry_id)
       SELECT u.sid, u.t,
              (SELECT d.id FROM dictionary_entries d WHERE lower(d.lemma) = lower(u.t) AND d.published = TRUE AND d.id <> $1::uuid ORDER BY d.created_at LIMIT 1)
         FROM unnest($2::uuid[], $3::text[]) AS u(sid, t)
       ON CONFLICT (sense_id, synonym_text) DO NOTHING`,
      [entryId, syn.map((r) => r.sid), syn.map((r) => r.t)]
    );
  }
  const ant = e.senses.flatMap((s) => s.antonyms.map((t) => ({ sid: idOf(s.senseOrder), t })));
  if (ant.length > 0) {
    await run(
      'sense_antonyms',
      `INSERT INTO sense_antonyms (sense_id, antonym_text, antonym_entry_id)
       SELECT u.sid, u.t,
              (SELECT d.id FROM dictionary_entries d WHERE lower(d.lemma) = lower(u.t) AND d.published = TRUE AND d.id <> $1::uuid ORDER BY d.created_at LIMIT 1)
         FROM unnest($2::uuid[], $3::text[]) AS u(sid, t)
       ON CONFLICT (sense_id, antonym_text) DO NOTHING`,
      [entryId, ant.map((r) => r.sid), ant.map((r) => r.t)]
    );
  }

  // entry_synonyms / entry_antonyms: only entries that ALREADY exist and are published; nothing is created to be linked
  if (e.entrySynonymLemmas.length > 0) {
    await run(
      'entry_synonyms',
      `INSERT INTO entry_synonyms (entry_id, synonym_id)
       SELECT DISTINCT ON (lower(d.lemma)) $1::uuid, d.id FROM dictionary_entries d
        WHERE lower(d.lemma) = ANY($2::text[]) AND d.published = TRUE AND d.id <> $1::uuid
        ORDER BY lower(d.lemma), d.created_at
       ON CONFLICT DO NOTHING`,
      [entryId, e.entrySynonymLemmas]
    );
  }
  if (e.entryAntonymLemmas.length > 0) {
    await run(
      'entry_antonyms',
      `INSERT INTO entry_antonyms (entry_id, antonym_id)
       SELECT DISTINCT ON (lower(d.lemma)) $1::uuid, d.id FROM dictionary_entries d
        WHERE lower(d.lemma) = ANY($2::text[]) AND d.published = TRUE AND d.id <> $1::uuid
        ORDER BY lower(d.lemma), d.created_at
       ON CONFLICT DO NOTHING`,
      [entryId, e.entryAntonymLemmas]
    );
  }

  // entry_tags
  if (e.tagIds.length > 0) {
    await run('entry_tags', `INSERT INTO entry_tags (entry_id, tag_id) SELECT $1::uuid, t FROM unnest($2::uuid[]) AS t ON CONFLICT DO NOTHING`, [entryId, e.tagIds]);
  }

  // entry_answer_aliases: the unique index is partial (status = 'active'), so ON CONFLICT cannot name it: WHERE NOT EXISTS
  if (e.aliases.length > 0) {
    await run(
      'entry_answer_aliases',
      `INSERT INTO entry_answer_aliases (entry_id, answer_text, normalized_answer, source, status)
       SELECT $1::uuid, u.a, u.n, 'ai_accepted', 'active' FROM unnest($2::text[], $3::text[]) AS u(a, n)
        WHERE NOT EXISTS (SELECT 1 FROM entry_answer_aliases x WHERE x.entry_id = $1::uuid AND x.normalized_answer = u.n AND x.status = 'active')`,
      [entryId, e.aliases.map((a) => a.answerText), e.aliases.map((a) => a.normalizedAnswer)]
    );
  }

  // entry_idioms, phrasal_verbs, collocations (no unique key: WHERE NOT EXISTS)
  if (e.idioms.length > 0) {
    await run(
      'entry_idioms',
      `INSERT INTO entry_idioms (entry_id, idiom_text, definition_en, definition_vi, example_en, example_vi)
       SELECT $1::uuid, u.t, u.den, u.dvi, u.een, u.evi FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS u(t, den, dvi, een, evi)
        WHERE NOT EXISTS (SELECT 1 FROM entry_idioms x WHERE x.entry_id = $1::uuid AND lower(x.idiom_text) = lower(u.t))`,
      [entryId, e.idioms.map((i) => i.idiomText), e.idioms.map((i) => i.definitionEn), e.idioms.map((i) => i.definitionVi), e.idioms.map((i) => i.exampleEn), e.idioms.map((i) => i.exampleVi)]
    );
  }
  if (e.phrasalVerbs.length > 0) {
    await run(
      'phrasal_verbs',
      `INSERT INTO phrasal_verbs (entry_id, phrasal_verb, particle, is_separable, definition_en, definition_vi, example_en, example_vi)
       SELECT $1::uuid, u.pv, u.particle, u.sep, u.den, u.dvi, u.een, u.evi
         FROM unnest($2::text[], $3::text[], $4::bool[], $5::text[], $6::text[], $7::text[], $8::text[]) AS u(pv, particle, sep, den, dvi, een, evi)
        WHERE NOT EXISTS (SELECT 1 FROM phrasal_verbs x WHERE x.entry_id = $1::uuid AND lower(x.phrasal_verb) = lower(u.pv))`,
      [
        entryId,
        e.phrasalVerbs.map((p) => p.phrasalVerb),
        e.phrasalVerbs.map((p) => p.particle),
        e.phrasalVerbs.map((p) => p.isSeparable),
        e.phrasalVerbs.map((p) => p.definitionEn),
        e.phrasalVerbs.map((p) => p.definitionVi),
        e.phrasalVerbs.map((p) => p.exampleEn),
        e.phrasalVerbs.map((p) => p.exampleVi),
      ]
    );
  }
  if (e.collocations.length > 0) {
    await run(
      'collocations',
      `INSERT INTO collocations (entry_id, collocation, pattern, example_en, example_vi)
       SELECT $1::uuid, u.c, u.pattern, u.een, u.evi FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS u(c, pattern, een, evi)
        WHERE NOT EXISTS (SELECT 1 FROM collocations x WHERE x.entry_id = $1::uuid AND lower(x.collocation) = lower(u.c))`,
      [entryId, e.collocations.map((c) => c.collocation), e.collocations.map((c) => c.pattern), e.collocations.map((c) => c.exampleEn), e.collocations.map((c) => c.exampleVi)]
    );
  }

  // word_families: only when a derived / related word already is a published entry (never creates entries)
  if (e.familyWords.length > 0) {
    await insertFamily(client, entryId, e, counts);
  }

  // entry_edit_history: one line, field 'auto_created', no admin
  await run(
    'entry_edit_history',
    `INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value) VALUES ($1::uuid, NULL, 'auto_created', NULL, $2)`,
    [entryId, JSON.stringify({ job_id: ctx.jobId, sources: e.report.sources, model: ctx.model })]
  );

  return counts;
}

const FAMILY_RELATION: Record<string, string> = { noun: 'noun_form', verb: 'verb_form', adjective: 'adj_form', adverb: 'adv_form' };
const FAMILY_MEMBERS_MAX = 5;

async function insertFamily(client: PersistClient, entryId: string, e: AssembledEntry, counts: Record<string, number>): Promise<void> {
  const { rows: related } = await client.query(
    `SELECT DISTINCT ON (lower(d.lemma)) d.id, d.pos
       FROM dictionary_entries d
      WHERE lower(d.lemma) = ANY($1::text[]) AND d.published = TRUE AND d.id <> $2::uuid
      ORDER BY lower(d.lemma), d.created_at
      LIMIT ${FAMILY_MEMBERS_MAX}`,
    [e.familyWords, entryId]
  );
  if (related.length === 0) return;

  const root = cut(e.lemma, COLUMN_LIMITS.familyRoot);
  let familyId: string | undefined = (await client.query(`SELECT id FROM word_families WHERE lower(family_root) = lower($1) ORDER BY created_at LIMIT 1`, [root])).rows[0]?.id;
  if (!familyId) {
    const created = await client.query(`INSERT INTO word_families (family_root) VALUES ($1) RETURNING id`, [root]);
    familyId = created.rows[0].id as string;
    counts.word_families = 1;
  }
  const ids = [entryId, ...related.map((r) => r.id)];
  const relations = ['root', ...related.map((r) => FAMILY_RELATION[(Array.isArray(r.pos) ? r.pos[0] : '') as string] ?? 'other')];
  const r = await client.query(
    `INSERT INTO word_family_members (family_id, entry_id, relation)
     SELECT $1::uuid, u.id, u.rel FROM unnest($2::uuid[], $3::text[]) AS u(id, rel)
     ON CONFLICT (family_id, entry_id) DO NOTHING`,
    [familyId, ids, relations]
  );
  counts.word_family_members = r.rowCount ?? ids.length;
}

/** Expected rows per table for an entry (dry run). */
export { countRows };
