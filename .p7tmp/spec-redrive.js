module.exports = [
  { file: 'services/queue/pgBossEnqueuer.ts', edits: [
    [`/** Entry in dictionary_entries (published or not) matching headword, lemma or any word form. */
const ENTRY_EXISTS_SQL = \``, `/** Entry in dictionary_entries (published or not) matching headword, lemma or any word form. */
export const ENTRY_EXISTS_SQL = \``],
  ]},
];
