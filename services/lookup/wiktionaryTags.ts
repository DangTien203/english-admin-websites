/**
 * Wiktionary sense tags that mark a form which must not be auto-linked to its lemma (word_forms).
 * Shared by the reference-data loader (scripts/refdata) and the lookup service (resolveViaForms);
 * it lives in services/ because services must never import from scripts/.
 */
export const NON_STANDARD_TAGS = ['misspelling', 'obsolete', 'archaic', 'nonstandard', 'dialectal', 'rare', 'proscribed'] as const;

const NON_STANDARD = new Set<string>(NON_STANDARD_TAGS);

/** True when a sense (raw or reduced) carries a non-standard tag in `tags` or `raw_tags`. */
export const isNonStandardSense = (sense: any): boolean => {
  const tags: unknown[] = [...(Array.isArray(sense?.tags) ? sense.tags : []), ...(Array.isArray(sense?.raw_tags) ? sense.raw_tags : [])];
  return tags.some((t) => typeof t === 'string' && NON_STANDARD.has(t.toLowerCase()));
};

/** Lowercase words a sense points to through form_of / alt_of (raw `[{word}]` or plain strings). */
export const targetsOf = (sense: any): string[] => {
  const out: string[] = [];
  for (const key of ['form_of', 'alt_of']) {
    const list = sense?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const w = typeof item === 'string' ? item : item?.word;
      if (typeof w === 'string' && w.trim()) out.push(w.trim().toLowerCase());
    }
  }
  return out;
};
