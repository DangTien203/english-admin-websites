module.exports = [
  {
    file: 'services/lookup/localLookup.ts',
    edits: [
      [
        `/**
 * F4: published entry matching headword, lemma or any word_forms.form_value (case-insensitive).
 * headword beats lemma beats form when several entries match.
 */`,
        `/**
 * F4: published entry matching headword, lemma or any word_forms.form_value (case-insensitive).
 * headword beats lemma beats form when several entries match.
 *
 * The three ways to match are a UNION of three index lookups, not an OR inside one WHERE: with an OR, PostgreSQL cannot use the
 * lower(headword) / lower(lemma) indexes (a hashed sub-plan in an OR branch is not indexable), so it reads EVERY entry for EVERY
 * lookup. Measured with 200,000 entries: 42–56 ms per lookup with the OR, 0.1 ms with the UNION; at the 852 entries of today both
 * are under a millisecond (docs/lookup-loadtest.md §3). Same rows, same order.
 */`,
      ],
      [
        `     WHERE e.published = TRUE
       AND (LOWER(e.headword) = $1
            OR LOWER(e.lemma) = $1
            OR e.id IN (SELECT wf.entry_id FROM word_forms wf WHERE LOWER(wf.form_value) = $1))
     ORDER BY`,
        `     WHERE e.published = TRUE
       AND e.id IN (SELECT id FROM dictionary_entries WHERE LOWER(headword) = $1
                    UNION
                    SELECT id FROM dictionary_entries WHERE LOWER(lemma) = $1
                    UNION
                    SELECT wf.entry_id FROM word_forms wf WHERE LOWER(wf.form_value) = $1)
     ORDER BY`,
      ],
    ],
  },
  {
    file: 'services/enrichment/persist.ts',
    edits: [
      [
        `      WHERE lower(e.headword) = ANY($1::text[])
         OR lower(e.lemma) = ANY($1::text[])
         OR e.id IN (SELECT wf.entry_id FROM word_forms wf WHERE lower(wf.form_value) = ANY($1::text[]))
      ORDER BY`,
        `      WHERE e.id IN (SELECT id FROM dictionary_entries WHERE lower(headword) = ANY($1::text[])
                     UNION
                     SELECT id FROM dictionary_entries WHERE lower(lemma) = ANY($1::text[])
                     UNION
                     SELECT wf.entry_id FROM word_forms wf WHERE lower(wf.form_value) = ANY($1::text[]))
      ORDER BY`,
      ],
    ],
  },
];
