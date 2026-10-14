/**
 * MANUAL end-to-end check of the word-lookup fast path against the REAL database and REAL services.
 * Run: npx tsx scripts/smoke/lookup-live.ts [word ...]      (default: run ubiquitous)
 *
 * - Uses the production wiring (config/lookup.ts, real Google + Free Dictionary clients, real breakers,
 *   real api_usage_counters ledger) — so it spends a little Google quota.
 * - READS the dictionary tables normally, but SKIPS the two row-creating writes (word_lookups,
 *   word_forms): word_lookups needs a real user id and this script must not invent data.
 * - Prints the structured lookup log (timings per step) and a summary of the response.
 * - Never prints API keys.
 */
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { NoopEnqueuer } from '../../services/lookup/enqueuer';
import { buildFastTranslator } from '../../services/lookup';
import { WordLookupService } from '../../services/lookup/lookupService';
import { UserRateLimiter } from '../../services/lookup/rateLimiter';
import { SingleFlight } from '../../services/lookup/singleFlight';
import type { Db, UpstreamBundle } from '../../services/lookup/types';
import { normalizeWord } from '../../services/wordTranslationService';
import { getUpstreamClients } from '../../services/upstream';

const WORDS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['run', 'ubiquitous'];

const skippedWrites: string[] = [];
const dryRunDb: Db = {
  async query(sql: string, params?: any[]) {
    if (/INSERT INTO (word_lookups|word_forms)/.test(sql)) {
      skippedWrites.push(/word_lookups/.test(sql) ? `word_lookups(${params?.[3]})` : 'word_forms');
      return { rows: [] };
    }
    return pool.query(sql, params);
  },
};

async function main() {
  const clients = getUpstreamClients();
  const logs: Record<string, unknown>[] = [];
  const service = new WordLookupService({
    db: dryRunDb,
    refDb: dryRunDb,
    translator: buildFastTranslator(clients), // LOOKUP_FAST_TRANSLATOR=google|haiku (override per run: LOOKUP_FAST_TRANSLATOR=haiku npx tsx …)
    google: clients.google,
    freeDictionary: clients.freeDictionary,
    enqueuer: new NoopEnqueuer(),
    rateLimiter: new UserRateLimiter(lookupConfig.lookup.missRateLimitPerMin),
    singleFlight: new SingleFlight<UpstreamBundle>(),
    config: {
      totalDeadlineMs: lookupConfig.lookup.totalDeadlineMs,
      maxMeanings: lookupConfig.lookup.maxMeanings,
      translateDefinitions: lookupConfig.lookup.translateDefinitions,
      maxDefinitionChars: lookupConfig.google.maxDefinitionChars,
      translationFallbackEnabled: lookupConfig.flags.translationFallbackEnabled,
      enrichmentEnabled: lookupConfig.flags.enrichmentEnabled,
    },
    log: (r) => logs.push(r),
  });

  console.log(
    `config: timeout=${lookupConfig.lookup.upstreamTimeoutMs}ms deadline=${lookupConfig.lookup.totalDeadlineMs}ms ` +
      `maxMeanings=${lookupConfig.lookup.maxMeanings} translateDefinitions=${lookupConfig.lookup.translateDefinitions} translator=${lookupConfig.lookup.fastTranslator} ` +
      `fallback=${lookupConfig.flags.translationFallbackEnabled} google=${lookupConfig.google.enabled ? 'on' : 'OFF'}\n`
  );

  for (const raw of WORDS) {
    const n = normalizeWord(raw);
    if (!n.isValid) {
      console.log(`${raw}: invalid (${n.reason})`);
      continue;
    }
    const t0 = Date.now();
    const result: any = await service.lookup({ userId: 'smoke-user', ebookId: 'smoke-ebook', paragraphId: null, word: { normalized: n.normalized, display: n.display } });
    const wall = Date.now() - t0;
    const log = logs[logs.length - 1] ?? {};

    console.log(`══ ${raw}  → ${result.kind}   wall=${wall}ms`);
    console.log('log:', JSON.stringify(log));
    if (result.kind === 'temporary') {
      const b = result.body;
      console.log('response:', JSON.stringify({
        source: b.source, temporary: b.temporary, word: b.word, headword: b.headword, translation_vi: b.translation_vi,
        meanings_vi: b.meanings_vi, phonetic: b.phonetic, ipa: b.ipa, audio_url: b.audio_url, pos: b.pos, pos_list: b.pos_list,
        partial: b.partial, missing: b.missing, providers: b.providers,
        senses: b.senses.map((s: any) => ({ pos: s.pos, gloss_vi: s.gloss_vi, definition_vi: s.definition_vi?.slice(0, 50) ?? null, definition_en: s.definition_en.slice(0, 50) })),
        attribution: b.attribution, enrichment: b.enrichment,
      }, null, 1));
    } else if (result.kind === 'dictionary') {
      console.log('dictionary entry:', result.entry.headword, result.matchedForm ? `(matched_form ${result.matchedForm})` : '');
    }
    console.log();
  }
  console.log('breakers:', JSON.stringify(Object.values(clients.breakers).map((b) => `${b.provider}:${b.currentState()}`)));
  console.log('writes skipped (dry run):', skippedWrites.join(', ') || 'none');
  await pool.end();
}

main().catch(async (e) => {
  console.error('live check failed:', String(e?.message ?? e).slice(0, 300));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
