/**
 * Word translation fallback — used by POST /api/v1/ebooks/:id/lookup when a
 * tapped word is not in `dictionary_entries`.
 *
 * @deprecated The `word_translation_cache` table (migration 26) is superseded by the
 * temporary-lookup flow in docs/lookup-spec.md (§5 F7: no cache of translated words;
 * §3: the table must stop being read AND written). Behavior is unchanged until P2
 * replaces this path. Do NOT drop the table — it is kept for rollback.
 *
 * Pipeline:
 *   1. Cache lookup in word_translation_cache (by lowercased word).
 *   2. Cache miss → Promise.allSettled([Google Translate v2, Free Dictionary API]).
 *   3. Merge results, INSERT cache row (ON CONFLICT bump hit_count).
 *
 * Failure semantics:
 *   - Network timeouts/quotas are logged and treated as a single-provider miss.
 *   - If BOTH providers fail → throw `{ code: 'TRANSLATION_FAILED' }`.
 *     The caller maps this to HTTP 503 TRANSLATION_UNAVAILABLE.
 *
 * Env:
 *   GOOGLE_TRANSLATE_API_KEY        (required for Google calls)
 *   GOOGLE_TRANSLATE_TIMEOUT_MS     (default 5000)
 *   FREE_DICTIONARY_API_TIMEOUT_MS  (default 3000)
 */
import pool from '../config/db';
import { HEADWORD_MAX_LENGTH, headwordProblem } from '../utils/headword';

const GOOGLE_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';
const FREE_DICTIONARY_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

const MAX_WORD_LENGTH = HEADWORD_MAX_LENGTH;
const MAX_DEFINITIONS = 3;
const MAX_EXAMPLES = 3;

// Surrounding punctuation we strip before validating (whitespace counts too).
const STRIP_CHARS = new Set(".,!?;:'\"()[]‘’“”");
const isStripChar = (ch: string): boolean => STRIP_CHARS.has(ch) || /\s/.test(ch);

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
}

export interface NormalizeResult {
  normalized: string;
  display: string;
  isValid: boolean;
  reason?: string;
}

export function normalizeWord(raw: string): NormalizeResult {
  if (typeof raw !== 'string') {
    return { normalized: '', display: '', isValid: false, reason: 'word must be a string' };
  }
  const stripped = stripEdges(raw);
  if (stripped.length === 0) {
    return { normalized: '', display: '', isValid: false, reason: 'word is empty' };
  }
  if (stripped.length > MAX_WORD_LENGTH) {
    return {
      normalized: '',
      display: stripped,
      isValid: false,
      reason: `word exceeds ${MAX_WORD_LENGTH} characters`,
    };
  }
  // the one headword rule (utils/headword.ts): letters, with a hyphen or apostrophe only between letters (don't, well-being, T-shirt)
  const problem = headwordProblem(stripped);
  if (problem) {
    return { normalized: '', display: stripped, isValid: false, reason: problem };
  }
  return {
    normalized: stripped.toLowerCase(),
    display: stripped,
    isValid: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Google Translate v2 REST
// ─────────────────────────────────────────────────────────────────────────────
export async function callGoogleTranslate(
  word: string
): Promise<{ translation_vi: string | null; error?: string }> {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    return { translation_vi: null, error: 'GOOGLE_TRANSLATE_API_KEY not set' };
  }

  const timeoutMs = parseInt(process.env.GOOGLE_TRANSLATE_TIMEOUT_MS || '5000', 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${GOOGLE_TRANSLATE_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: word, source: 'en', target: 'vi', format: 'text' }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = `HTTP ${res.status}: ${body.slice(0, 300)}`;
      console.warn(`[wordTranslation] Google Translate failed: ${msg}`);
      return { translation_vi: null, error: msg };
    }

    const data = (await res.json()) as {
      data?: { translations?: { translatedText?: string }[] };
      error?: { message?: string };
    };
    if (data.error) {
      console.warn('[wordTranslation] Google Translate error:', data.error.message);
      return { translation_vi: null, error: data.error.message ?? 'unknown' };
    }
    const text = data.data?.translations?.[0]?.translatedText ?? null;
    return { translation_vi: text };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn(`[wordTranslation] Google Translate timeout after ${timeoutMs}ms`);
      return { translation_vi: null, error: 'timeout' };
    }
    console.warn('[wordTranslation] Google Translate threw:', err?.message ?? err);
    return { translation_vi: null, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Free Dictionary API (api.dictionaryapi.dev)
// ─────────────────────────────────────────────────────────────────────────────
interface FreeDictResult {
  phonetic: string | null;
  audio_url: string | null;
  pos: string | null;
  definitions_en: string[];
  examples: { en: string; vi: null }[];
  error?: string;
}

interface FreeDictApiEntry {
  phonetic?: string;
  phonetics?: { text?: string; audio?: string }[];
  meanings?: {
    partOfSpeech?: string;
    definitions?: { definition?: string; example?: string }[];
  }[];
}

export async function callFreeDictionary(word: string): Promise<FreeDictResult> {
  const empty: FreeDictResult = {
    phonetic: null,
    audio_url: null,
    pos: null,
    definitions_en: [],
    examples: [],
  };

  const timeoutMs = parseInt(process.env.FREE_DICTIONARY_API_TIMEOUT_MS || '3000', 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${FREE_DICTIONARY_URL}${encodeURIComponent(word)}`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (res.status === 404) {
      return empty;
    }
    if (!res.ok) {
      console.warn(`[wordTranslation] Free Dictionary HTTP ${res.status}`);
      return { ...empty, error: `HTTP ${res.status}` };
    }

    const arr = (await res.json()) as FreeDictApiEntry[];
    if (!Array.isArray(arr) || arr.length === 0) {
      return empty;
    }
    const entry = arr[0];

    const phonetic =
      (entry.phonetic && entry.phonetic.trim()) ||
      entry.phonetics?.find((p) => p.text && p.text.trim())?.text ||
      null;

    const audio_url =
      entry.phonetics?.find((p) => p.audio && p.audio.trim())?.audio ?? null;

    const pos = entry.meanings?.[0]?.partOfSpeech ?? null;

    const definitions_en: string[] = [];
    const examples: { en: string; vi: null }[] = [];
    for (const m of entry.meanings ?? []) {
      for (const d of m.definitions ?? []) {
        if (definitions_en.length < MAX_DEFINITIONS && d.definition) {
          definitions_en.push(d.definition);
        }
        if (examples.length < MAX_EXAMPLES && d.example) {
          examples.push({ en: d.example, vi: null });
        }
      }
    }

    return { phonetic, audio_url, pos, definitions_en, examples };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn(`[wordTranslation] Free Dictionary timeout after ${timeoutMs}ms`);
      return { ...empty, error: 'timeout' };
    }
    console.warn('[wordTranslation] Free Dictionary threw:', err?.message ?? err);
    return { ...empty, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public — translateWord
// ─────────────────────────────────────────────────────────────────────────────

export interface TranslationResult {
  word: string;
  translation_vi: string;
  phonetic: string | null;
  audio_url: string | null;
  pos: string | null;
  definitions_en: string[];
  examples: { en: string; vi: string | null }[];
  providers: string[];
  cached: boolean;
}

export class TranslationFailedError extends Error {
  code = 'TRANSLATION_FAILED' as const;
  constructor(message = 'Both translation providers failed') {
    super(message);
    this.name = 'TranslationFailedError';
  }
}

export async function translateWord(
  normalizedWord: string,
  displayWord: string
): Promise<TranslationResult> {
  // 1. Cache lookup.
  const { rows: cacheRows } = await pool.query(
    `SELECT word_original, translation_vi, phonetic, audio_url, pos,
            definitions_en, examples, providers
       FROM word_translation_cache
      WHERE word = $1
      LIMIT 1`,
    [normalizedWord]
  );

  if (cacheRows.length > 0) {
    const row = cacheRows[0];
    // Bump hit_count (fire-and-forget; no need to await for response time).
    void pool
      .query(
        `UPDATE word_translation_cache
            SET hit_count = hit_count + 1, updated_at = NOW()
          WHERE word = $1`,
        [normalizedWord]
      )
      .catch((e) => console.error('[wordTranslation] hit_count bump failed:', e));

    return {
      word: row.word_original,
      translation_vi: row.translation_vi,
      phonetic: row.phonetic,
      audio_url: row.audio_url,
      pos: row.pos,
      definitions_en: Array.isArray(row.definitions_en) ? row.definitions_en : [],
      examples: Array.isArray(row.examples) ? row.examples : [],
      providers: Array.isArray(row.providers) ? row.providers : [],
      cached: true,
    };
  }

  // 2. Cache miss — call both providers in parallel.
  const [googleSettled, freeSettled] = await Promise.allSettled([
    callGoogleTranslate(displayWord),
    callFreeDictionary(normalizedWord),
  ]);

  const google =
    googleSettled.status === 'fulfilled'
      ? googleSettled.value
      : { translation_vi: null as string | null, error: String(googleSettled.reason) };

  const freeDict: FreeDictResult =
    freeSettled.status === 'fulfilled'
      ? freeSettled.value
      : {
          phonetic: null,
          audio_url: null,
          pos: null,
          definitions_en: [],
          examples: [],
          error: String(freeSettled.reason),
        };

  const providers: string[] = [];
  if (google.translation_vi) providers.push('google_translate');
  const freeDictUseful =
    freeDict.phonetic !== null ||
    freeDict.audio_url !== null ||
    freeDict.pos !== null ||
    freeDict.definitions_en.length > 0 ||
    freeDict.examples.length > 0;
  if (freeDictUseful) providers.push('free_dictionary_api');

  // Both providers failed → propagate to caller as 503.
  if (providers.length === 0) {
    throw new TranslationFailedError(
      `Translation failed for "${displayWord}" — google: ${google.error ?? 'no result'}, freeDict: ${freeDict.error ?? 'no result'}`
    );
  }

  // Translation_vi: prefer Google, fall back to echoing the display word so the
  // mobile field is never null (the response contract forbids null translation_vi).
  const translationVi = google.translation_vi ?? displayWord;

  // 3. Persist cache row (idempotent on UNIQUE word).
  await pool.query(
    `INSERT INTO word_translation_cache
       (word, word_original, translation_vi, phonetic, audio_url, pos,
        definitions_en, examples, providers)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
     ON CONFLICT (word) DO UPDATE SET
       hit_count  = word_translation_cache.hit_count + 1,
       updated_at = NOW()`,
    [
      normalizedWord,
      displayWord,
      translationVi,
      freeDict.phonetic,
      freeDict.audio_url,
      freeDict.pos,
      JSON.stringify(freeDict.definitions_en),
      JSON.stringify(freeDict.examples),
      JSON.stringify(providers),
    ]
  );

  return {
    word: displayWord,
    translation_vi: translationVi,
    phonetic: freeDict.phonetic,
    audio_url: freeDict.audio_url,
    pos: freeDict.pos,
    definitions_en: freeDict.definitions_en,
    examples: freeDict.examples,
    providers,
    cached: false,
  };
}
