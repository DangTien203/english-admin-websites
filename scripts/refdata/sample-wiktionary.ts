/**
 * Surveys the Wiktionary (wiktextract) dump in ONE streaming pass — before any filter is written, so no
 * field name is guessed (docs/lookup-spec.md §0.8).
 *
 *   npm run refdata:sample [-- --file data/refdata/raw-wiktextract-data.jsonl.gz --limit-lines N]
 *
 * Writes:
 *   tests/fixtures/refdata/wiktionary-sample.jsonl   every English row of the target words + 10 random English rows
 *                                                    (at least one with sounds that carry an mp3_url)
 *   tests/fixtures/refdata/wiktionary-survey.json    key / tag statistics over ALL English rows
 *
 * Rows over 50 KB lose translations, descendants and categories; the dropped keys are listed in
 * `_sample.trimmed`. Reads the .gz as a stream: nothing is decompressed to disk or held in memory.
 *
 * The "random" rows are drawn only from words that the importer would keep (lowercase word in the top
 * SAMPLE_TOP_N of data/refdata/wordfreq-en.tsv), so the sample is representative of what is loaded and
 * does not contain obscure or offensive one-off entries.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as zlib from 'zlib';
import { fmtDuration, fmtInt } from './lib/db';

const DEFAULT_FILE = path.resolve(__dirname, '../../data/refdata/raw-wiktextract-data.jsonl.gz');
const OUT_DIR = path.resolve(__dirname, '../../tests/fixtures/refdata');

// The exact serialization in the dump: a space after the colon.
export const EN_MARKER = '"lang_code": "en"';
export const TARGET_WORDS = ['run', 'ran', 'running', 'children', 'colour', 'ubiquitous', 'serendipity', 'London', 'recieve', 'taxi', 'karaoke'];
export const MAX_SAMPLE_LINE_BYTES = 50 * 1024;
const TRIM_KEYS = ['translations', 'descendants', 'categories'];
const RANDOM_ROWS = 10;
const SAMPLE_TOP_N = 150_000;
const WORDFREQ_TSV = path.resolve(__dirname, '../../data/refdata/wordfreq-en.tsv');
const RANK_BUCKETS = [25_000, 50_000, 100_000, 150_000, 200_000];

/** word → rank from the exported wordfreq TSV (small: ~190k short lines). Empty map when the file is absent. */
function loadRanks(): Map<string, number> {
  const ranks = new Map<string, number>();
  if (!fs.existsSync(WORDFREQ_TSV)) return ranks;
  for (const line of fs.readFileSync(WORDFREQ_TSV, 'utf8').split('\n')) {
    const [word, , rank] = line.split('\t');
    if (word && rank) ranks.set(word, Number(rank));
  }
  return ranks;
}

/** Deterministic PRNG so the "random" rows are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Counter = Record<string, number>;
const bump = (c: Counter, k: string, by = 1) => {
  c[k] = (c[k] ?? 0) + by;
};
const top = (c: Counter, n: number) => Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n);

interface Survey {
  enRows: number;
  topLevelKeys: Counter;
  senseCount: number;
  senseKeys: Counter;
  senseTags: Counter;
  senseRawTags: Counter;
  formKeys: Counter;
  formTags: Counter;
  soundKeys: Counter;
  soundTags: Counter;
  headTemplateKeys: Counter;
  headTemplateNames: Counter;
  exampleKeys: Counter;
  rowsWithMp3: number;
  rowsWithOgg: number;
  rowsOnlyOgg: number;
  posValues: Counter;
  rowsAllSensesFormOf: number;
  rowsAllSensesAltOf: number;
  formOfShapes: Counter;
  altOfShapes: Counter;
  topLevelTags: Counter;
  linesOver50k: number;
  // limits the reducer has to respect
  rowsSensesOver8: number;
  rowsFormsOver20: number;
  rowsSoundsOver8: number;
  rowsFirstAudioBeyond8: number;
  rowsEtymologyOver1000: number;
  // English rows per wordfreq rank bucket (how many rows each --top-n keeps)
  rowsByRankBucket: Counter;
  rowsWithoutRank: number;
}

function newSurvey(): Survey {
  return {
    enRows: 0, topLevelKeys: {}, senseCount: 0, senseKeys: {}, senseTags: {}, senseRawTags: {}, formKeys: {}, formTags: {},
    soundKeys: {}, soundTags: {}, headTemplateKeys: {}, headTemplateNames: {}, exampleKeys: {}, rowsWithMp3: 0, rowsWithOgg: 0,
    rowsOnlyOgg: 0, posValues: {}, rowsAllSensesFormOf: 0, rowsAllSensesAltOf: 0, formOfShapes: {}, altOfShapes: {}, topLevelTags: {}, linesOver50k: 0,
    rowsSensesOver8: 0, rowsFormsOver20: 0, rowsSoundsOver8: 0, rowsFirstAudioBeyond8: 0, rowsEtymologyOver1000: 0, rowsByRankBucket: {}, rowsWithoutRank: 0,
  };
}

function tally(s: Survey, row: any, lineLength: number, rank: number | undefined): void {
  s.enRows++;
  if (rank === undefined) s.rowsWithoutRank++;
  else for (const b of RANK_BUCKETS) if (rank <= b) bump(s.rowsByRankBucket, String(b));
  if ((row.senses?.length ?? 0) > 8) s.rowsSensesOver8++;
  if ((row.forms?.length ?? 0) > 20) s.rowsFormsOver20++;
  if (typeof row.etymology_text === 'string' && row.etymology_text.length > 1000) s.rowsEtymologyOver1000++;
  const sounds: any[] = row.sounds ?? [];
  if (sounds.length > 8) {
    s.rowsSoundsOver8++;
    const firstAudio = sounds.findIndex((x) => x.mp3_url || x.ogg_url);
    if (firstAudio >= 8) s.rowsFirstAudioBeyond8++;
  }
  if (lineLength > MAX_SAMPLE_LINE_BYTES) s.linesOver50k++;
  for (const k of Object.keys(row)) bump(s.topLevelKeys, k);
  bump(s.posValues, String(row.pos));
  if (Array.isArray(row.tags)) row.tags.forEach((t: string) => bump(s.topLevelTags, t));

  const senses: any[] = Array.isArray(row.senses) ? row.senses : [];
  s.senseCount += senses.length;
  let allFormOf = senses.length > 0;
  let allAltOf = senses.length > 0;
  for (const sense of senses) {
    for (const k of Object.keys(sense)) bump(s.senseKeys, k);
    (sense.tags ?? []).forEach((t: string) => bump(s.senseTags, t));
    (sense.raw_tags ?? []).forEach((t: string) => bump(s.senseRawTags, t));
    if (!sense.form_of) allFormOf = false;
    else bump(s.formOfShapes, Array.isArray(sense.form_of) ? `array<${Object.keys(sense.form_of[0] ?? {}).join('+')}>` : typeof sense.form_of);
    if (!sense.alt_of) allAltOf = false;
    else bump(s.altOfShapes, Array.isArray(sense.alt_of) ? `array<${Object.keys(sense.alt_of[0] ?? {}).join('+')}>` : typeof sense.alt_of);
    for (const ex of (sense.examples ?? []).slice(0, 3)) for (const k of Object.keys(ex)) bump(s.exampleKeys, k);
  }
  if (allFormOf) s.rowsAllSensesFormOf++;
  if (allAltOf) s.rowsAllSensesAltOf++;

  for (const f of row.forms ?? []) {
    for (const k of Object.keys(f)) bump(s.formKeys, k);
    (f.tags ?? []).forEach((t: string) => bump(s.formTags, t));
  }

  let hasMp3 = false;
  let hasOgg = false;
  for (const snd of row.sounds ?? []) {
    for (const k of Object.keys(snd)) bump(s.soundKeys, k);
    (snd.tags ?? []).forEach((t: string) => bump(s.soundTags, t));
    if (snd.mp3_url) hasMp3 = true;
    if (snd.ogg_url) hasOgg = true;
  }
  if (hasMp3) s.rowsWithMp3++;
  if (hasOgg) s.rowsWithOgg++;
  if (hasOgg && !hasMp3) s.rowsOnlyOgg++;

  for (const h of row.head_templates ?? []) {
    for (const k of Object.keys(h)) bump(s.headTemplateKeys, k);
    bump(s.headTemplateNames, String(h.name));
  }
}

function hasMp3Url(row: any): boolean {
  return (row.sounds ?? []).some((snd: any) => Boolean(snd.mp3_url));
}

/** Rows over 50 KB lose the three bulky keys; the note lists what was dropped. */
export function trimForSample(row: any, lineLength: number, reason: string): any {
  const out: any = { ...row };
  const trimmed: string[] = [];
  if (lineLength > MAX_SAMPLE_LINE_BYTES) {
    for (const k of TRIM_KEYS) {
      if (k in out) {
        delete out[k];
        trimmed.push(k);
      }
    }
  }
  out._sample = trimmed.length > 0 ? { reason, original_bytes: lineLength, trimmed } : { reason };
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
  const file = path.resolve(arg('--file') ?? DEFAULT_FILE);
  const limitLines = arg('--limit-lines') ? Number(arg('--limit-lines')) : Infinity;

  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const fileSize = fs.statSync(file).size;
  const raw = fs.createReadStream(file);
  let compressedBytes = 0;
  raw.on('data', (chunk) => (compressedBytes += chunk.length));
  const rl = readline.createInterface({ input: raw.pipe(zlib.createGunzip()), crlfDelay: Infinity });

  const ranks = loadRanks();
  const eligible = (word: unknown) => typeof word === 'string' && (ranks.get(word.toLowerCase()) ?? Infinity) <= SAMPLE_TOP_N;
  console.log(ranks.size > 0 ? `rank file: ${fmtInt(ranks.size)} words (random rows come from the top ${fmtInt(SAMPLE_TOP_N)})` : 'rank file missing: random rows are unrestricted (run npm run refdata:wordfreq:export first)');
  const targets = new Set(TARGET_WORDS);
  const targetRows: Array<{ row: any; length: number }> = [];
  const survey = newSurvey();
  const rand = mulberry32(20261014);
  const reservoir: Array<{ row: any; length: number }> = [];
  let firstMp3: { row: any; length: number } | undefined;
  let eligibleSeen = 0;

  let lines = 0;
  let prefilterPass = 0;
  let bad = 0;
  const started = Date.now();

  for await (const line of rl) {
    lines++;
    if (lines > limitLines) break;
    if (lines % 500_000 === 0) {
      const elapsed = (Date.now() - started) / 1000;
      const frac = compressedBytes / fileSize;
      console.log(`  ${fmtInt(lines)} lines · ${fmtInt(survey.enRows)} English · ${(lines / elapsed / 1000).toFixed(1)}k lines/s · ${(frac * 100).toFixed(0)}% · ETA ${fmtDuration(elapsed / frac - elapsed)}`);
    }
    if (!line.includes(EN_MARKER)) continue; // cheap test: almost 3/4 of the dump is not English
    prefilterPass++;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    if (row.lang_code !== 'en') continue; // the marker also occurs inside nested objects of other languages

    tally(survey, row, line.length, ranks.get(String(row.word).toLowerCase()));

    if (targets.has(row.word)) targetRows.push({ row, length: line.length });

    // reservoir sample of RANDOM_ROWS eligible English rows (at most 10 are alive)
    if (ranks.size === 0 || eligible(row.word)) {
      eligibleSeen++;
      if (reservoir.length < RANDOM_ROWS) reservoir.push({ row, length: line.length });
      else {
        const j = Math.floor(rand() * eligibleSeen);
        if (j < RANDOM_ROWS) reservoir[j] = { row, length: line.length };
      }
      if (!firstMp3 && hasMp3Url(row)) firstMp3 = { row, length: line.length };
    }
  }
  rl.close();
  raw.destroy();

  // make sure at least one random row has sounds with an mp3_url
  if (!reservoir.some((r) => hasMp3Url(r.row)) && firstMp3) reservoir[reservoir.length - 1] = firstMp3;

  const seen = new Set<string>();
  const outLines: string[] = [];
  const emit = (r: { row: any; length: number }, reason: string) => {
    const key = `${r.row.word}|${r.row.pos}|${r.row.etymology_number ?? ''}|${r.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    outLines.push(JSON.stringify(trimForSample(r.row, r.length, reason)));
  };
  targetRows.forEach((r) => emit(r, 'target-word'));
  reservoir.forEach((r) => emit(r, 'random'));

  const samplePath = path.join(OUT_DIR, 'wiktionary-sample.jsonl');
  fs.writeFileSync(samplePath, outLines.join('\n') + '\n', 'utf8');

  const seconds = (Date.now() - started) / 1000;
  const summary = {
    file: path.basename(file),
    gz_bytes: fileSize,
    lines_read: Math.min(lines, limitLines),
    prefilter_pass: prefilterPass,
    english_rows: survey.enRows,
    prefilter_false_positives: prefilterPass - bad - survey.enRows,
    unparseable_lines: bad,
    seconds: Math.round(seconds),
    lines_per_second: Math.round(Math.min(lines, limitLines) / seconds),
    sample_rows: outLines.length,
    sample_bytes: fs.statSync(samplePath).size,
  };
  const out = {
    summary,
    topLevelKeys: top(survey.topLevelKeys, 60),
    posValues: top(survey.posValues, 30),
    senseCount: survey.senseCount,
    senseKeys: top(survey.senseKeys, 40),
    senseTags_top: top(survey.senseTags, 60),
    senseRawTags_top: top(survey.senseRawTags, 25),
    formOfShapes: top(survey.formOfShapes, 10),
    altOfShapes: top(survey.altOfShapes, 10),
    rowsAllSensesFormOf: survey.rowsAllSensesFormOf,
    rowsAllSensesAltOf: survey.rowsAllSensesAltOf,
    formKeys: top(survey.formKeys, 20),
    formTags_top: top(survey.formTags, 25),
    soundKeys: top(survey.soundKeys, 20),
    soundTags_top: top(survey.soundTags, 40),
    rowsWithMp3: survey.rowsWithMp3,
    rowsWithOgg: survey.rowsWithOgg,
    rowsOnlyOgg: survey.rowsOnlyOgg,
    headTemplateKeys: top(survey.headTemplateKeys, 10),
    headTemplateNames_top: top(survey.headTemplateNames, 15),
    exampleKeys: top(survey.exampleKeys, 15),
    topLevelTags: top(survey.topLevelTags, 15),
    linesOver50k: survey.linesOver50k,
    limits: {
      rowsSensesOver8: survey.rowsSensesOver8,
      rowsFormsOver20: survey.rowsFormsOver20,
      rowsSoundsOver8: survey.rowsSoundsOver8,
      rowsFirstAudioBeyond8: survey.rowsFirstAudioBeyond8,
      rowsEtymologyOver1000: survey.rowsEtymologyOver1000,
    },
    englishRowsByTopN: survey.rowsByRankBucket,
    englishRowsWithoutRank: survey.rowsWithoutRank,
    senseTagCounts: Object.fromEntries(['misspelling', 'obsolete', 'archaic', 'nonstandard', 'dialectal', 'rare', 'proscribed'].map((t) => [t, survey.senseTags[t] ?? 0])),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'wiktionary-survey.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

  console.log('\n' + JSON.stringify(summary, null, 2));
  console.log(`target rows found: ${targetRows.length} (${[...new Set(targetRows.map((r) => r.row.word))].join(', ')})`);
  console.log(`wrote ${samplePath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('sample-wiktionary failed:', err?.message ?? err);
    process.exit(1);
  });
}
