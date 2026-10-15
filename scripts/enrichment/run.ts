/**
 * Runs the REAL enrichment pipeline (S0–S7) for one word, directly, without the queue.
 *
 *   npm run enrich:run -- --word serendipity [--dry-run] [--allow-auto]
 *
 * Prints every stage with its time, then the tokens, the estimated cost and the result.
 *   --dry-run     S0–S5 (Claude Haiku IS called, so it costs a few hundredths of a cent): prints the merged entry and
 *                 the table each row would go to, and writes NOTHING to the dictionary.
 *   without it    S6 writes to the database in .env, in one transaction. Refuses to run when ENRICHMENT_PUBLISH_POLICY=auto
 *                 (entries that are complete would be PUBLISHED at once) unless --allow-auto is given.
 * Does not touch word_enrichment_jobs and does not use pg-boss.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { countRows, type AssembledEntry } from '../../services/enrichment/assemble';
import { isDraftSuccess } from '../../services/enrichment/draft';
import { runPipeline, type PipelineReport, type StageEvent } from '../../services/enrichment/pipeline';
import { estimateCallCostUsd, PRICING_CHECKED_ON } from '../../services/enrichment/pricing';
import { createProductionDeps } from '../../services/enrichment/wiring';
import { normalizeWord } from '../../services/wordTranslationService';
import { readArg } from './args';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);

const fmt = (info?: Record<string, unknown>) =>
  info
    ? Object.entries(info)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
        .join('  ')
    : '';

function describeEntry(e: AssembledEntry): string[] {
  const out: string[] = [];
  out.push(`headword ${e.headword}  lemma ${e.lemma}  pos [${e.pos.join(', ')}]  cefr ${e.cefrLevel ?? '-'}  rank ${e.frequencyRank ?? '-'}  countable ${e.isCountable ?? '-'}  transitive ${e.isTransitive ?? '-'}`);
  out.push(`ipa_us ${e.ipaUs ?? '-'}  ipa_uk ${e.ipaUk ?? '-'}`);
  out.push(`audio_us ${e.audioUsUrl ?? '-'}`);
  out.push(`audio_uk ${e.audioUkUrl ?? '-'}`);
  out.push(`meaning_vi (${e.meaningVi.length} ký tự): ${e.meaningVi}`);
  out.push(`meaning_en: ${e.meaningEn ?? '-'}`);
  out.push(`example: ${e.exampleEn ?? '-'}  /  ${e.exampleVi ?? '-'}`);
  out.push(`topics [${e.tagNames.join(', ')}]   published=${e.published}   etymology: ${e.etymology ? e.etymology.slice(0, 90) + (e.etymology.length > 90 ? '…' : '') : '-'}`);
  e.senses.forEach((s) => {
    out.push(`  sense ${s.senseOrder} [${s.pos}] ${s.definitionEn}`);
    out.push(`     definition_vi: ${s.definitionVi}${s.register ? `   register ${s.register}` : ''}${s.domain ? `   domain ${s.domain}` : ''}`);
    if (s.synonyms.length) out.push(`     đồng nghĩa: ${s.synonyms.join(', ')}`);
    if (s.antonyms.length) out.push(`     trái nghĩa: ${s.antonyms.join(', ')}`);
  });
  if (e.forms.length) out.push(`word_forms: ${e.forms.map((f) => `${f.formValue} (${f.formType})`).join(', ')}`);
  if (e.aliases.length) out.push(`answer aliases: ${e.aliases.map((a) => a.answerText).join(', ')}`);
  if (e.idioms.length) out.push(`idioms: ${e.idioms.map((i) => i.idiomText).join(' | ')}`);
  if (e.phrasalVerbs.length) out.push(`phrasal verbs: ${e.phrasalVerbs.map((p) => p.phrasalVerb).join(' | ')}`);
  if (e.collocations.length) out.push(`collocations: ${e.collocations.map((c) => c.collocation).join(' | ')}`);
  out.push(`admin_note: ${e.adminNote}`);
  return out;
}

function printReport(report: PipelineReport, dryRun: boolean): void {
  const o = report.outcome;
  const usage = report.draft?.usage;
  if (usage) {
    const model = report.draft!.model;
    const cost = model ? estimateCallCostUsd(model, usage) : null;
    console.log(
      `\ntoken: input ${usage.inputTokens} (cache ghi ${usage.cacheCreationInputTokens}, cache đọc ${usage.cacheReadInputTokens}), output ${usage.outputTokens}, ${usage.calls} lần gọi` +
        `   chi phí ước tính: ${cost === null ? 'n/a' : `$${cost.toFixed(5)}`} (bảng giá nhập tay ngày ${PRICING_CHECKED_ON})`
    );
  } else {
    console.log('\ntoken: 0 (Haiku không được gọi)');
  }
  if (report.formLink) console.log(`dạng biến: "${report.formLink.form}" của "${report.formLink.lemma}"  form_type=${report.formLink.type ?? 'không xác định'}`);
  if (report.assembled) console.log('\n── mục từ đã gộp (S5) ──\n' + describeEntry(report.assembled).join('\n'));
  if (report.draft && !isDraftSuccess(report.draft)) console.log('\nbản nháp không đạt:\n' + report.draft.details.map((i) => `  - ${i.path}: ${i.message}`).join('\n'));

  const rows = report.rows ?? (report.assembled ? countRows(report.assembled) : undefined);
  if (rows) {
    console.log(`\n── ${dryRun ? 'sẽ ghi (dry-run, KHÔNG ghi DB)' : 'đã ghi'} ──`);
    console.table(Object.entries(rows).map(([table, n]) => ({ table, rows: n })));
  }
  console.log(`\nkết quả: status=${o.status}  reason=${o.reason ?? '-'}  entry_id=${o.entryId ?? '-'}  model=${o.model ?? '-'}`);
  console.log(`thời gian: ${Object.entries(o.stagesMs ?? {}).map(([k, v]) => `${k} ${v} ms`).join(', ')}`);
}

async function main(): Promise<number> {
  const raw = readArg(argv, 'word');
  if (!raw) {
    console.error('usage: npm run enrich:run -- --word <word> [--dry-run] [--allow-auto]');
    return 2;
  }
  const cleaned = normalizeWord(raw);
  if (!cleaned.isValid) {
    console.error(`invalid word: ${cleaned.reason}`);
    return 2;
  }
  const word = cleaned.normalized;
  const dryRun = flag('dry-run');
  const policy = lookupConfig.flags.enrichmentPublishPolicy;

  console.log(`word: ${word}   model: ${lookupConfig.anthropic.modelEnrich}   ENRICHMENT_PUBLISH_POLICY=${policy}   ${dryRun ? 'DRY-RUN' : 'GHI DB'}`);
  if (!dryRun && policy === 'auto' && !flag('allow-auto')) {
    console.error('Từ chối: ENRICHMENT_PUBLISH_POLICY=auto sẽ XUẤT BẢN ngay mục từ đủ tầng A. Đặt ENRICHMENT_PUBLISH_POLICY=review hoặc thêm --allow-auto.');
    return 2;
  }

  const deps = createProductionDeps();
  const job = { word, requestedBy: null, ebookId: null, jobRowId: `cli-${randomUUID()}`, attempt: 1 };
  const onStage = (e: StageEvent) => console.log(`${e.stage.padEnd(18)} ${String(e.ms).padStart(6)} ms   ${fmt(e.info)}`);

  const report = await runPipeline(job, deps, { dryRun, onStage });
  printReport(report, dryRun);
  return report.outcome.status === 'failed' ? 1 : 0;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`enrich:run failed: [${err?.name ?? 'Error'}] ${err?.message ?? err}`);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
