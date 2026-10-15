/**
 * Runs enrichment stages S1–S4 for ONE word and prints the draft. Writes NOTHING to the database.
 *
 *   npm run enrich:draft -- --word ubiquitous [--force] [--json]
 *
 * - Does NOT skip words that are already in the dictionary (so it works for "run").
 * - By default Haiku is not called when no source recognizes the word (unknown_word) or when every Wiktionary row is a
 *   misspelling / obsolete form (variant_form), as the job would not call it either (docs/lookup-spec.md §8, S2).
 *   --force calls Haiku anyway, to see how the model classifies such a word.
 * - A transient Free Dictionary failure does not stop the draft here (the real job would be retried by pg-boss).
 * - --json prints one JSON document instead of the readable report.
 */
import 'dotenv/config';
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { createEnrichmentDeps, haikuSkipReason } from '../../services/enrichment';
import { collectSources } from '../../services/enrichment/sources';
import { generateDraft, isDraftSuccess, type DraftResult } from '../../services/enrichment/draft';
import { estimateCallCostUsd, PRICING_CHECKED_ON } from '../../services/enrichment/pricing';
import { loadTopicIds } from '../../services/enrichment/topics';
import type { Draft } from '../../services/enrichment/haiku/schema';
import type { SourceBundle } from '../../services/enrichment/types';
import { normalizeWord } from '../../services/wordTranslationService';
import { readArg } from './args';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);

function describeSources(b: SourceBundle): string[] {
  const fd = b.freeDictionary;
  return [
    `wiktionary    : ${b.wiktionaryRows.length} row(s)${b.lemmaRows.length ? `, ${b.lemmaRows.length} row(s) of lemma "${b.expectedLemma}"` : ''}${b.sourceErrors.wiktionary ? `  ERROR ${b.sourceErrors.wiktionary}` : ''}`,
    `free dict.    : ${fd.status}${fd.status === 'found' ? ` (${fd.entry.senses.length} senses)` : ''}${fd.status === 'error' ? `  ${b.sourceErrors.free_dictionary}` : ''}`,
    `frequency     : ${b.frequency ? `zipf ${b.frequency.zipf}, rank ${b.frequency.rank}` : 'none'}`,
    `datamuse      : ${b.datamuse ? `${b.datamuse.synonyms.length} synonym(s), ${b.datamuse.antonyms.length} antonym(s)${b.datamuse.degraded ? ' (degraded)' : ''}` : 'none'}`,
    `expectedLemma : ${b.expectedLemma ?? '-'}   formLemmas: [${b.formLemmas.join(', ')}]   variantTargets: [${b.variantTargets.join(', ')}]${b.strayRows ? `   stray rows tolerated: ${b.strayRows}` : ''}`,
    `flags         : onlyFormRows=${b.flags.onlyFormRows}  onlyVariantRows=${b.flags.onlyVariantRows}  onlyProperNounRows=${b.flags.onlyProperNounRows}  noSourceRecognizesWord=${b.flags.noSourceRecognizesWord}`,
  ];
}

function describeDraft(d: Draft): string[] {
  const out: string[] = [];
  out.push(`headword ${d.headword}  lemma ${d.lemma}  pos [${d.pos.join(', ')}]  cefr ${d.cefr_level ?? '-'}  countable ${d.is_countable ?? '-'}  transitive ${d.is_transitive ?? '-'}`);
  out.push(`is_english_word ${d.is_english_word}  is_proper_noun ${d.is_proper_noun}  variant_of ${d.variant_of ?? '-'}`);
  out.push(`topics [${d.topics.join(', ')}]`);
  d.senses.forEach((s, i) => {
    out.push('');
    out.push(`  sense ${i + 1} [${s.pos}] ${s.definition_en}`);
    out.push(`    nghĩa (${s.meanings_vi.length}): ${s.meanings_vi.join(' · ')}`);
    const meta = [s.register && `register ${s.register}`, s.domain && `domain ${s.domain}`, s.region && `region ${s.region}`].filter(Boolean);
    if (meta.length) out.push(`    ${meta.join(', ')}`);
    if (s.grammar_note) out.push(`    ngữ pháp: ${s.grammar_note}`);
    if (s.usage_note) out.push(`    lưu ý: ${s.usage_note}`);
    s.examples.forEach((e) => out.push(`    ví dụ: ${e.example_en}\n           ${e.example_vi}`));
    if (s.synonyms.length) out.push(`    đồng nghĩa: ${s.synonyms.join(', ')}`);
    if (s.antonyms.length) out.push(`    trái nghĩa: ${s.antonyms.join(', ')}`);
  });
  if (d.idioms.length) out.push('', `  idioms: ${d.idioms.map((x) => `${x.idiom_text} = ${x.definition_vi}`).join(' | ')}`);
  if (d.phrasal_verbs.length) out.push(`  phrasal verbs: ${d.phrasal_verbs.map((x) => `${x.phrasal_verb} = ${x.definition_vi}`).join(' | ')}`);
  if (d.collocations.length) out.push(`  collocations: ${d.collocations.map((x) => x.collocation).join(' | ')}`);
  if (d.notes_for_review.length) out.push('', '  ghi chú để duyệt:', ...d.notes_for_review.map((n) => `   - ${n}`));
  return out;
}

async function main(): Promise<number> {
  const raw = readArg(argv, 'word');
  if (!raw) {
    console.error('usage: npm run enrich:draft -- --word <word> [--force] [--json]');
    return 2;
  }
  const cleaned = normalizeWord(raw);
  if (!cleaned.isValid) {
    console.error(`invalid word: ${cleaned.reason}`);
    return 2;
  }
  const word = cleaned.normalized;
  const json = flag('json');
  const log = (...lines: string[]) => {
    if (!json) console.log(lines.join('\n'));
  };

  const started = Date.now();
  await loadTopicIds(pool); // throws topics_not_seeded with the missing names
  const deps = createEnrichmentDeps({ tolerateFreeDictionaryError: true });

  const bundle = await collectSources(word, deps.sources);
  log(`word: ${word}   model: ${lookupConfig.anthropic.modelEnrich}`, '', '── nguồn (S1) ──', ...describeSources(bundle), `thời gian: ${Object.entries(bundle.timingsMs).map(([k, v]) => `${k} ${v} ms`).join(', ')}`);

  const skip = haikuSkipReason(bundle);
  if (skip && !flag('force')) {
    log('', `Không gọi Haiku: ${skip} (job thật cũng không gọi). Dùng --force để vẫn gọi.`);
    if (json) console.log(JSON.stringify({ word, flags: bundle.flags, expectedLemma: bundle.expectedLemma, skipped: skip }, null, 2));
    return 0;
  }

  const result: DraftResult = await generateDraft(bundle, { haiku: deps.haiku });
  const u = result.usage;
  const cost = result.model ? estimateCallCostUsd(result.model, u) : null;
  const usageLine = `token: input ${u.inputTokens} (cache ghi ${u.cacheCreationInputTokens}, cache đọc ${u.cacheReadInputTokens}), output ${u.outputTokens}, ${u.calls} lần gọi` +
    `   chi phí ước tính: ${cost === null ? 'n/a' : `$${cost.toFixed(5)}`} (bảng giá nhập tay ngày ${PRICING_CHECKED_ON}, phải xác minh lại)`;

  if (json) {
    console.log(JSON.stringify({ word, model: result.model, flags: bundle.flags, expectedLemma: bundle.expectedLemma, usage: u, costUsd: cost, ms: { total: Date.now() - started, sources: bundle.timingsMs, haiku: result.callMs }, result }, null, 2));
    return isDraftSuccess(result) ? 0 : 1;
  }

  log('', '── Haiku (S3) ──', usageLine, `thời gian: ${result.callMs.map((m) => `${m} ms`).join(' + ')}   tổng ${Date.now() - started} ms`);
  if (isDraftSuccess(result)) {
    log('', '── bản nháp ──', ...describeDraft(result.draft), '', '── kiểm tra (S4) ──', result.repaired ? `ĐÃ SỬA sau 1 lần thử lại. Lỗi lần đầu:\n${result.firstIssues.map((i) => `   - ${i.path}: ${i.message}`).join('\n')}` : 'đạt ngay lần đầu', 'kết quả: OK');
    return 0;
  }
  log('', '── kiểm tra (S4) ──', 'kết quả: invalid_output', ...result.details.map((i) => `   - ${i.path}: ${i.message}`));
  return 1;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('enrich:draft failed:', (err as Error)?.message ?? err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
