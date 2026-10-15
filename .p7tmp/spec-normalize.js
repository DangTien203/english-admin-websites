module.exports = [
  {
    file: 'services/wordTranslationService.ts',
    edits: [
      [
        `// Surrounding punctuation we strip before validating.
const STRIP_RE = /^[\\s.,!?;:'"()\\[\\]‘’“”]+|[\\s.,!?;:'"()\\[\\]‘’“”]+$/g;`,
        `// Surrounding punctuation we strip before validating (whitespace counts too).
const STRIP_CHARS = new Set(".,!?;:'\\"()[]‘’“”");
const isStripChar = (ch: string): boolean => STRIP_CHARS.has(ch) || /\\s/.test(ch);

/**
 * Removes the run of punctuation / whitespace at both ends, in linear time. This replaced the regex
 * /^[...]+|[...]+$/g, which has the same result but is QUADRATIC on a string like "a" + 100,000 spaces + "a" (about 9 s of
 * CPU for 100k characters; a 1 MB request body would block the whole server for minutes). Same behaviour, no ReDoS.
 */
export function stripEdges(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && isStripChar(raw[start])) start++;
  while (end > start && isStripChar(raw[end - 1])) end--;
  return raw.slice(start, end);
}`,
      ],
      [
        `  const stripped = raw.replace(STRIP_RE, '');`,
        `  const stripped = stripEdges(raw);`,
      ],
    ],
  },
];
