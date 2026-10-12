const SEPARATOR_RE = /[,;\/|，、；\n\r]+/g;
const SPACE_RE = /\s+/g;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const EDGE_PUNCT_RE = /^[\s"'“”‘’`.,!?;:()[\]{}<>]+|[\s"'“”‘’`.,!?;:()[\]{}<>]+$/g;

export function normalizeVietnameseAnswer(value: string | null | undefined): string {
  if (!value) return '';

  return value
    .normalize('NFC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\u00A0/g, ' ')
    .toLocaleLowerCase('vi')
    .replace(EDGE_PUNCT_RE, '')
    .replace(SPACE_RE, ' ')
    .trim();
}

export function normalizeEnglishAnswer(value: string | null | undefined): string {
  if (!value) return '';

  return value
    .normalize('NFC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\u00A0/g, ' ')
    .toLowerCase()
    .replace(EDGE_PUNCT_RE, '')
    .replace(SPACE_RE, ' ')
    .trim();
}

export function splitVietnameseAnswers(value: string | null | undefined): string[] {
  if (!value) return [];

  const rawParts = value
    .normalize('NFC')
    .replace(/\([^)]*\)/g, '')
    .split(SEPARATOR_RE);

  const seen = new Set<string>();
  const answers: string[] = [];

  for (const rawPart of rawParts) {
    const normalized = normalizeVietnameseAnswer(rawPart);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    answers.push(normalized);
  }

  return answers;
}

export function dedupeNormalizedAnswers(values: string[]): string[] {
  const seen = new Set<string>();
  const answers: string[] = [];

  for (const value of values) {
    const normalized = normalizeVietnameseAnswer(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    answers.push(normalized);
  }

  return answers;
}
