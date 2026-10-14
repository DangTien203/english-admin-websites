/**
 * MANUAL smoke test (never part of the automated suite) for Google Cloud Translation v2.
 * Run: npx tsx scripts/smoke/google-translate.ts
 *
 * Reads GOOGLE_TRANSLATE_API_KEY from the environment / .env. The key is never printed in full
 * (only the last 4 characters) and never appears in a URL that is printed.
 *
 * Checks, with a few hundred characters of real quota:
 *   1. POST JSON body with q as an ARRAY, source=en, target=vi, format=text  → response shape
 *   2. Whether translatedText is HTML-escaped (apostrophes, quotes, ampersands, angle brackets)
 *   3. Same strings with format=html, to show what the escaping looks like when it does happen
 *   4. Whether the key can travel in the X-Goog-Api-Key header instead of the URL (keeps it out of logs)
 *   5. The error body for a bad key (does not use your real key)
 */
import { lookupConfig } from '../../config/lookup';

const mask = (key: string) => `…${key.slice(-4)}`;
const TIMEOUT_MS = 10_000;

const SAMPLES = [
  'hello',
  "It's a dog & cat's \"quoted\" world",
  '<b>bold</b> and 5 < 6 > 3',
  'ubiquitous: present, appearing, or found everywhere',
  'line one\nline two',
];

type Where = 'query' | 'header';

async function call(key: string, where: Where, format: 'text' | 'html', q: string[]) {
  const base = lookupConfig.google.baseUrl;
  const url = where === 'query' ? `${base}?key=${encodeURIComponent(key)}` : base;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (where === 'header') headers['x-goog-api-key'] = key;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ q, source: 'en', target: 'vi', format }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

const redact = (s: string, key: string) => s.split(key).join(mask(key));

async function main() {
  const key = lookupConfig.google.apiKey;
  console.log(`base url : ${lookupConfig.google.baseUrl}`);
  if (!key) {
    console.log('GOOGLE_TRANSLATE_API_KEY is empty → nothing was verified. Set it in .env and run again.');
    process.exit(2);
  }
  console.log(`api key  : ${mask(key)} (length ${key.length})`);

  const totalChars = SAMPLES.reduce((n, s) => n + s.length, 0);
  console.log(`\nSending ${SAMPLES.length} strings / ${totalChars} chars per request.\n`);

  // 1 + 2: JSON body, array q, format=text, key in the URL (the documented way)
  const t = await call(key, 'query', 'text', SAMPLES);
  console.log(`[1] key in query  · format=text → HTTP ${t.status}`);
  if (t.status === 200) {
    console.log('    top-level keys :', Object.keys(t.json ?? {}));
    console.log('    data keys      :', Object.keys(t.json?.data ?? {}));
    const tr = t.json?.data?.translations;
    console.log('    translations   :', Array.isArray(tr) ? `array(${tr.length})` : typeof tr);
    console.log('    item keys      :', Array.isArray(tr) && tr[0] ? Object.keys(tr[0]) : '-');
    (tr ?? []).forEach((item: any, i: number) => {
      const out: string = item.translatedText;
      const escaped = /&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/i.test(out);
      console.log(`    ${i} ${JSON.stringify(SAMPLES[i]).slice(0, 50).padEnd(52)} → ${JSON.stringify(out)}  ${escaped ? '⚠ HTML-ESCAPED' : ''}`);
    });
  } else {
    console.log('    body:', redact(t.text, key).slice(0, 400));
  }

  // 3: format=html, to see the escaping behaviour
  const h = await call(key, 'query', 'html', [SAMPLES[1]]);
  console.log(`\n[3] format=html → HTTP ${h.status}`);
  if (h.status === 200) console.log('    ', JSON.stringify(SAMPLES[1]), '→', JSON.stringify(h.json?.data?.translations?.[0]?.translatedText));

  // 4: key in header instead of the URL
  const hd = await call(key, 'header', 'text', ['hello']);
  console.log(`\n[4] key in X-Goog-Api-Key header → HTTP ${hd.status}`);
  if (hd.status === 200) console.log('     works: the key can stay out of the URL.');
  else console.log('     body:', redact(hd.text, key).slice(0, 300));

  // 5: error shape with a deliberately wrong key
  const bad = await call('AIza-this-is-not-a-real-key', 'query', 'text', ['hello']);
  console.log(`\n[5] invalid key → HTTP ${bad.status}`);
  console.log('    body:', bad.text.replace(/\s+/g, ' ').slice(0, 500));
  console.log('    content-type:', bad.headers.get('content-type'));
}

main().catch((e) => {
  console.error('smoke failed:', String(e?.message ?? e).split(lookupConfig.google.apiKey ?? '\u0000').join('<key>'));
  process.exit(1);
});
