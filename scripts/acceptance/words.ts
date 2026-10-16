/**
 * The 30 acceptance words of docs/lookup-runbook.md §12 (P7b), their groups, their stand-ins and the preconditions each group
 * needs. Shared by scripts/dev/seed-lookup-test-data.ts, scripts/acceptance/lookup-acceptance.ts and the unit tests.
 *
 *   A  already in the dictionary             B  inflected forms of an entry that is there
 *   C  new, common words                     D  loanwords
 *   E  proper nouns                          F  not words / misspellings
 *   H  new words with several meanings
 */
export type Group = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'H';

export const GROUP_ORDER: readonly Group[] = ['A', 'B', 'C', 'D', 'E', 'F', 'H'];

export const GROUP_TITLES: Record<Group, string> = {
  A: 'đã có trong từ điển',
  B: 'dạng biến của từ đã có',
  C: 'từ mới phổ biến',
  D: 'từ vay mượn',
  E: 'tên riêng',
  F: 'không phải từ / sai chính tả',
  H: 'từ nhiều nghĩa chưa có',
};

export const GROUP_WORDS: Record<Group, readonly string[]> = {
  A: ['run', 'bank', 'light'],
  B: ['ran', 'running', 'went', 'children', 'banks', 'lights'],
  C: ['serendipity', 'ubiquitous', 'ephemeral', 'podcast', 'quarantine', 'procrastinate'],
  D: ['karaoke', 'sushi', 'tsunami'],
  E: ['london', 'microsoft', 'shakespeare'],
  F: ['asdfghjk', 'xinchao', 'recieve'],
  H: ['batter', 'mole', 'sage', 'tick', 'bass', 'fawn'],
};

/** Used in order, one for each word of the group whose precondition is wrong. Only groups C and H have stand-ins. */
export const FALLBACK_WORDS: Partial<Record<Group, readonly string[]>> = {
  C: ['nostalgia', 'gregarious', 'lucid'],
  H: ['trunk', 'rack', 'pawn'],
};

/** The inflected forms of group B and the lemma whose entry must be there (and published) for the form to be found. */
export const FORM_LEMMAS: Record<string, string> = {
  ran: 'run',
  running: 'run',
  went: 'go',
  children: 'child',
  banks: 'bank',
  lights: 'light',
};

/** Entries the groups A and B depend on. The seed creates the missing ones with the real pipeline. */
export const PREREQUISITE_LEMMAS: readonly string[] = ['run', 'go', 'child', 'light', 'bank'];

export const ALL_ACCEPTANCE_WORDS: readonly string[] = [
  ...new Set([...GROUP_ORDER.flatMap((g) => GROUP_WORDS[g]), ...Object.values(FALLBACK_WORDS).flatMap((w) => [...(w ?? [])])]),
];

/** What the background job must do, per word. */
export type JobExpectation = 'none' | 'succeeded' | 'rejected_proper_noun' | 'variant_if_any';

export function jobExpectation(group: Group, word: string): JobExpectation {
  switch (group) {
    case 'A':
    case 'B':
      return 'none';
    case 'C':
    case 'D':
    case 'H':
      return 'succeeded';
    case 'E':
      return 'rejected_proper_noun';
    case 'F':
      return word === 'recieve' ? 'variant_if_any' : 'none';
  }
}

/** Groups that go through the slow path (a dictionary miss), i.e. that count against LOOKUP_MISS_RATE_LIMIT_PER_MIN. */
export const MISS_GROUPS: ReadonlySet<Group> = new Set<Group>(['C', 'D', 'E', 'F', 'H']);

/** Groups whose fast-path latency is judged (p95 <= LOOKUP_TOTAL_DEADLINE_MS + 500 ms). */
export const TIMED_GROUPS: readonly Group[] = ['C', 'D', 'E', 'H'];

export const LATENCY_MARGIN_MS = 500;

/** What the database says about a word before the run (published or not: S0 of the pipeline does not care). */
export interface WordFacts {
  /** an entry matches the word by headword, lemma or word_forms (published or not) */
  entryExists: boolean;
  /** that entry is published */
  entryPublished: boolean;
  /** an entry whose headword is exactly the word (matters for E and F: "no entry may be created") */
  headwordExists: boolean;
  /** group B only: the entry that the word is reached through (via word_forms or via the lemma of ref_wiktionary_en) */
  formTarget?: { lemma: string; published: boolean } | null;
}

export interface PreconditionResult {
  ok: boolean;
  reason: string;
}

/** Is the database in the state the expectations of this group assume? A wrong state is reported as "skipped", not as a failure. */
export function checkPrecondition(group: Group, word: string, facts: WordFacts): PreconditionResult {
  switch (group) {
    case 'A':
      if (!facts.entryExists) return { ok: false, reason: 'chưa có mục từ' };
      if (!facts.entryPublished) return { ok: false, reason: 'có mục từ nhưng published=false' };
      return { ok: true, reason: 'đã có và published' };
    case 'B': {
      const lemma = FORM_LEMMAS[word];
      const target = facts.formTarget;
      if (!target) return { ok: false, reason: `không tìm thấy mục từ gốc${lemma ? ` (${lemma})` : ''} cho dạng này` };
      if (!target.published) return { ok: false, reason: `mục từ gốc "${target.lemma}" có nhưng published=false` };
      return { ok: true, reason: `dạng biến của "${target.lemma}" (đã published)` };
    }
    case 'C':
    case 'D':
    case 'H':
      if (facts.entryExists) return { ok: false, reason: facts.entryPublished ? 'đã có trong từ điển (published)' : 'đã có mục từ (published=false, ví dụ do P6b tạo)' };
      return { ok: true, reason: 'chưa có mục từ' };
    case 'E':
    case 'F':
      if (facts.headwordExists) return { ok: false, reason: 'đã có mục từ với headword này' };
      return { ok: true, reason: 'chưa có mục từ' };
  }
}

export interface PlannedWord {
  group: Group;
  word: string;
  /** the word of the original list that this one stands in for */
  standsInFor?: string;
}

export interface SkippedWord {
  group: Group;
  word: string;
  reason: string;
}

/**
 * Decides which words are run. Each word of the original list whose precondition is wrong is skipped; in groups C and H it is
 * replaced by the next stand-in whose precondition holds (a stand-in with a wrong precondition is skipped too).
 */
export function planWords(
  groups: readonly Group[],
  preconditions: (group: Group, word: string) => PreconditionResult
): { run: PlannedWord[]; skipped: SkippedWord[] } {
  const run: PlannedWord[] = [];
  const skipped: SkippedWord[] = [];
  for (const group of GROUP_ORDER.filter((g) => groups.includes(g))) {
    const standIns = [...(FALLBACK_WORDS[group] ?? [])];
    for (const word of GROUP_WORDS[group]) {
      const pre = preconditions(group, word);
      if (pre.ok) {
        run.push({ group, word });
        continue;
      }
      skipped.push({ group, word, reason: pre.reason });
      // find the next usable stand-in
      while (standIns.length > 0) {
        const candidate = standIns.shift()!;
        const candidatePre = preconditions(group, candidate);
        if (candidatePre.ok) {
          run.push({ group, word: candidate, standsInFor: word });
          break;
        }
        skipped.push({ group, word: candidate, reason: `${candidatePre.reason} (từ dự phòng cho "${word}")` });
      }
    }
  }
  return { run, skipped };
}
