module.exports = [
  {
    file: 'scripts/acceptance/words.ts',
    edits: [
      [
        `export const GROUP_ORDER: readonly Group[] = ['A', 'B', 'C', 'D', 'E', 'F', 'H'];`,
        `export const GROUP_ORDER: readonly Group[] = ['A', 'B', 'C', 'D', 'E', 'F', 'H'];

/**
 * The order the groups are RUN in (GROUP_ORDER stays the order of the brief and of the tables). H goes before E and F: H is the group
 * that most needs Free Dictionary to be answering (several senses come from it), while E and F are the ones that can make it fail
 * (a proper noun or a garbage word has no Google translation, so each of them waits for Free Dictionary and, when it hangs, ends in a
 * 503 after the full timeout; a few of those in a row open its circuit breaker and spoil whatever runs next).
 */
export const RUN_ORDER: readonly Group[] = ['A', 'B', 'C', 'D', 'H', 'E', 'F'];`,
      ],
      [
        `/** Used in order, one for each word of the group whose precondition is wrong. Only groups C and H have stand-ins. */
export const FALLBACK_WORDS: Partial<Record<Group, readonly string[]>> = {
  C: ['nostalgia', 'gregarious', 'lucid'],
  H: ['trunk', 'rack', 'pawn'],
};`,
        `/**
 * Used in order, one for each word of the group whose precondition is wrong. Only groups C and H have stand-ins.
 * H has more of them than C: a group H run that could not be judged because Free Dictionary was down still leaves an entry behind for
 * every word (the job does not need Free Dictionary), so those words are "used up", and re-running the group needs fresh ones.
 */
export const FALLBACK_WORDS: Partial<Record<Group, readonly string[]>> = {
  C: ['nostalgia', 'gregarious', 'lucid'],
  H: ['trunk', 'rack', 'pawn', 'bark', 'crane', 'pitch', 'seal', 'bolt', 'stalk', 'jam'],
};`,
      ],
      [
        `  for (const group of GROUP_ORDER.filter((g) => groups.includes(g))) {`,
        `  for (const group of RUN_ORDER.filter((g) => groups.includes(g))) {`,
      ],
    ],
  },
];
