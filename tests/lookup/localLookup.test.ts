import { FORM_TYPES, inferFormType, isKnownInReferenceData, lookupLocal, recordForm, resolveViaForms } from '../../services/lookup/localLookup';
import { UserRateLimiter } from '../../services/lookup/rateLimiter';
import type { Db } from '../../services/lookup/types';

const fakeDb = (handler: (sql: string, params: any[]) => any[]) => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const db: Db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: handler(sql, params) };
    },
  };
  return { db, calls };
};

describe('lookupLocal SQL', () => {
  it('only reads PUBLISHED entries and matches headword, lemma and word_forms, in that priority', async () => {
    const { db, calls } = fakeDb(() => []);
    await lookupLocal(db, 'ran');
    const sql = calls[0].sql;
    expect(sql).toContain('e.published = TRUE');
    expect(sql).toMatch(/LOWER\(e\.headword\) = \$1/);
    expect(sql).toMatch(/LOWER\(e\.lemma\) = \$1/);
    expect(sql).toMatch(/word_forms wf WHERE LOWER\(wf\.form_value\) = \$1/);
    expect(sql).toMatch(/ORDER BY CASE WHEN LOWER\(e\.headword\) = \$1 THEN 0 WHEN LOWER\(e\.lemma\) = \$1 THEN 1 ELSE 2 END/);
    expect(calls[0].params).toEqual(['ran']);
  });

  it('finds the candidates with a UNION of three index lookups, not an OR (an OR cannot use the lower() indexes: 42-56 ms at 200k entries)', async () => {
    const { db, calls } = fakeDb(() => []);
    await lookupLocal(db, 'ran');
    const flat = calls[0].sql.replace(/\s+/g, ' ');
    expect(flat).toContain('e.id IN (SELECT id FROM dictionary_entries WHERE LOWER(headword) = $1 UNION SELECT id FROM dictionary_entries WHERE LOWER(lemma) = $1 UNION SELECT wf.entry_id FROM word_forms wf WHERE LOWER(wf.form_value) = $1)');
    expect(flat).not.toContain('= $1 OR');
    expect(flat).not.toContain('OR e.id IN');
  });

  it('matched_form comes from the stored form value (original casing)', async () => {
    const { db } = fakeDb(() => [{ id: 'e', headword: 'run', lemma: 'run', word_forms: [{ form_value: 'Running' }] }]);
    expect(await lookupLocal(db, 'running')).toMatchObject({ matchedForm: 'Running' });
  });

  it('a lemma match is not a form match', async () => {
    const { db } = fakeDb(() => [{ id: 'e', headword: 'Better', lemma: 'good', word_forms: [] }]);
    expect(await lookupLocal(db, 'good')).toEqual({ entry: expect.objectContaining({ id: 'e' }) });
  });
});

describe('inferFormType (Wiktionary tags → word_forms.form_type)', () => {
  it.each([
    [['past'], 'past_simple'],
    [['past', 'participle'], 'past_participle'],
    [['present', 'participle'], 'present_participle'],
    [['third-person', 'singular'], 'third_person_singular'],
    [['plural'], 'plural'],
    [['comparative'], 'comparative'],
    [['superlative'], 'superlative'],
    [['possessive'], 'possessive'],
    [['Past', 'PARTICIPLE'], 'past_participle'],
  ])('%j → %s', (tags, expected) => {
    expect(inferFormType(tags)).toBe(expected);
  });

  it.each([[[]], [['dialectal']], [['singular']], [['participle']]])('%j → null (nothing is guessed)', (tags) => {
    expect(inferFormType(tags)).toBeNull();
  });

  it('only ever returns a value the CHECK constraint accepts', () => {
    for (const tags of [['past'], ['plural'], ['past', 'participle'], ['comparative']]) {
      expect(FORM_TYPES).toContain(inferFormType(tags));
    }
  });
});

describe('resolveViaForms', () => {
  const lemmaEntry = { id: 'e-run', headword: 'run', lemma: 'run' };

  it('returns the lemma entry, the lemma and the inferred form type', async () => {
    const ref = fakeDb(() => [{ lemma_of: 'Run', data: { senses: [{ glosses: ['past participle of run'], form_of: [{ word: 'run' }], tags: ['form-of', 'past', 'participle'] }] } }]);
    const main = fakeDb(() => [lemmaEntry]);
    const hit = await resolveViaForms(main.db, ref.db, 'run');
    expect(hit).toBeNull(); // lemma equals the word itself: not an inflection
    const hit2 = await resolveViaForms(main.db, ref.db, 'ran');
    expect(hit2).toMatchObject({ matchedForm: 'ran', lemma: 'run', formType: 'past_participle', entry: { id: 'e-run' } });
  });

  it('queries the reference table by word with lemma_of NOT NULL', async () => {
    const ref = fakeDb(() => []);
    await resolveViaForms(fakeDb(() => []).db, ref.db, 'ran');
    expect(ref.calls[0].sql).toContain('FROM ref_wiktionary_en WHERE word = $1 AND lemma_of IS NOT NULL');
    expect(ref.calls[0].params).toEqual(['ran']);
  });

  it('tries the next lemma when the first has no published entry', async () => {
    const ref = fakeDb(() => [{ lemma_of: 'ghost', data: {} }, { lemma_of: 'run', data: { tags: ['past'] } }]);
    const main = fakeDb((_sql, params) => (params[0] === 'run' ? [lemmaEntry] : []));
    expect(await resolveViaForms(main.db, ref.db, 'ran')).toMatchObject({ lemma: 'run', formType: 'past_simple' });
  });
});

describe('recordForm', () => {
  const hit = (over: any = {}) => ({ entry: { id: 'e-run', headword: 'run', lemma: 'run' }, matchedForm: 'ran', lemma: 'run', formType: 'past_simple', ...over });

  it('inserts idempotently', async () => {
    const { db, calls } = fakeDb(() => []);
    await recordForm(db, hit());
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('INSERT INTO word_forms');
    expect(calls[0].sql).toContain('ON CONFLICT DO NOTHING');
    expect(calls[0].params).toEqual(['e-run', 'past_simple', 'ran']);
  });

  it('writes nothing when the type is unknown or the form IS the headword/lemma', async () => {
    const { db, calls } = fakeDb(() => []);
    await recordForm(db, hit({ formType: null }));
    await recordForm(db, hit({ matchedForm: 'Run' }));
    expect(calls).toHaveLength(0);
  });
});

describe('isKnownInReferenceData', () => {
  it('true when either reference table knows the word', async () => {
    expect(await isKnownInReferenceData(fakeDb((sql) => (sql.includes('ref_wiktionary_en') ? [{}] : [])).db, 'x')).toBe(true);
    expect(await isKnownInReferenceData(fakeDb((sql) => (sql.includes('ref_word_frequency') ? [{}] : [])).db, 'x')).toBe(true);
    expect(await isKnownInReferenceData(fakeDb(() => []).db, 'x')).toBe(false);
  });
});

describe('UserRateLimiter', () => {
  it('is a sliding window per user', () => {
    let t = 0;
    const l = new UserRateLimiter(2, 60_000, () => t);
    expect(l.check('a').allowed).toBe(true);
    t = 30_000;
    expect(l.check('a').allowed).toBe(true);
    t = 31_000;
    expect(l.check('a')).toEqual({ allowed: false, retryAfterMs: 29_000 });
    expect(l.check('b').allowed).toBe(true);
    t = 60_001;
    expect(l.check('a').allowed).toBe(true); // the first hit slid out
  });

  it('refuses nonsense limits', () => {
    expect(() => new UserRateLimiter(0)).toThrow(RangeError);
  });

  it('does not let the map grow forever', () => {
    let t = 0;
    const l = new UserRateLimiter(1, 1000, () => t);
    for (let i = 0; i < 6000; i++) l.check(`u${i}`);
    t = 5000;
    l.check('late');
    expect((l as any).hits.size).toBeLessThan(10);
  });
});
