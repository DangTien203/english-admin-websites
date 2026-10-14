/**
 * MANUAL experiment (never part of the automated suite): does the 'word: definition' prefix technique
 * (docs/lookup-spec.md §5 F9) give several DIFFERENT, correct Vietnamese meanings?
 *
 * Run: npx tsx scripts/smoke/multimeaning-experiment.ts [--offline] [word ...]
 *   --offline  re-computes the table from the saved raw Google answers (tests/fixtures/lookup/google-prefix/),
 *              with NO network calls and no quota use — for iterating on the splitter.
 *
 * For each word: Free Dictionary (retried, it is flaky) → selectSenses → ONE Google request with
 * q = ['<word>: <definition>', ...] → split at the first separator → table. A second tiny request
 * translates the bare word (the "headline", F8a). Uses the REAL clients with the budget ledger stubbed
 * out (no database needed) and never prints the API key.
 *
 * When Free Dictionary cannot answer after FD_ATTEMPTS tries, a small built-in set of English
 * definitions is used instead and the row is marked "fallback" — the experiment is about Google's
 * behaviour, not about Free Dictionary's availability.
 *
 * Raw Google answers are saved to tests/fixtures/lookup/google-prefix/<word>.json (real fixtures for tests).
 */
import * as fs from 'fs';
import * as path from 'path';
import { lookupConfig } from '../../config/lookup';
import { selectSenses, buildPrefixedQuery, splitGloss, dedupeMeanings } from '../../services/lookup/senseSelection';
import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { FdSense, FreeDictionaryClient } from '../../services/upstream/freeDictionaryClient';
import { GoogleTranslateClient } from '../../services/upstream/googleTranslateClient';
import { TokenBucket } from '../../services/upstream/tokenBucket';

const ARGS = process.argv.slice(2);
const OFFLINE = ARGS.includes('--offline');
const CLI_WORDS = ARGS.filter((a) => !a.startsWith('--'));
const WORDS = CLI_WORDS.length > 0 ? CLI_WORDS : ['run', 'light', 'bank', 'bat', 'match', 'spring', 'right', 'lead', 'fair', 'close', 'address', 'minute'];
const OUT_DIR = path.resolve(__dirname, '../../tests/fixtures/lookup/google-prefix');
const FD_ATTEMPTS = Number(process.env.SMOKE_FD_ATTEMPTS) > 0 ? Number(process.env.SMOKE_FD_ATTEMPTS) : 6;
const FD_WAIT_MS = 1500;

const s = (pos: string, definition: string): FdSense => ({ pos, definition, example: null, synonyms: [], antonyms: [] });
const FALLBACK: Record<string, FdSense[]> = {
  run: [s('verb', 'To move swiftly on foot so that both feet leave the ground in each stride.'), s('noun', 'An act of running; a journey made by running.'), s('verb', 'To operate or function, as of a machine.')],
  light: [s('noun', 'Electromagnetic radiation that makes things visible.'), s('adjective', 'Of little weight; not heavy.'), s('adjective', 'Pale in colour; not dark.'), s('verb', 'To ignite or set on fire.')],
  bank: [s('noun', 'An institution that accepts deposits and lends money.'), s('noun', 'The land alongside a river or lake.'), s('verb', 'To tilt an aircraft sideways while turning.')],
  bat: [s('noun', 'A flying nocturnal mammal with wings made of skin.'), s('noun', 'A club used to hit the ball in sports such as baseball.'), s('verb', 'To hit a ball with a bat.')],
  match: [s('noun', 'A small stick that produces fire when struck.'), s('noun', 'A contest between two teams or players.'), s('verb', 'To correspond or be equal to something.')],
  spring: [s('noun', 'The season between winter and summer.'), s('noun', 'A coiled piece of metal that returns to its shape after being pressed.'), s('noun', 'A place where water comes out of the ground.'), s('verb', 'To jump or move suddenly.')],
  right: [s('adjective', 'Correct; true; not mistaken.'), s('adjective', 'On the side opposite to the left.'), s('noun', 'A moral or legal entitlement.'), s('adverb', 'Immediately; directly.')],
  lead: [s('verb', 'To guide or show the way by going in front.'), s('noun', 'A soft heavy bluish-grey metal.'), s('noun', 'The first position in a race or contest.')],
  fair: [s('adjective', 'Treating people equally; just.'), s('adjective', 'Light in colour, of hair or skin.'), s('noun', 'An event with entertainment, rides and stalls.'), s('adjective', 'Of moderate quality; neither good nor bad.')],
  close: [s('verb', 'To shut something so that it is no longer open.'), s('adjective', 'Near in space or time.'), s('adverb', 'In a near position.'), s('noun', 'The end of something.')],
  address: [s('noun', 'The place where a person lives or an organization is located.'), s('verb', 'To speak or write to someone.'), s('noun', 'A formal speech.'), s('verb', 'To deal with a problem.')],
  minute: [s('noun', 'A period of sixty seconds.'), s('adjective', 'Extremely small.'), s('noun', 'A written record of a meeting.')],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mask = (k: string) => `…${k.slice(-4)}`;

async function main() {
  const key = lookupConfig.google.apiKey;
  if (!key && !OFFLINE) {
    console.log('GOOGLE_TRANSLATE_API_KEY is empty → experiment NOT run.');
    process.exit(2);
  }
  console.log(`google key: ${key ? mask(key) : '(offline)'}   max meanings: ${lookupConfig.lookup.maxMeanings}   max definition chars: ${lookupConfig.google.maxDefinitionChars}\n`);

  const openBreaker = (p: 'google_translate' | 'free_dictionary') => new CircuitBreaker(p, { failureThreshold: 1000, resetMs: 1000 });
  const google = new GoogleTranslateClient(
    { apiKey: key ?? '', baseUrl: lookupConfig.google.baseUrl, monthlyCharLimit: Number.MAX_SAFE_INTEGER, timeoutMs: 8000 },
    { usage: { reserve: async () => true, release: async () => undefined }, breaker: openBreaker('google_translate') }
  );
  const fd = new FreeDictionaryClient(
    { baseUrl: lookupConfig.freeDictionary.baseUrl, timeoutMs: 8000, maxAttempts: 1 },
    { breaker: openBreaker('free_dictionary'), bucket: new TokenBucket({ capacity: 1000, windowMs: 300_000 }) }
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows: string[] = [];
  let withTwoOrMore = 0;

  for (const word of WORDS) {
    if (OFFLINE) {
      const saved = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `${word}.json`), 'utf8'));
      const keepEchoOff = String(saved.headline).trim().toLowerCase() === word.toLowerCase();
      const splitsOff = (saved.translations as string[]).map((t) => splitGloss(t, word, keepEchoOff));
      const meaningsOff = dedupeMeanings([saved.headline, ...splitsOff.map((x) => x.gloss_vi)], lookupConfig.lookup.maxMeanings);
      if (new Set(meaningsOff.map((m) => m.toLowerCase())).size >= 2) withTwoOrMore++;
      rows.push(`| ${word} | ${saved.source} | ${meaningsOff.join('; ')} |`);
      continue;
    }

    // 1. Free Dictionary (flaky → retry), else the built-in fallback
    let senses: FdSense[] = [];
    let source = 'fallback';
    let fdNote = '';
    for (let attempt = 1; attempt <= FD_ATTEMPTS; attempt++) {
      try {
        const r = await fd.lookup(word);
        if (r.found && r.entry.senses.length > 0) {
          senses = r.entry.senses;
          source = 'free-dictionary';
          break;
        }
        fdNote = r.found ? 'no senses' : 'not found';
        break;
      } catch (err: any) {
        fdNote = `${err?.reason ?? err?.name ?? 'error'}${err?.status ? ' ' + err.status : ''}`;
        await sleep(FD_WAIT_MS);
      }
    }
    if (senses.length === 0) senses = FALLBACK[word] ?? [];
    if (senses.length === 0) {
      console.log(`${word}: no senses available, skipped`);
      continue;
    }

    // 2. F9 selection + ONE Google request
    const picked = selectSenses(senses, lookupConfig.lookup.maxMeanings);
    const queries = picked.map((p) => buildPrefixedQuery(word, p.definition, lookupConfig.google.maxDefinitionChars));
    let translations: string[] = [];
    let headline = '';
    let error = '';
    try {
      [headline] = await google.translate([word]);
      translations = await google.translate(queries);
    } catch (err: any) {
      error = String(err?.message ?? err).split(key).join('<key>');
    }

    // 3. Split + clean (the production functions)
    // Free Dictionary "confirmed" the word; an echo is kept only when the headline echoes it too (loanword).
    const keepEcho = headline.trim().toLowerCase() === word.toLowerCase();
    const splits = translations.map((t) => splitGloss(t, word, keepEcho));
    const glosses = splits.map((x) => x.gloss_vi);
    const meanings = dedupeMeanings([headline, ...glosses], lookupConfig.lookup.maxMeanings);
    if (new Set(meanings.map((m) => m.toLowerCase())).size >= 2) withTwoOrMore++;

    fs.writeFileSync(
      path.join(OUT_DIR, `${word}.json`),
      JSON.stringify({ word, source, captured_at: new Date().toISOString(), headline, senses: picked.map((p) => ({ pos: p.pos, definition: p.definition })), queries, translations }, null, 2) + '\n',
      'utf8'
    );

    console.log(`## ${word}   [senses from: ${source}${source === 'fallback' ? ` (FD: ${fdNote})` : ''}]${error ? '   ERROR: ' + error : ''}`);
    console.log(`headline_vi: ${JSON.stringify(headline)}`);
    picked.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.pos.padEnd(10)} q=${JSON.stringify(queries[i]).slice(0, 90)}`);
      console.log(`     raw → ${JSON.stringify(translations[i] ?? null)}`);
      console.log(`     gloss_vi=${JSON.stringify(splits[i]?.gloss_vi ?? null)}  definition_vi=${JSON.stringify((splits[i]?.definition_vi ?? '').slice(0, 70))}`);
    });
    console.log(`  → meanings_vi = ${JSON.stringify(meanings)}\n`);
    rows.push(`| ${word} | ${source} | ${meanings.join('; ')} |`);
  }

  console.log('| word | senses from | meanings_vi (headline + glosses) |\n|---|---|---|');
  rows.forEach((r) => console.log(r));
  console.log(`\nwords with >= 2 distinct meanings: ${withTwoOrMore}/${WORDS.length} (correctness must still be judged by a human)`);
}

main().catch((e) => {
  console.error('experiment failed:', String(e?.message ?? e).split(lookupConfig.google.apiKey ?? '\u0000').join('<key>'));
  process.exit(1);
});
