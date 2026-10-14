/**
 * MANUAL benchmark (never part of the automated suite): Google vs Claude Haiku as the fast translator.
 * Run: npx tsx scripts/smoke/fast-translator-benchmark.ts [--runs 20] [--skip-fast-path]
 *
 * A. RAW LATENCY   the translator step alone, N calls per engine, interleaved (Google, Haiku, Google, …) so both
 *                  see the same network conditions. Generous timeout (15 s): this is the true latency distribution.
 * B. FAST PATH     the production composition (translator ‖ Free Dictionary, then step 2) under the configured
 *                  LOOKUP_UPSTREAM_TIMEOUT_MS / LOOKUP_TOTAL_DEADLINE_MS, N lookups per mode, interleaved.
 * C. QUALITY       Haiku's meanings for the 12 experiment words (taken from part A) next to the Google-mode
 *                  meanings saved by the P3 experiment (tests/fixtures/lookup/google-prefix).
 * D. EDGE WORDS    a few inputs where the engines behave differently (not a word, loanword, inflected form).
 *
 * Real services, the budget ledger stubbed out (no database). Never prints API keys. Spends real money:
 * roughly 40 Haiku calls (~$0.004) and ~10k Google characters.
 */
import * as fs from 'fs';
import * as path from 'path';
import { lookupConfig } from '../../config/lookup';
import { FallbackFastTranslator, FastTranslator, GoogleFastTranslator } from '../../services/lookup/fastTranslator';
import { HaikuFastTranslator } from '../../services/lookup/haikuFastTranslator';
import { mergeOutcome } from '../../services/lookup/merge';
import { dedupeMeanings, splitGloss, truncateDefinition } from '../../services/lookup/senseSelection';
import { fetchUpstream } from '../../services/lookup/upstream';
import { AnthropicEnrichClient } from '../../services/upstream/anthropicEnrichClient';
import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { FreeDictionaryClient } from '../../services/upstream/freeDictionaryClient';
import { GoogleTranslateClient } from '../../services/upstream/googleTranslateClient';
import { TokenBucket } from '../../services/upstream/tokenBucket';

const ARGS = process.argv.slice(2);
const RUNS = Number(ARGS[ARGS.indexOf('--runs') + 1]) > 0 ? Number(ARGS[ARGS.indexOf('--runs') + 1]) : 20;
const SKIP_FAST_PATH = ARGS.includes('--skip-fast-path');
const WORDS = ['run', 'light', 'bank', 'bat', 'match', 'spring', 'right', 'lead', 'fair', 'close', 'address', 'minute'];
const EDGE = ['qwxz', 'taxi', 'running', 'colour'];

// Anthropic list price for claude-haiku-5-5 (prompts up to 100K tokens), USD per million tokens.
const HAIKU_USD_PER_MTOK = { input: 0.1, output: 0.5 };
// Google Cloud Translation Basic list price. NOT re-verified in this session; used only for the order of magnitude.
const GOOGLE_USD_PER_MCHAR = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mask = (k?: string) => (k ? `…${k.slice(-4)}` : '(none)');

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}
const fmt = (n: number) => (Number.isFinite(n) ? `${Math.round(n)}` : '-');
const stats = (v: number[]) => `p50 ${fmt(percentile(v, 50))} ms · p95 ${fmt(percentile(v, 95))} ms · min ${fmt(Math.min(...v))} · max ${fmt(Math.max(...v))} (n=${v.length})`;

function buildClients(opts: { timeoutMs: number; breakerThreshold: number }) {
  const key = lookupConfig.google.apiKey;
  const anthropicKey = lookupConfig.anthropic.apiKey;
  if (!key || !anthropicKey) {
    console.log('GOOGLE_TRANSLATE_API_KEY and ANTHROPIC_API_KEY are both required → benchmark NOT run.');
    process.exit(2);
  }
  const breaker = (p: 'google_translate' | 'free_dictionary' | 'anthropic') => new CircuitBreaker(p, { failureThreshold: opts.breakerThreshold, resetMs: 30_000 });
  const google = new GoogleTranslateClient(
    { apiKey: key, baseUrl: lookupConfig.google.baseUrl, monthlyCharLimit: Number.MAX_SAFE_INTEGER, timeoutMs: opts.timeoutMs },
    { usage: { reserve: async () => true, release: async () => undefined }, breaker: breaker('google_translate') }
  );
  const fd = new FreeDictionaryClient(
    { baseUrl: lookupConfig.freeDictionary.baseUrl, timeoutMs: opts.timeoutMs },
    { breaker: breaker('free_dictionary'), bucket: new TokenBucket({ capacity: 1000, windowMs: 300_000 }) }
  );
  const anthropic = new AnthropicEnrichClient(
    { apiKey: anthropicKey, model: lookupConfig.anthropic.modelEnrich, maxOutputTokens: 300, timeoutMs: opts.timeoutMs },
    { breaker: breaker('anthropic') }
  );
  return { google, fd, anthropic };
}

interface Tokens {
  inputTokens: number;
  outputTokens: number;
}

function makeTranslators(c: ReturnType<typeof buildClients>) {
  const tokens: Tokens = { inputTokens: 0, outputTokens: 0 };
  const googleT = new GoogleFastTranslator(c.google);
  const haiku = new HaikuFastTranslator({
    client: c.anthropic,
    maxMeanings: lookupConfig.lookup.maxMeanings,
    recordUsage: (u) => {
      tokens.inputTokens += u.inputTokens;
      tokens.outputTokens += u.outputTokens;
    },
  });
  const haikuWithFallback = new FallbackFastTranslator(haiku, googleT);
  return { googleT, haiku, haikuWithFallback, tokens };
}

const haikuCost = (t: Tokens) => (t.inputTokens * HAIKU_USD_PER_MTOK.input + t.outputTokens * HAIKU_USD_PER_MTOK.output) / 1e6;

async function timedTranslate(t: FastTranslator, word: string) {
  const t0 = Date.now();
  try {
    const r = await t.translate({ word });
    return { ok: true as const, ms: Date.now() - t0, r };
  } catch (e: any) {
    return { ok: false as const, ms: Date.now() - t0, err: `${e?.reason ?? e?.name ?? 'error'}` };
  }
}

async function main() {
  console.log(`google key ${mask(lookupConfig.google.apiKey)} · anthropic key ${mask(lookupConfig.anthropic.apiKey)} · model ${lookupConfig.anthropic.modelEnrich}`);
  console.log(`config: timeout ${lookupConfig.lookup.upstreamTimeoutMs} ms · deadline ${lookupConfig.lookup.totalDeadlineMs} ms · max meanings ${lookupConfig.lookup.maxMeanings} · translate definitions ${lookupConfig.lookup.translateDefinitions}\n`);
  const out: any = { when: new Date().toISOString(), runs: RUNS };

  // ── A. raw latency ──────────────────────────────────────────────────────────
  {
    const c = buildClients({ timeoutMs: 15_000, breakerThreshold: 1000 });
    const { googleT, haiku, tokens } = makeTranslators(c);
    const g: number[] = [];
    const h: number[] = [];
    const haikuFailures: string[] = [];
    const haikuMeanings: Record<string, { vi: string[]; pos: Array<string | null> }> = {};

    // warm-up: first Haiku call compiles the schema and opens the TLS connection; reported separately.
    const warm = await timedTranslate(haiku, 'warm');
    console.log(`A. warm-up (first Haiku call, schema compile + connection): ${warm.ms} ms\n`);
    tokens.inputTokens = 0;
    tokens.outputTokens = 0;

    for (let i = 0; i < RUNS; i++) {
      const word = WORDS[i % WORDS.length];
      const [a, b] = await Promise.all([timedTranslate(googleT, word).then((x) => x), (async () => { await sleep(0); return timedTranslate(haiku, word); })()]);
      if (a.ok) g.push(a.ms);
      if (b.ok) {
        h.push(b.ms);
        if (i < WORDS.length) haikuMeanings[word] = { vi: b.r.meanings_vi, pos: b.r.pos ?? [] };
      } else haikuFailures.push(`${word}:${b.err}`);
      await sleep(150);
    }
    console.log('A. RAW LATENCY of the translator step alone (timeout 15 s)');
    console.log(`   Google : ${stats(g)}`);
    console.log(`   Haiku  : ${stats(h)}${haikuFailures.length ? '   FAILURES: ' + haikuFailures.join(', ') : ''}`);
    const over = h.filter((x) => x > lookupConfig.lookup.upstreamTimeoutMs).length;
    console.log(`   Haiku calls slower than LOOKUP_UPSTREAM_TIMEOUT_MS (${lookupConfig.lookup.upstreamTimeoutMs} ms): ${over}/${h.length} → would fall back to Google`);
    console.log(`   Haiku tokens: in ${tokens.inputTokens} · out ${tokens.outputTokens} over ${h.length} calls → avg in ${fmt(tokens.inputTokens / h.length)} / out ${fmt(tokens.outputTokens / h.length)} · cost $${haikuCost(tokens).toFixed(5)} total = $${(haikuCost(tokens) / h.length).toFixed(6)} per lookup\n`);
    out.A = { warm_ms: warm.ms, google: { p50: percentile(g, 50), p95: percentile(g, 95), samples: g }, haiku: { p50: percentile(h, 50), p95: percentile(h, 95), samples: h, failures: haikuFailures, slower_than_timeout: over }, haiku_tokens: { ...tokens, usd_per_lookup: haikuCost(tokens) / h.length } };

    // ── C. quality ────────────────────────────────────────────────────────────
    console.log('C. QUALITY — meanings_vi for the 12 experiment words');
    console.log('| word | Google mode (headline + glosses, P3 experiment) | Haiku mode (meanings, with part of speech) |\n|---|---|---|');
    const dir = path.resolve(__dirname, '../../tests/fixtures/lookup/google-prefix');
    const quality: any[] = [];
    for (const word of WORDS) {
      const fx = JSON.parse(fs.readFileSync(path.join(dir, `${word}.json`), 'utf8'));
      const keepEcho = String(fx.headline).trim().toLowerCase() === word;
      const lowerFirst = (s: string) => (s ? s.charAt(0).toLocaleLowerCase('vi') + s.slice(1) : s);
      const glosses = (fx.translations as string[]).map((t) => splitGloss(t, word, keepEcho).gloss_vi);
      const googleMeanings = dedupeMeanings([lowerFirst(fx.headline), ...glosses.map((x) => (x ? lowerFirst(x) : x))], lookupConfig.lookup.maxMeanings);
      const hm = haikuMeanings[word];
      const haikuText = hm ? hm.vi.map((v, i) => `${v} (${hm.pos[i] ?? '?'})`).join('; ') : '(no answer)';
      console.log(`| ${word} | ${googleMeanings.join('; ')} | ${haikuText} |`);
      quality.push({ word, google: googleMeanings, haiku: hm ?? null, senses_from: fx.source });
    }
    console.log();
    out.C = quality;

    // ── D. edge words ─────────────────────────────────────────────────────────
    console.log('D. EDGE WORDS');
    for (const word of EDGE) {
      const [gr, hr] = await Promise.all([timedTranslate(googleT, word), timedTranslate(haiku, word)]);
      console.log(`   ${word.padEnd(8)} Google: ${gr.ok ? JSON.stringify(gr.r.meanings_vi) : gr.err} (${gr.ms} ms) · Haiku: ${hr.ok ? JSON.stringify(hr.r.meanings_vi.map((v, i) => `${v} (${hr.r.pos?.[i]})`)) : hr.err} (${hr.ms} ms)`);
    }
    console.log();
  }

  // ── B. production-like fast path ────────────────────────────────────────────
  if (!SKIP_FAST_PATH) {
    const cfg = {
      totalDeadlineMs: lookupConfig.lookup.totalDeadlineMs,
      maxMeanings: lookupConfig.lookup.maxMeanings,
      translateDefinitions: lookupConfig.lookup.translateDefinitions,
      maxDefinitionChars: lookupConfig.google.maxDefinitionChars,
    };
    const c = buildClients({ timeoutMs: lookupConfig.lookup.upstreamTimeoutMs, breakerThreshold: lookupConfig.breaker.failureThreshold });
    const t = makeTranslators(c);
    const modes: Array<[string, FastTranslator]> = [
      ['google', t.googleT],
      ['haiku', t.haikuWithFallback],
    ];
    interface ModeResult {
      total: number[];
      translation: number[];
      fd: number[];
      step2Ms: number[];
      step2Status: Record<string, number>;
      partial: number;
      full: number;
      notFound: number;
      unavailable: number;
      fallbacks: string[];
      engines: Record<string, number>;
      googleChars: number;
    }
    const results: Record<string, ModeResult> = {};
    for (const [name] of modes) {
      results[name] = { total: [], translation: [], fd: [], step2Ms: [], step2Status: {}, partial: 0, full: 0, notFound: 0, unavailable: 0, fallbacks: [], engines: {}, googleChars: 0 };
    }

    for (let i = 0; i < RUNS; i++) {
      const word = WORDS[i % WORDS.length];
      for (const [name, translator] of modes) {
        const t0 = Date.now();
        const bundle = await fetchUpstream(word, { translator, google: c.google, freeDictionary: c.fd, config: cfg });
        const total = Date.now() - t0;
        const merged = mergeOutcome(bundle, cfg.maxMeanings);
        const r = results[name];
        r.total.push(total);
        r.translation.push(bundle.translation.ms);
        r.fd.push(bundle.fd.ms);
        if (bundle.step2.status === 'ran') r.step2Ms.push(bundle.step2.ms);
        const s2 = bundle.step2.status;
        r.step2Status[s2] = (r.step2Status[s2] ?? 0) + 1;
        if (merged.kind === 'temporary') merged.partial ? r.partial++ : r.full++;
        else if (merged.kind === 'not_found') r.notFound++;
        else r.unavailable++;
        if (bundle.translation.status === 'ok') {
          r.engines[bundle.translation.engine] = (r.engines[bundle.translation.engine] ?? 0) + 1;
          if (bundle.translation.fallback) r.fallbacks.push(bundle.translation.fallback.reason);
        }
        // Google characters this lookup used (headline only in google mode; definitions in both)
        if (name === 'google' || (bundle.translation.status === 'ok' && bundle.translation.engine === 'google')) r.googleChars += word.length;
        if (s2 === 'ran' && bundle.fd.status === 'found') {
          r.googleChars += bundle.step2.senses.reduce((n, s) => n + `${bundle.fd.status === 'found' ? bundle.fd.entry.headword : word}: ${truncateDefinition(s.definition_en, cfg.maxDefinitionChars)}`.length, 0);
        }
      }
      await sleep(150);
    }

    console.log(`B. FAST PATH, production timings (timeout ${lookupConfig.lookup.upstreamTimeoutMs} ms, deadline ${lookupConfig.lookup.totalDeadlineMs} ms), ${RUNS} lookups per mode`);
    for (const [name] of modes) {
      const r = results[name];
      const s2counts = Object.entries(r.step2Status).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`   ${name.padEnd(6)} total ${stats(r.total)}`);
      console.log(`          translator step ${stats(r.translation)}`);
      console.log(`          free dictionary ${stats(r.fd)}`);
      console.log(`          full ${r.full} · partial ${r.partial} · not_found ${r.notFound} · unavailable ${r.unavailable} · engines ${JSON.stringify(r.engines)}${r.fallbacks.length ? ' · fallbacks ' + JSON.stringify(r.fallbacks) : ''}`);
      console.log(`          step 2: ${s2counts}${r.step2Ms.length ? ' · ' + stats(r.step2Ms) : ''} · google chars ${r.googleChars} (≈ $${((r.googleChars * GOOGLE_USD_PER_MCHAR) / 1e6).toFixed(4)} at list price)`);
    }
    console.log(`   Haiku tokens in this part: in ${t.tokens.inputTokens} · out ${t.tokens.outputTokens} · $${haikuCost(t.tokens).toFixed(5)}\n`);
    out.B = Object.fromEntries(modes.map(([name]) => [name, { ...results[name], total_p50: percentile(results[name].total, 50), total_p95: percentile(results[name].total, 95), translation_p50: percentile(results[name].translation, 50), translation_p95: percentile(results[name].translation, 95) }]));
    out.B_haiku_tokens = t.tokens;
  }

  fs.writeFileSync(path.resolve(__dirname, '../../tests/fixtures/lookup/fast-translator-benchmark.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('raw numbers saved to tests/fixtures/lookup/fast-translator-benchmark.json');
}

main().catch((e) => {
  console.error('benchmark failed:', String(e?.message ?? e).slice(0, 300));
  process.exit(1);
});
