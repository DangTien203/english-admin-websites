/**
 * Acceptance run of the word lookup (P7b): 30 words in 7 groups against a RUNNING server, then the background jobs they start.
 * Prints a pass / fail / skipped table and writes docs/lookup-acceptance-report.md. STAGING ONLY (the database of .env).
 *
 *   npm run acceptance:lookup -- --staging --base-url http://localhost:3000 [--only A,B,C] [--wait-minutes 10]
 *   npm run acceptance:lookup -- --staging --cleanup [--dry-run]
 *
 * Needs: the server running with ENRICHMENT_ENABLED=true (the same process works the queue when ENRICHMENT_WORKER_ENABLED=true),
 * and `npm run seed:lookup-test -- --staging` run before (it writes .acceptance.local.json: git-ignored, holds the test user's
 * password). The server and this script must use the same .env, and the staging database should be QUIET while it runs: groups A
 * and B are judged by "the Google character counter did not move".
 *
 * --cleanup deletes only what THIS tool's runs created: entries whose admin_note starts with '[auto]' and whose headword is one of
 * the words that were run, created since the first not-yet-cleaned run started (.acceptance.state.json), and the job rows of those
 * words since then. Entries the seed made for groups A and B (older than the run) stay. It asks you to type the database name.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { estimateCallCostUsd } from '../../services/enrichment/pricing';
import { getRefDb } from '../../services/lookup/refDb';
import { readArg } from '../enrichment/args';
import {
  clearState,
  collectWordFacts,
  confirmDatabaseName,
  dbLabel,
  describeDatabase,
  readCounter,
  readCredentials,
  readState,
  repoPath,
  utcMonth,
  writeState,
  type AcceptanceCredentials,
  type DatabaseIdentity,
} from './db';
import {
  combine,
  evaluateFast,
  evaluateFormRow,
  evaluateGoogleChars,
  evaluateJob,
  evaluateLatency,
  isSourceOutage,
  reclassifyForSource,
  summarizeFast,
  TERMINAL_JOB_STATUSES,
  UNEVALUABLE_LABEL,
  type EntryObservation,
  type FastObservation,
  type FastSummary,
  type JobObservation,
  type JobRowObservation,
  type LatencyResult,
  type Verdict,
} from './evaluate';
import { buildReport, verdictLabel, fmtMs, type BreakerWait, type ProbeEntry, type RunSummary, type WordCheckEntry, type WordResult } from './report';
import { breakerLikelyOpen, breakerWaitMs, classifyWordCheck, describeProbe, fdFailureEvidence, probeFreeDictionary, rerunCommand, sourceHealthFor, type ProbeResult, type WordCheck } from './source';
import { checkPrecondition, GROUP_ORDER, GROUP_TITLES, GROUP_WORDS, FALLBACK_WORDS, jobExpectation, MISS_GROUPS, planWords, type Group, type PlannedWord, type SkippedWord, type WordFacts } from './words';

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function login(baseUrl: string, creds: AcceptanceCredentials): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
    signal: AbortSignal.timeout(30_000),
  });
  const body: any = await res.json().catch(() => null);
  if (res.status === 429) throw new Error('Đăng nhập bị giới hạn (5 lần / 15 phút / IP). Đợi rồi chạy lại.');
  if (!res.ok || !body?.data?.access_token) throw new Error(`Đăng nhập thất bại: HTTP ${res.status} ${body?.error?.code ?? ''}. Chạy lại seed:lookup-test để đặt lại mật khẩu thử.`);
  return String(body.data.access_token);
}

async function lookupOnce(baseUrl: string, token: string, creds: AcceptanceCredentials, word: string): Promise<FastObservation> {
  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl}/api/v1/ebooks/${creds.ebook_id}/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ word, paragraph_id: creds.paragraph_id }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const ms = performance.now() - started;
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    (body ??= {}).__retryAfter = res.headers.get('retry-after');
    return { status: res.status, ms, body };
  } catch (err: any) {
    return { status: 0, ms: performance.now() - started, body: { error: { code: `NETWORK:${err?.name ?? 'Error'}` } } };
  }
}

/** Sends one lookup; on 429 waits Retry-After once and repeats (the retry's time is the one reported). */
async function lookup(baseUrl: string, token: string, creds: AcceptanceCredentials, word: string): Promise<FastObservation> {
  const first = await lookupOnce(baseUrl, token, creds, word);
  if (first.status !== 429) return first;
  const wait = Math.min(65, Math.max(1, Number(first.body?.__retryAfter) || 5));
  console.log(`      429 LOOKUP_RATE_LIMITED, chờ ${wait} s rồi gửi lại`);
  await sleep(wait * 1000 + 500);
  const second = await lookupOnce(baseUrl, token, creds, word);
  return { ...second, retriedAfter429: true };
}

// ── database observations ───────────────────────────────────────────────────────────────────────────────────────────

async function observeJobs(words: string[], since: string): Promise<Map<string, JobRowObservation[]>> {
  const { rows } = await pool.query(
    `SELECT id, word, status, reason, entry_id, attempts, input_tokens, output_tokens
       FROM word_enrichment_jobs WHERE word = ANY($1::text[]) AND created_at >= $2::timestamptz ORDER BY created_at DESC`,
    [words, since]
  );
  const out = new Map<string, JobRowObservation[]>();
  for (const w of words) out.set(w, []);
  for (const r of rows) {
    out.get(r.word)!.push({
      id: r.id,
      status: r.status,
      reason: r.reason,
      entryId: r.entry_id,
      attempts: r.attempts,
      inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
      outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
    });
  }
  return out;
}

async function observeEntry(word: string, since: string): Promise<EntryObservation | null> {
  const { rows } = await pool.query(
    `SELECT e.id, e.headword, e.lemma, e.published, e.pos, e.meaning_vi, e.admin_note
       FROM dictionary_entries e
      WHERE (lower(e.headword) = $1 OR lower(e.lemma) = $1) AND e.admin_note LIKE '[auto]%' AND e.created_at >= $2::timestamptz
      ORDER BY e.created_at DESC LIMIT 1`,
    [word, since]
  );
  if (rows.length === 0) return null;
  const e = rows[0];
  const senses = await pool.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE coalesce(trim(definition_en), '') <> '' AND coalesce(trim(definition_vi), '') <> '')::int AS complete FROM entry_senses WHERE entry_id = $1`,
    [e.id]
  );
  const examples = await pool.query(
    `SELECT count(*)::int AS n FROM sense_examples x JOIN entry_senses s ON s.id = x.sense_id
      WHERE s.entry_id = $1 AND coalesce(trim(x.example_en), '') <> '' AND coalesce(trim(x.example_vi), '') <> ''`,
    [e.id]
  );
  return {
    id: e.id,
    headword: e.headword,
    lemma: e.lemma,
    published: Boolean(e.published),
    pos: e.pos ?? [],
    meaningVi: e.meaning_vi,
    adminNote: e.admin_note,
    senseCount: senses.rows[0].n,
    completeSenseCount: senses.rows[0].complete,
    exampleCount: examples.rows[0].n,
  };
}

async function headwordEntryExists(word: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM dictionary_entries WHERE lower(headword) = $1 LIMIT 1`, [word]);
  return rows.length > 0;
}

async function formRowExists(word: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM word_forms WHERE lower(form_value) = $1 LIMIT 1`, [word]);
  return rows.length > 0;
}


// ── the run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function dbNow(): Promise<string> {
  const { rows } = await pool.query(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`);
  return rows[0].t;
}

async function runAcceptance(): Promise<number> {
  const baseUrl = (readArg(argv, 'base-url') ?? 'http://localhost:3000').replace(/\/+$/, '');
  const onlyArg = readArg(argv, 'only');
  const groups = (onlyArg ? onlyArg.split(',').map((g) => g.trim().toUpperCase()) : [...GROUP_ORDER]) as Group[];
  for (const g of groups) if (!GROUP_ORDER.includes(g)) throw new Error(`--only: nhóm "${g}" không có (A, B, C, D, E, F, H)`);
  const waitMinutes = Number(readArg(argv, 'wait-minutes') ?? '10');
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0) throw new Error('--wait-minutes phải là số không âm');

  const identity = describeDatabase(pool);
  const creds = readCredentials();
  if (creds.database && creds.database !== identity.database) {
    console.error(`Từ chối: ${'.acceptance.local.json'} được tạo cho database "${creds.database}" nhưng .env đang trỏ tới "${identity.database}". Chạy lại seed:lookup-test.`);
    return 2;
  }
  console.log(`DATABASE: ${dbLabel(identity)}   máy chủ: ${baseUrl}   nhóm: ${groups.join(',')}`);
  console.log(`ENRICHMENT_PUBLISH_POLICY=${lookupConfig.flags.enrichmentPublishPolicy}  LOOKUP_TOTAL_DEADLINE_MS=${lookupConfig.lookup.totalDeadlineMs}  LOOKUP_MISS_RATE_LIMIT_PER_MIN=${lookupConfig.lookup.missRateLimitPerMin}`);
  if (!lookupConfig.flags.enrichmentEnabled) console.warn('CẢNH BÁO: ENRICHMENT_ENABLED=false trong .env: nhóm C, D, E, H sẽ không có job (enrichment.status=disabled).');

  const token = await login(baseUrl, creds);
  const startedAt = await dbNow();
  const started = Date.now();
  const refDb = getRefDb();

  // preconditions
  const factKey = (g: Group, w: string) => `${g}:${w}`;
  const facts = new Map<string, WordFacts>();
  for (const g of groups) {
    for (const w of [...GROUP_WORDS[g], ...(FALLBACK_WORDS[g] ?? [])]) facts.set(factKey(g, w), await collectWordFacts(pool, refDb, g, w));
  }
  const plan = planWords(groups, (g, w) => checkPrecondition(g, w, facts.get(factKey(g, w))!));
  console.log(`\nChạy ${plan.run.length} từ, bỏ qua ${plan.skipped.length} (tiền đề sai).`);
  for (const k of plan.skipped) console.log(`  bỏ qua ${k.group}:${k.word} - ${k.reason}`);

  const anthropicBefore = { input: await readCounter(pool, 'anthropic', 'input_tokens', utcMonth()), output: await readCounter(pool, 'anthropic', 'output_tokens', utcMonth()) };

  // ── fast path ──
  const observations = new Map<string, FastObservation>();
  const recentMisses: number[] = [];
  const missLimit = Math.max(1, lookupConfig.lookup.missRateLimitPerMin - 2);
  let charsBefore: number | null = null;
  let charsAfter: number | null = null;
  const hasAB = plan.run.some((p) => p.group === 'A' || p.group === 'B');

  // ── Free Dictionary: probe it directly before anything is looked up ──
  const usesFd = plan.run.some((p) => MISS_GROUPS.has(p.group));
  const probes: ProbeEntry[] = [];
  const waits: BreakerWait[] = [];
  const probe = async (label: string): Promise<ProbeResult> => {
    const result = await probeFreeDictionary(lookupConfig.freeDictionary.baseUrl, lookupConfig.lookup.upstreamTimeoutMs);
    probes.push({ label, result });
    console.log(`  thăm dò Free Dictionary (${label}): ${result.healthy ? 'KHỎE' : 'KHÔNG KHỎE'} - ${describeProbe(result)}`);
    return result;
  };
  if (usesFd) {
    console.log('\n── thăm dò Free Dictionary ──');
    const first = await probe('trước khi chạy');
    if (!first.healthy) console.warn(`  CẢNH BÁO: Free Dictionary không khỏe. Nhóm H và các ca 503 của nhóm E, F sẽ được ghi là "${UNEVALUABLE_LABEL}", không phải "không đạt".`);
  }
  // Free Dictionary is not answering: group H cannot be judged, and running it would only use up its words (each run leaves an entry
  // behind) and ask more of a service that is struggling. The words are listed as "not judged" with the command that runs them later.
  const deferred: SkippedWord[] = [];
  if (probes.length > 0 && !probes[0].result.healthy) {
    for (const p of plan.run.filter((x) => x.group === 'H')) {
      deferred.push({ group: 'H', word: p.word, reason: `${UNEVALUABLE_LABEL}: chưa chạy vì Free Dictionary không trả lời lúc bắt đầu (từ giữ nguyên cho lần chạy lại)` });
    }
    plan.run = plan.run.filter((x) => x.group !== 'H');
    if (deferred.length > 0) console.warn(`  Không chạy nhóm H (${deferred.length} từ): ${UNEVALUABLE_LABEL}. Chạy lại khi Free Dictionary khỏe.`);
  }
  // One entry per lookup that reached Free Dictionary: did it fail? (the end of this list is how the circuit breaker of the server is guessed)
  const fdHistory: boolean[] = [];
  let lastEvidenceAt = 0;
  let previousGroup: Group | null = null;
  const contextOf = new Map<string, { probeHealthy: boolean | null; breakerOpen: boolean }>();

  console.log('\n── đường nhanh ──');
  for (const planned of plan.run) {
    // The group before left the circuit breaker of Free Dictionary open? Let it close (UPSTREAM_BREAKER_RESET_MS) before the next group,
    // and look again: a group judged while the breaker is open measures the breaker, not the word.
    if (previousGroup !== null && previousGroup !== planned.group && MISS_GROUPS.has(planned.group) && breakerLikelyOpen(fdHistory, lookupConfig.breaker.failureThreshold)) {
      const waitMs = breakerWaitMs(lastEvidenceAt, Date.now(), lookupConfig.breaker.resetMs);
      console.log(`  Free Dictionary có vẻ đang bị ngắt mạch sau nhóm ${previousGroup}: chờ ${Math.round(waitMs / 1000)} s (UPSTREAM_BREAKER_RESET_MS=${lookupConfig.breaker.resetMs}) trước nhóm ${planned.group}`);
      await sleep(waitMs);
      waits.push({ before: planned.group, after: previousGroup, waitedMs: waitMs });
      await probe(`sau nhóm ${previousGroup}`);
      fdHistory.length = 0; // the breaker has had its time: the next lookup is its trial
    }
    previousGroup = planned.group;
    contextOf.set(planned.word, { probeHealthy: probes.length > 0 ? probes[probes.length - 1].result.healthy : null, breakerOpen: breakerLikelyOpen(fdHistory, lookupConfig.breaker.failureThreshold) });

    if (charsBefore === null && hasAB && (planned.group === 'A' || planned.group === 'B')) charsBefore = await readCounter(pool, 'google_translate', 'chars', utcMonth());
    if (MISS_GROUPS.has(planned.group)) {
      // stay under the per-user miss limit (the server counts a rolling minute)
      for (;;) {
        const now = Date.now();
        while (recentMisses.length > 0 && now - recentMisses[0] >= 60_000) recentMisses.shift();
        if (recentMisses.length < missLimit) break;
        await sleep(Math.max(250, 60_000 - (now - recentMisses[0]) + 250));
      }
      recentMisses.push(Date.now());
    }
    const obs = await lookup(baseUrl, token, creds, planned.word);
    observations.set(planned.word, obs);
    if (MISS_GROUPS.has(planned.group)) {
      const failed = fdFailureEvidence(planned.group, obs);
      fdHistory.push(failed);
      if (failed) lastEvidenceAt = Date.now();
    }
    const f = summarizeFast(obs);
    console.log(`  ${planned.group} ${planned.word.padEnd(14)} HTTP ${String(f.status).padEnd(3)} ${String(f.source ?? f.errorCode ?? '-').padEnd(12)} ${String(Math.round(f.ms)).padStart(5)} ms  enrichment=${f.enrichmentStatus ?? '-'}`);
    const lastAB = planned === [...plan.run].reverse().find((p) => p.group === 'A' || p.group === 'B');
    if (lastAB && hasAB) {
      await sleep(1500); // the background inserts of the last lookup (word_lookups, word_forms) must have landed
      charsAfter = await readCounter(pool, 'google_translate', 'chars', utcMonth());
    }
  }

  // ── Free Dictionary once more, now that the fast path is over (decides the words that ran while it was struggling) ──
  const endProbe = usesFd ? await probe('sau lượt tra') : null;

  // ── group H words that came back with nothing from Free Dictionary: does it have the word now? ──
  const wordCheck = new Map<string, WordCheck>();
  const wordChecks: WordCheckEntry[] = [];
  for (const p of plan.run.filter((x) => x.group === 'H')) {
    const obs = observations.get(p.word)!;
    if (isSourceOutage(obs) || !fdFailureEvidence('H', obs)) continue; // answered with senses, or a 503 (unevaluable without any look)
    const r = await probeFreeDictionary(lookupConfig.freeDictionary.baseUrl, lookupConfig.lookup.upstreamTimeoutMs, {}, p.word, 1);
    const outcome = classifyWordCheck(r.attempts[0]);
    wordCheck.set(p.word, outcome);
    wordChecks.push({ word: p.word, outcome });
    console.log(`  hỏi lại Free Dictionary về "${p.word}": ${outcome === 'has' ? 'có dữ liệu' : outcome === 'absent' ? '404 (nguồn không có từ này)' : 'không trả lời'}`);
  }

  // ── word_forms rows of group B (written in the background) ──
  const formPresence = new Map<string, boolean>();
  for (const p of plan.run.filter((x) => x.group === 'B')) {
    const deadline = Date.now() + 20_000;
    let present = await formRowExists(p.word);
    while (!present && Date.now() < deadline) {
      await sleep(1000);
      present = await formRowExists(p.word);
    }
    formPresence.set(p.word, present);
  }

  // ── background jobs ──
  console.log(`\n── job nền (chờ tối đa ${waitMinutes} phút) ──`);
  const words = plan.run.map((p) => p.word);
  const needsJob = new Set(plan.run.filter((p) => ['succeeded', 'rejected_proper_noun'].includes(jobExpectation(p.group, p.word))).map((p) => p.word));
  const deadline = Date.now() + waitMinutes * 60_000;
  let jobsByWord = await observeJobs(words, startedAt);
  let timedOut = false;
  for (;;) {
    const pending = [...jobsByWord.entries()].filter(([w, rows]) => rows.length > 0 && !TERMINAL_JOB_STATUSES.includes(rows[0].status));
    const missing = [...needsJob].filter((w) => (jobsByWord.get(w) ?? []).length === 0 && observations.get(w)?.body?.data?.enrichment?.status === 'queued');
    if (pending.length === 0 && missing.length === 0) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    process.stdout.write(`  còn ${pending.length + missing.length} job chưa xong: ${[...pending.map(([w]) => w), ...missing].join(', ')}\n`);
    await sleep(5000);
    jobsByWord = await observeJobs(words, startedAt);
  }
  // a short grace so that late rows (jobs that appear after the response) are seen by the "no job" checks
  await sleep(2000);
  jobsByWord = await observeJobs(words, startedAt);

  // ── evaluation ──
  const results: WordResult[] = [];
  for (const planned of plan.run) {
    const obs = observations.get(planned.word)!;
    const rows = jobsByWord.get(planned.word) ?? [];
    const entry = await observeEntry(planned.word, startedAt);
    const job: JobObservation = {
      rows,
      entry,
      headwordEntryExists: await headwordEntryExists(planned.word),
      timedOut: timedOut && rows.length > 0 && !TERMINAL_JOB_STATUSES.includes(rows[0].status),
    };
    const at = contextOf.get(planned.word) ?? { probeHealthy: null, breakerOpen: false };
    const fastV = reclassifyForSource(planned.group, obs, evaluateFast(planned.group, planned.word, obs), sourceHealthFor(at, endProbe ? endProbe.healthy : null, wordCheck.get(planned.word) ?? null));
    const formV = planned.group === 'B' ? evaluateFormRow(planned.word, formPresence.get(planned.word) ?? false) : undefined;
    const jobV = evaluateJob(planned.group, planned.word, job, lookupConfig.flags.enrichmentPublishPolicy);
    results.push({
      planned,
      fast: obs,
      summary: summarizeFast(obs),
      formPresent: planned.group === 'B' ? (formPresence.get(planned.word) ?? false) : null,
      job,
      verdicts: { fast: fastV, form: formV, job: jobV },
      verdict: combine(fastV, ...(formV ? [formV] : []), jobV),
    });
  }

  const unevaluableGroups = new Set<Group>([...results.filter((r) => r.verdict.verdict === 'unevaluable').map((r) => r.planned.group), ...deferred.map((d) => d.group)]);
  const rerun = unevaluableGroups.size > 0 ? rerunCommand(unevaluableGroups, baseUrl) : null;
  const chars = charsBefore !== null && charsAfter !== null ? { before: charsBefore, after: charsAfter, verdict: evaluateGoogleChars(charsBefore, charsAfter) } : undefined;
  const latency = evaluateLatency(results.map((r) => ({ group: r.planned.group, ms: r.summary!.ms })), lookupConfig.lookup.totalDeadlineMs);

  // tokens and cost
  const anthropicAfter = { input: await readCounter(pool, 'anthropic', 'input_tokens', utcMonth()), output: await readCounter(pool, 'anthropic', 'output_tokens', utcMonth()) };
  const model = lookupConfig.anthropic.modelEnrich;
  let jobInput = 0;
  let jobOutput = 0;
  let calls = 0;
  let cost: number | null = 0;
  const SYSTEM_PROMPT_TOKENS = 7859;
  for (const r of results) {
    const row = r.job!.rows.find((x) => x.inputTokens !== null && x.inputTokens > 0);
    if (!row) continue;
    calls++;
    jobInput += row.inputTokens!;
    jobOutput += row.outputTokens ?? 0;
    const cached = Math.min(SYSTEM_PROMPT_TOKENS, row.inputTokens!);
    const c = estimateCallCostUsd(model, { inputTokens: row.inputTokens! - cached, outputTokens: row.outputTokens ?? 0, cacheReadInputTokens: cached });
    cost = c === null || cost === null ? null : cost + c;
  }

  // what --cleanup needs
  const previous = readState();
  writeState({
    startedAt: previous && previous.database === identity.database ? previous.startedAt : startedAt,
    database: identity.database,
    words: [...new Set([...(previous?.words ?? []), ...words])],
  });

  const summary: RunSummary = {
    startedAtDb: startedAt,
    identity,
    baseUrl,
    groups,
    results,
    skipped: plan.skipped,
    chars,
    latency,
    tokens: { anthropicBefore, anthropicAfter, jobs: { input: jobInput, output: jobOutput, calls, costUsd: cost } },
    waitMinutes,
    jobWaitTimedOut: timedOut,
    elapsedSec: (Date.now() - started) / 1000,
    probes,
    waits,
    deferred,
    wordChecks,
    breakerResetMs: lookupConfig.breaker.resetMs,
    settings: { publishPolicy: lookupConfig.flags.enrichmentPublishPolicy, totalDeadlineMs: lookupConfig.lookup.totalDeadlineMs, fastTranslator: lookupConfig.lookup.fastTranslator },
    rerun,
  };
  const report = buildReport(summary);
  const reportPath = repoPath(readArg(argv, 'report') ?? path.join('docs', 'lookup-acceptance-report.md'));
  fs.writeFileSync(reportPath, report);

  // ── console table ──
  console.log('\n── KẾT QUẢ ──');
  console.table(
    results.map((r) => ({
      nhóm: r.planned.group,
      từ: r.planned.word,
      HTTP: r.summary!.status,
      source: r.summary!.source ?? r.summary!.errorCode ?? '-',
      ms: Math.round(r.summary!.ms),
      job: r.job!.rows[0] ? `${r.job!.rows[0].status}${r.job!.rows[0].reason ? '/' + r.job!.rows[0].reason : ''}` : '-',
      'kết quả': verdictLabel(r.verdict),
      'lý do': r.verdict.reasons.join(' | ').slice(0, 110),
    }))
  );
  for (const k of plan.skipped) console.log(`  BỎ QUA ${k.group}:${k.word} - ${k.reason}`);
  if (chars) console.log(`Google chars (A+B): ${chars.before} -> ${chars.after}  ${verdictLabel(chars.verdict)}`);
  console.log(`p50 ${fmtMs(latency.p50)} ms, p95 ${fmtMs(latency.p95)} ms (giới hạn ${latency.limitMs} ms)  ${verdictLabel(latency)}`);
  const pass = results.filter((r) => r.verdict.verdict === 'pass').length;
  const fail = results.filter((r) => r.verdict.verdict === 'fail').length;
  const unevaluableCount = results.filter((r) => r.verdict.verdict === 'unevaluable').length + deferred.length;
  console.log(`\nĐẠT ${pass}  KHÔNG ĐẠT ${fail}  KHÔNG ĐÁNH GIÁ ĐƯỢC ${unevaluableCount}  BỎ QUA ${plan.skipped.length}   báo cáo: ${path.relative(process.cwd(), reportPath)}`);
  if (rerun) console.log(`Có ${unevaluableCount} từ không đánh giá được vì nguồn ngoài lỗi (không phải lỗi của mã). Chạy lại riêng khi Free Dictionary khỏe:\n  ${rerun}`);
  // 1 = something failed; 3 = nothing failed but the run did not reach a verdict on every word (so it must not be read as a pass)
  if (fail > 0 || chars?.verdict.verdict === 'fail' || latency.verdict === 'fail') return 1;
  return unevaluableCount > 0 ? 3 : 0;
}

// ── cleanup ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function cleanup(): Promise<number> {
  const identity = describeDatabase(pool);
  const state = readState();
  if (!state || state.words.length === 0) {
    console.error('Từ chối: không có lần chạy nào được ghi nhận (.acceptance.state.json). Để an toàn không xóa gì.');
    return 2;
  }
  if (state.database !== identity.database) {
    console.error(`Từ chối: lần chạy được ghi cho database "${state.database}" nhưng .env đang trỏ tới "${identity.database}".`);
    return 2;
  }

  const entries = (
    await pool.query(
      `SELECT id, headword, published, created_at FROM dictionary_entries
        WHERE admin_note LIKE '[auto]%' AND lower(headword) = ANY($1::text[]) AND created_at >= $2::timestamptz ORDER BY created_at`,
      [state.words, state.startedAt]
    )
  ).rows;
  const jobs = (await pool.query(`SELECT id, word, status FROM word_enrichment_jobs WHERE word = ANY($1::text[]) AND created_at >= $2::timestamptz ORDER BY created_at`, [state.words, state.startedAt])).rows;

  console.log(`Lần chạy bắt đầu ${state.startedAt} (đồng hồ DB). Sẽ xóa:`);
  console.log(`  ${entries.length} mục từ [auto]: ${entries.map((e) => `${e.headword}${e.published ? '(published)' : ''}`).join(', ') || '-'}`);
  console.log(`  ${jobs.length} hàng job: ${jobs.map((j) => `${j.word}/${j.status}`).join(', ') || '-'}`);
  console.log('  (mục từ cũ hơn lần chạy, kể cả các mục từ seed tạo cho nhóm A và B, không bị đụng tới)');

  if (has('--dry-run')) {
    console.log('--dry-run: không xóa gì.');
    return 0;
  }
  if (jobs.some((j) => j.status === 'queued' || j.status === 'running')) {
    console.error('Từ chối: còn job đang queued/running. Đợi chúng xong rồi chạy lại.');
    return 2;
  }
  if (!(await confirmDatabaseName(identity))) {
    console.error('Từ chối: tên database gõ lại không khớp. Không xóa gì.');
    return 2;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d1 = await client.query(`DELETE FROM dictionary_entries WHERE id = ANY($1::uuid[])`, [entries.map((e) => e.id)]);
    const d2 = await client.query(`DELETE FROM word_enrichment_jobs WHERE id = ANY($1::uuid[])`, [jobs.map((j) => j.id)]);
    await client.query('COMMIT');
    console.log(`Đã xóa ${d1.rowCount} mục từ (các bảng con xóa theo) và ${d2.rowCount} hàng job.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  clearState();
  return 0;
}

async function main(): Promise<number> {
  if (!has('--staging')) {
    console.error('Từ chối: thêm --staging để xác nhận đây là DB staging (DB dev duy nhất trong .env).');
    return 2;
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Từ chối: NODE_ENV=production.');
    return 2;
  }
  return has('--cleanup') ? cleanup() : runAcceptance();
}

main()
  .then(async (code) => {
    await pool.end().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`acceptance:lookup failed: [${err?.name ?? 'Error'}] ${err?.message ?? err}`);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
