module.exports = [
  {
    file: 'scripts/loadtest/app-runner.ts',
    edits: [
      [
        `import app from '../../app';
import pool from '../../config/db';`,
        `import app from '../../app';
import pool from '../../config/db';
import { stopBoss } from '../../services/queue';`,
      ],
      [
        `    server.closeAllConnections();
    await pool.end().catch(() => undefined);`,
        `    server.closeAllConnections();
    await stopBoss(3000).catch(() => undefined); // only started when the scenario sends jobs (ENRICHMENT_ENABLED=true)
    await pool.end().catch(() => undefined);`,
      ],
    ],
  },
  {
    file: 'scripts/loadtest/lookup-burst.ts',
    edits: [
      [
        ` *   C  F6         one user asks for LOOKUP_MISS_RATE_LIMIT_PER_MIN + 5 new words at once: the first 20 are answered, the rest are 429
 *                 with Retry-After.
 *`,
        ` *   C  F6         one user asks for LOOKUP_MISS_RATE_LIMIT_PER_MIN + 5 new words at once: the first 20 are answered, the rest are 429
 *                 with Retry-After.
 *   D  ANSWER AND JOB SEND   --send new words one after the other with ENRICHMENT_ENABLED=true and the REAL pg-boss sender, in a private
 *                 schema (lt_<run>) with no worker, so no job is ever processed. Since spec 1.5 the job is sent after the answer:
 *                 the figures show the answer time and, next to it, what the visitor would have waited with the send in front of it.
 *                 Cleans up what it made: the ledger rows, the daily job counter it moved, the private schema.
 *`,
      ],
      [
        ` *   npm run loadtest:lookup -- --skip-slow       # without the single-flight scenario (it waits ~15 s)`,
        ` *   npm run loadtest:lookup -- --skip-slow       # without the single-flight scenario (it waits ~15 s)
 *   npm run loadtest:lookup -- --send 30         # words of scenario D (default 30; --skip-send leaves the scenario out)`,
      ],
      [
        `import jwt from 'jsonwebtoken';
import pool from '../../config/db';
import { startMockUpstream, type MockUpstream } from '../mock-upstream/server';`,
        `import jwt from 'jsonwebtoken';
import pool from '../../config/db';
import { currentPeriod } from '../../services/upstream/apiUsage';
import { startMockUpstream, type MockUpstream } from '../mock-upstream/server';`,
      ],
      [
        `const SKIP_SLOW = argv.includes('--skip-slow');`,
        `const SKIP_SLOW = argv.includes('--skip-slow');
/** Scenario D: how many new words are looked up one after the other with the real job sender (0 = leave the scenario out). */
const SEND = argv.includes('--skip-send') ? 0 : num('send', 30);`,
      ],
      [
        `  lookupLogs: Array<Record<string, any>>;
  heap(): Promise<Heap>;`,
        `  lookupLogs: Array<Record<string, any>>;
  /** The \`lookup_enrich\` lines (the real answer of each background job send, spec 1.5). */
  enrichLogs: Array<Record<string, any>>;
  heap(): Promise<Heap>;`,
      ],
      [
        `  const lookupLogs: Array<Record<string, any>> = [];
  let buffer = '';
  child.stdout!.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split('\\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{"evt":"lookup"')) continue;
      try {
        lookupLogs.push(JSON.parse(line));
      } catch {
        /* partial line */
      }
    }
  });`,
        `  const lookupLogs: Array<Record<string, any>> = [];
  const enrichLogs: Array<Record<string, any>> = [];
  let buffer = '';
  child.stdout!.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split('\\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const target = line.startsWith('{"evt":"lookup"') ? lookupLogs : line.startsWith('{"evt":"lookup_enrich"') ? enrichLogs : null;
      if (!target) continue;
      try {
        target.push(JSON.parse(line));
      } catch {
        /* partial line */
      }
    }
  });`,
      ],
      [
        `    base: \`http://127.0.0.1:\${port}\`,
    lookupLogs,`,
        `    base: \`http://127.0.0.1:\${port}\`,
    lookupLogs,
    enrichLogs,`,
      ],
      [
        `  partial: boolean | null;
  retryAfter: string | null;
  error?: string;
}`,
        `  partial: boolean | null;
  /** data.enrichment.status of the answer */
  enrichment: string | null;
  retryAfter: string | null;
  error?: string;
}`,
      ],
      [
        `    return { group, word: w, status: res.status, ms: Math.round(performance.now() - t0), partial: body?.data?.partial ?? null, retryAfter: res.headers.get('retry-after') };
  } catch (err) {
    return { group, word: w, status: 0, ms: Math.round(performance.now() - t0), partial: null, retryAfter: null, error: String((err as Error).message) };`,
        `    return { group, word: w, status: res.status, ms: Math.round(performance.now() - t0), partial: body?.data?.partial ?? null, enrichment: body?.data?.enrichment?.status ?? null, retryAfter: res.headers.get('retry-after') };
  } catch (err) {
    return { group, word: w, status: 0, ms: Math.round(performance.now() - t0), partial: null, enrichment: null, retryAfter: null, error: String((err as Error).message) };`,
      ],
      [
        `// ── main ─────────────────────────────────────────────────────────────────────`,
        `/**
 * D · what the visitor waits for, with the job send AFTER the answer (docs/lookup-spec.md §5, version 1.5). The real sender (pg-boss, role
 * "sender": it only inserts) works in a private schema nobody processes. Sequential on purpose: one request at a time, so the figures are
 * the cost of the code and of the database round trips, not of a queue of requests for a connection.
 */
async function scenarioJobSend(mock: MockUpstream, ebookId: string, tokens: string[]): Promise<void> {
  console.log(\`\\nD · ANSWER AND JOB SEND   \${SEND} new words one after the other, real pg-boss sender in schema lt_\${RUN} (no worker), upstream latency \${LATENCY_MS} ms\`);
  const schema = \`lt_\${RUN}\`;
  const period = currentPeriod('day');
  const prefix = word('send');
  const counter = async () => (await pool.query(\`SELECT used FROM api_usage_counters WHERE provider = 'enrichment' AND unit = 'jobs' AND period = $1\`, [period])).rows[0];
  const counterBefore = await counter();
  const ledger = async () => Number((await pool.query(\`SELECT COUNT(*)::int AS n FROM word_enrichment_jobs WHERE word LIKE $1\`, [\`\${prefix}%\`])).rows[0].n);
  const untilLedger = async (n: number, limitMs: number) => {
    const t0 = Date.now();
    while ((await ledger()) < n && Date.now() - t0 < limitMs) await sleep(400);
  };

  const app = await startApp(mock, { ENRICHMENT_ENABLED: 'true', ENRICHMENT_WORKER_ENABLED: 'false', PGBOSS_SCHEMA: schema });
  try {
    mock.reset();
    mock.setControl({ google: { latencyMs: LATENCY_MS }, fd: { latencyMs: LATENCY_MS } });
    await app.warm(10);
    // The first send starts pg-boss and creates its private schema (migrations over a far-away database): not measured.
    const warmWords = [0, 1, 2].map((i) => \`\${prefix}w\${alpha(i)}\`);
    for (const w of warmWords) await lookup(app, ebookId, tokens[0], w, 'warm');
    await untilLedger(warmWords.length, 180_000);
    app.enrichLogs.length = 0;

    const results: Result[] = [];
    // eight users take turns: the per-user limit (20 new words a minute) is not what is being measured
    for (let i = 0; i < SEND; i++) results.push(await lookup(app, ebookId, tokens[1 + (i % 8)], \`\${prefix}m\${alpha(i)}\`, 'send'));
    await untilLedger(warmWords.length + SEND, 120_000);
    await sleep(800); // the last log lines

    const sendLog = new Map(app.enrichLogs.map((l) => [l.word as string, l]));
    const sendMs = results.map((r) => sendLog.get(r.word)?.enqueue_ms).filter((v): v is number => typeof v === 'number');
    const answer = summarize(results.map((r) => r.ms));
    console.log(\`  \${results.length} lookups; statuses \${JSON.stringify(countStatuses(results))}; the app logged \${app.enrichLogs.length} job sends (\${sendMs.length} with a timing)\`);
    const rows: Array<Record<string, unknown>> = [{ what: 'answer (the send runs after it)', n: answer.n, p50: answer.p50, p95: answer.p95, max: answer.max }];
    if (sendMs.length === results.length) {
      const withSend = summarize(results.map((r) => r.ms + (sendLog.get(r.word)!.enqueue_ms as number)));
      const alone = summarize(sendMs);
      rows.push({ what: 'answer + send (the visitor waited for the send, as before spec 1.5)', n: withSend.n, p50: withSend.p50, p95: withSend.p95, max: withSend.max });
      rows.push({ what: 'the job send alone (enqueue_ms)', n: alone.n, p50: alone.p50, p95: alone.p95, max: alone.max });
      report.jobSend = { latencyMs: LATENCY_MS, words: SEND, answer, answerPlusSend: withSend, sendAlone: alone, statuses: countStatuses(results) };
      check(withSend.p95 > answer.p95, \`the answer is faster than answer + send (p95 \${answer.p95} ms against \${withSend.p95} ms)\`);
    } else {
      report.jobSend = { latencyMs: LATENCY_MS, words: SEND, answer, statuses: countStatuses(results), note: 'no lookup_enrich lines: the app did not send in the background' };
    }
    console.table(rows);

    check(results.every((r) => r.status === 200 && r.partial === false), 'every answer is 200 and complete');
    check(results.every((r) => r.enrichment === 'queued'), \`every answer says enrichment.status = "queued" (\${JSON.stringify([...new Set(results.map((r) => r.enrichment))])})\`);
    check((await ledger()) >= warmWords.length + SEND, \`every word reached the job ledger (\${await ledger()} rows for \${warmWords.length + SEND} words): the send really ran\`);
    check(app.enrichLogs.every((l) => l.status === 'queued'), 'every background send was queued (none already_queued / skipped / failed)');
  } finally {
    await app.stop();
    // what scenario D made: ledger rows, the daily slot each of them took, the private pg-boss schema
    const made = await ledger();
    await pool.query(\`DELETE FROM word_enrichment_jobs WHERE word LIKE $1\`, [\`\${prefix}%\`]);
    if (made > 0) await pool.query(\`UPDATE api_usage_counters SET used = GREATEST(0, used - $1) WHERE provider = 'enrichment' AND unit = 'jobs' AND period = $2\`, [made, period]);
    if (!counterBefore) await pool.query(\`DELETE FROM api_usage_counters WHERE provider = 'enrichment' AND unit = 'jobs' AND period = $1 AND used = 0\`, [period]);
    await pool.query(\`DROP SCHEMA IF EXISTS "\${schema}" CASCADE\`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────`,
      ],
      [
        `    if (!SKIP_SLOW) await scenarioSingleFlight(mock, ebookId, tokens);`,
        `    if (!SKIP_SLOW) await scenarioSingleFlight(mock, ebookId, tokens);
    if (SEND > 0) await scenarioJobSend(mock, ebookId, tokens);`,
      ],
    ],
  },
];
