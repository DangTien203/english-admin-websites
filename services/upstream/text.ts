/**
 * Small text helpers for upstream payloads.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ', // rendered as a plain space
};

/**
 * Decodes HTML entities in ONE pass (so "&amp;lt;" becomes "&lt;", never "<").
 * Unknown or out-of-range entities are left untouched.
 *
 * Google Translate v2 with format=text returns plain text (verified, docs/lookup-api-notes.md);
 * this only protects against residual entities such as &#39; or &quot; (seen with format=html).
 */
export function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Lowercases, trims, drops empties and duplicates (first occurrence wins), preserving order. */
export function uniqueLower(values: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const s = v.trim().toLowerCase();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}
