/**
 * MANUAL smoke test (never part of the automated suite) for the Free Dictionary API.
 * Run: npx tsx scripts/smoke/free-dictionary.ts [word ...]
 *
 * - Calls FREE_DICTIONARY_BASE_URL for run, ran, hello, ubiquitous, asdfghjk (or the words given).
 * - The API is flaky (Cloudflare 522, HTML 404 pages for real words), so each word is retried
 *   until a JSON answer arrives (200 with an array, or 404 with a JSON body).
 * - Saves a trimmed copy of every valid answer to tests/fixtures/lookup/free-dictionary/<word>.json
 *   (structure preserved; only long lists are cut). Invalid answers are reported, never saved.
 * - Needs no API key.
 */
import * as fs from 'fs';
import * as path from 'path';
import { lookupConfig } from '../../config/lookup';

const WORDS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['run', 'ran', 'hello', 'ubiquitous', 'asdfghjk'];
const OUT_DIR = path.resolve(__dirname, '../../tests/fixtures/lookup/free-dictionary');
const MAX_ATTEMPTS = Number(process.env.SMOKE_MAX_ATTEMPTS) > 0 ? Number(process.env.SMOKE_MAX_ATTEMPTS) : 8;
const ATTEMPT_TIMEOUT_MS = 10_000;
const WAIT_MS = 2_000;
const KEEP_MEANINGS = 4;
const KEEP_DEFINITIONS = 3;

const INTERESTING_HEADERS = ['content-type', 'cache-control', 'age', 'cf-cache-status', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pickHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of INTERESTING_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

/** Keeps the structure, cuts only long lists. */
function trimBody(body: unknown): unknown {
  if (!Array.isArray(body)) return body;
  return body.map((entry: any) => ({
    ...entry,
    meanings: Array.isArray(entry.meanings)
      ? entry.meanings.slice(0, KEEP_MEANINGS).map((m: any) => ({
          ...m,
          definitions: Array.isArray(m.definitions) ? m.definitions.slice(0, KEEP_DEFINITIONS) : m.definitions,
        }))
      : entry.meanings,
  }));
}

async function tryOnce(word: string): Promise<{ status: number; headers: Record<string, string>; json: unknown | undefined; textHead: string }> {
  const url = `${lookupConfig.freeDictionary.baseUrl}/${encodeURIComponent(word)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS), headers: { accept: 'application/json' } });
  const text = await res.text();
  let json: unknown | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: pickHeaders(res), json, textHead: text.slice(0, 80).replace(/\s+/g, ' ') };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`base url: ${lookupConfig.freeDictionary.baseUrl}`);

  for (const word of WORDS) {
    const seen: string[] = [];
    let saved = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const r = await tryOnce(word);
        const isJson200 = r.status === 200 && Array.isArray(r.json);
        const isJson404 = r.status === 404 && r.json !== undefined && typeof r.json === 'object';
        seen.push(`${r.status}${r.json === undefined ? '(non-json)' : ''}`);

        if (isJson200 || isJson404) {
          const fixture = {
            word,
            captured_at: new Date().toISOString(),
            status: r.status,
            headers: r.headers,
            body: isJson200 ? trimBody(r.json) : r.json,
          };
          fs.writeFileSync(path.join(OUT_DIR, `${word}.json`), JSON.stringify(fixture, null, 2) + '\n', 'utf8');
          saved = true;
          const entries = isJson200 ? (r.json as any[]).length : 0;
          console.log(`✓ ${word.padEnd(12)} status=${r.status} entries=${entries} attempts=[${seen.join(', ')}] headers=${JSON.stringify(r.headers)}`);
          break;
        }
        console.log(`  ${word} attempt ${attempt}: ${r.status} ${r.json === undefined ? 'NON-JSON body: ' + r.textHead : 'unexpected JSON'}`);
      } catch (err: any) {
        seen.push(err?.name === 'TimeoutError' ? 'timeout' : 'network');
        console.log(`  ${word} attempt ${attempt}: ${err?.name ?? 'Error'}`);
      }
      await sleep(WAIT_MS);
    }

    if (!saved) console.log(`✗ ${word.padEnd(12)} NO valid JSON answer after ${MAX_ATTEMPTS} attempts: [${seen.join(', ')}]`);
  }
}

main().catch((e) => {
  console.error('smoke failed:', e?.message ?? e);
  process.exit(1);
});
