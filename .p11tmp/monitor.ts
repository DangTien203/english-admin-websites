/**
 * Phase 3 monitor: node .p11tmp/monitor.ts <worker-log> <estimateUsdPerWord> [invalidStopFraction=0.08]
 * Reads the LAST run of .oxford-seed.local.json (the batch just sent) and prints one JSON line plus a verdict:
 *   STOP if invalid_output > fraction of the batch, or (>=100 finished and invalid/finished > 12%), or the running average cost per
 *   Haiku job > 2 x the estimate (>=100 finished), or more than 3 consecutive rate-limit / budget events.
 */
import 'dotenv/config';
import fs from 'node:fs';
import pool from '../config/db';
import { readState } from '../services/enrichment/oxford/state';
import { costFromTotals } from '../services/enrichment/oxford/plan';

(async () => {
  const [logFile, estimateArg, fractionArg] = process.argv.slice(2);
  const estimate = Number(estimateArg);
  const fraction = Number(fractionArg ?? '0.08');
  const runs = readState().runs;
  const run = runs[runs.length - 1];
  const N = run.words.length;
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (word) word, status, reason, input_tokens, output_tokens FROM word_enrichment_jobs
      WHERE word = ANY($1::text[]) AND created_at >= $2::timestamptz - interval '1 minute' ORDER BY word, created_at DESC`,
    [run.words, run.startedAt]
  );
  const by: Record<string, number> = {};
  for (const r of rows) by[`${r.status}/${r.reason ?? '-'}`] = (by[`${r.status}/${r.reason ?? '-'}`] ?? 0) + 1;
  const active = rows.filter((r) => r.status === 'queued' || r.status === 'running').length;
  const done = rows.length - active;
  const invalid = rows.filter((r) => r.status === 'failed' && r.reason === 'invalid_output').length;
  const transient = rows.filter((r) => r.reason === 'budget' || r.reason === 'upstream_error' || r.reason === 'dead_letter' || r.reason === 'config_error').length;
  const withTokens = rows.filter((r) => Number(r.input_tokens) > 0);
  const inp = withTokens.reduce((s, r) => s + Number(r.input_tokens), 0);
  const out = withTokens.reduce((s, r) => s + Number(r.output_tokens), 0);
  const total = costFromTotals(run.model, withTokens.length, inp, out);
  const avgCost = total !== null && withTokens.length > 0 ? total / withTokens.length : null;

  // rate limits / budget in the worker log: consecutive events with no success in between
  let consecutive = 0;
  let maxConsecutive = 0;
  let budgetEvents = 0;
  let rateLines = 0;
  if (logFile && fs.existsSync(logFile)) {
    for (const raw of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
      const at = raw.indexOf('{');
      if (at < 0) continue;
      let l: any;
      try { l = JSON.parse(raw.slice(at)); } catch { continue; }
      if (l.evt === 'upstream_budget_exceeded') { budgetEvents++; consecutive++; maxConsecutive = Math.max(maxConsecutive, consecutive); continue; }
      const text = JSON.stringify(l);
      if ((l.evt === 'enrich_retry' || l.evt === 'enrich_retry_after_wait' || l.evt === 'upstream_config_error' || (l.evt === 'enrich' && l.status === 'failed' && l.reason === 'upstream_error')) && /429|rate.?limit|too many requests|overloaded|529|budget|spend/i.test(text)) {
        rateLines++;
        consecutive++;
        maxConsecutive = Math.max(maxConsecutive, consecutive);
      } else if (l.evt === 'enrich' && l.status === 'succeeded') consecutive = 0;
    }
  }

  const reasons: string[] = [];
  if (invalid > fraction * N) reasons.push(`invalid_output ${invalid} > ${(fraction * 100).toFixed(0)}% of ${N} (${Math.floor(fraction * N)})`);
  if (done >= 100 && invalid / done > 0.12) reasons.push(`invalid_output ${((invalid * 100) / done).toFixed(1)}% of the ${done} finished (> 12%)`);
  if (done >= 100 && avgCost !== null && avgCost > 2 * estimate) reasons.push(`average cost per Haiku job $${avgCost.toFixed(5)} > 2 x estimate $${estimate}`);
  if (maxConsecutive > 3) reasons.push(`${maxConsecutive} consecutive rate-limit / budget events`);
  if (budgetEvents > 0) reasons.push(`${budgetEvents} budget event(s)`);

  const q = await pool.query(`SELECT state, count(*)::int n FROM pgboss.job WHERE name = 'dictionary.enrich_word' AND state IN ('created','retry','active') GROUP BY 1`);
  console.log(
    JSON.stringify({ batch: N, done, active, invalid, invalidPct: N ? +((invalid * 100) / N).toFixed(1) : 0, transient, by, avgCostPerHaikuJob: avgCost === null ? null : +avgCost.toFixed(5), estimate, maxConsecutiveRateLimit: maxConsecutive, rateLines, budgetEvents, pgboss: q.rows })
  );
  console.log(reasons.length ? `VERDICT: STOP — ${reasons.join('; ')}` : `VERDICT: OK${active === 0 ? ' — batch finished' : ''}`);
  await pool.end();
})();
