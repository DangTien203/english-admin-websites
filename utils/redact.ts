/**
 * Keeps API keys out of logs, error messages and responses (docs/lookup-spec.md §12.5).
 *
 * Primary defence: the clients never put a key where it could be echoed (Google gets it in the X-Goog-Api-Key header, never in
 * the URL, and fetch errors are rewritten without the provider's text). This module is the second layer, applied where text
 * leaves the process: it removes
 *   - the exact value of every secret in the environment (a provider that echoes our own key back is caught whatever it looks like),
 *   - and anything that LOOKS like one: key=… in a URL, an x-api-key / authorization header, sk-ant-…, AIza…, Bearer …, a
 *     password in a connection string.
 * When a key has to be shown to a human, show maskKey(): the last four characters only (spec §12.5).
 */

/** Environment variables whose VALUES are secrets. */
const SECRET_ENV_NAMES = [
  'GOOGLE_TRANSLATE_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATAMUSE_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_TTS_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'GEMINI_API_KEY',
  'JWT_SECRET',
  'SESSION_SECRET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

/** A value shorter than this is not treated as a secret (it would blank out ordinary words). */
export const MIN_SECRET_LENGTH = 8;

export const REDACTED = '<key>';

/** Linear-time patterns: no nested quantifiers. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/([?&;\s]key=)[^&\s"'<>]+/gi, `$1${REDACTED}`],
  [/(\b(?:x-goog-api-key|x-api-key|api[-_]?key|authorization)\b["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',;}&]+/gi, `$1${REDACTED}`],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, `Bearer ${REDACTED}`],
  [/(postgres(?:ql)?:\/\/[^:@/\s]+:)[^@\s]+@/gi, `$1${REDACTED}@`],
];

function passwordOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const p = new URL(url).password;
    return p ? decodeURIComponent(p) : undefined;
  } catch {
    return undefined;
  }
}

/** The secrets currently set in the environment, longest first (so a key that contains another is replaced whole). */
export function configuredSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = SECRET_ENV_NAMES.map((n) => env[n]);
  values.push(passwordOf(env.DATABASE_URL), passwordOf(env.REFDATA_DATABASE_URL));
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length >= MIN_SECRET_LENGTH).map((v) => v.trim()))].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: readonly string[] = configuredSecrets()): string {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** "…abcd": enough to tell two keys apart, nothing more. */
export function maskKey(key: string | undefined | null): string {
  return key ? `…${key.slice(-4)}` : '(none)';
}
