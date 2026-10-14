import type { FdEntry } from '../../upstream/freeDictionaryClient';
import { describeFormOf, summarizeForPrompt } from '../sources/wiktionary';
import type { SourceBundle } from '../types';

/**
 * The per-word (dynamic) part of the Haiku request: ONE <data> block with compact JSON (docs/lookup-spec.md §9.4, §12.4).
 *
 * Everything inside <data> is untrusted: Wiktionary, Free Dictionary and Datamuse text could contain
 * instructions. The system prompt tells the model to treat it as data; this file makes sure the block
 * cannot be closed or reopened from the inside (every "<data" / "</data" in the JSON is written with a JSON
 * escape for "<", which parses back to the same text). No user data goes in: only the word and what the sources
 * say about it.
 */

export const FREE_DICTIONARY_MAX_SENSES = 6;

/**
 * JSON text safe to place between <data> and </data>.
 * The replacement is the six characters backslash, u, 0, 0, 3, c: the JSON escape of "<".
 */
export function escapeForDataBlock(jsonText: string): string {
  return jsonText.replace(/<(\/?)(data)/gi, '\\u003c$1$2');
}

function summarizeFreeDictionary(entry: FdEntry) {
  return {
    headword: entry.headword,
    pos: entry.pos,
    senses: entry.senses.slice(0, FREE_DICTIONARY_MAX_SENSES).map((s) => ({
      pos: s.pos,
      definition: s.definition,
      ...(s.example ? { example: s.example } : {}),
      ...(s.synonyms.length ? { synonyms: s.synonyms.slice(0, 8) } : {}),
      ...(s.antonyms.length ? { antonyms: s.antonyms.slice(0, 8) } : {}),
    })),
  };
}

/** The object that is serialized into <data>. Exported for tests and for the CLI. */
export function buildDataObject(bundle: SourceBundle): Record<string, unknown> {
  const formOnly = bundle.flags.onlyFormRows && bundle.expectedLemma !== null && bundle.expectedLemma !== bundle.word;
  // A pure form (ran): the draft is about its lemma, so show the lemma's rows (the form itself is described by word_is_form_of).
  const rows = formOnly && bundle.lemmaRows.length > 0 ? bundle.lemmaRows : bundle.wiktionaryRows;
  const wiktionary = summarizeForPrompt(rows, { maxTokens: 2500, maxSenses: 6 });

  const data: Record<string, unknown> = {
    word: bundle.word,
    expected_lemma: bundle.expectedLemma,
  };
  if (formOnly) {
    data.word_is_form_of = describeFormOf(bundle.word, bundle.expectedLemma!, bundle.wiktionaryRows);
  }
  data.wiktionary = wiktionary.entries;
  data.free_dictionary = bundle.freeDictionary.status === 'found' ? summarizeFreeDictionary(bundle.freeDictionary.entry) : null;
  data.frequency = bundle.frequency;
  data.datamuse_candidates = bundle.datamuse
    ? { synonyms: bundle.datamuse.synonyms.slice(0, 20), antonyms: bundle.datamuse.antonyms.slice(0, 20) }
    : { synonyms: [], antonyms: [] };
  return data;
}

export const TASK_LINE = 'Lập bản nháp mục từ cho từ trong khối dữ liệu ở trên và trả về đúng một đối tượng JSON theo schema.';

/** User message of the first attempt. */
export function buildUserMessage(bundle: SourceBundle): string {
  const json = escapeForDataBlock(JSON.stringify(buildDataObject(bundle)));
  return `<data>\n${json}\n</data>\n\n${TASK_LINE}`;
}
