const fs = require('fs');

function edit(file, fn) {
  let text = fs.readFileSync(file, 'utf8');
  const crlf = text.includes('\r\n');
  if (crlf) text = text.split('\r\n').join('\n');
  text = fn(text);
  if (crlf) text = text.split('\n').join('\r\n');
  fs.writeFileSync(file, text);
  console.log(`patched ${file}`);
}
function rep(t, a, b) {
  if (!t.includes(a)) throw new Error('missing: ' + a.slice(0, 90));
  if (t.indexOf(a) !== t.lastIndexOf(a)) throw new Error('twice: ' + a.slice(0, 90));
  return t.replace(a, () => b);
}

// the names written to pgboss.instance, in one place
edit('services/queue/boss.ts', (t) => {
  t = rep(
    t,
    `export function buildBossOptions(`,
    `/** \`pgboss.instance.name\` of a process that TAKES jobs, and of one that only SENDS them (the API server of a deployment). */
export const WORKER_INSTANCE_NAME = 'enrichment-worker';
export const SENDER_INSTANCE_NAME = 'enrichment-sender';

export function buildBossOptions(`
  );
  t = rep(t, `    instanceName: role === 'worker' ? 'enrichment-worker' : 'enrichment-sender',`, `    instanceName: role === 'worker' ? WORKER_INSTANCE_NAME : SENDER_INSTANCE_NAME,`);
  return t;
});

edit('services/enrichment/oxford/send.ts', (t) => {
  t = rep(
    t,
    `/** pg-boss workers that are alive: not stopped, and a heartbeat inside the window. */
export async function liveWorkers(db: Queryable, schema: string, windowSeconds = 180): Promise<WorkerInstance[]> {
  if (!IDENT.test(schema)) throw new Error('PGBOSS_SCHEMA is not a plain identifier');
  const { rows } = await db.query(
    \`SELECT name, host, pid, started_on, heartbeat_on FROM "\${schema}".instance
      WHERE stopped_on IS NULL AND heartbeat_on > now() - ($1::int * interval '1 second') ORDER BY started_on DESC\`,
    [windowSeconds]
  );
  return rows;
}`,
    `/**
 * pg-boss processes that TAKE jobs and are alive: an instance named \`enrichment-worker\` (WORKER_INSTANCE_NAME), not stopped, with a heartbeat
 * inside the window. A process that only SENDS jobs (\`enrichment-sender\`: the API server of a deployment, a command-line tool) is in the same
 * table but takes nothing, so it is not counted: counting it made a healthy deployment look like a second worker.
 */
export async function liveWorkers(db: Queryable, schema: string, windowSeconds = 180, instanceName: string = WORKER_INSTANCE_NAME): Promise<WorkerInstance[]> {
  if (!IDENT.test(schema)) throw new Error('PGBOSS_SCHEMA is not a plain identifier');
  const { rows } = await db.query(
    \`SELECT name, host, pid, started_on, heartbeat_on FROM "\${schema}".instance
      WHERE name = $2 AND stopped_on IS NULL AND heartbeat_on > now() - ($1::int * interval '1 second') ORDER BY started_on DESC\`,
    [windowSeconds, instanceName]
  );
  return rows;
}`
  );
  t = rep(t, `import type { EnrichmentEnqueuer } from '../../lookup/enqueuer';`, `import type { EnrichmentEnqueuer } from '../../lookup/enqueuer';
import { WORKER_INSTANCE_NAME } from '../../queue/boss';`);
  return t;
});

edit('tests/enrichment/oxfordSeed.integration.test.ts', (t) => {
  t = rep(
    t,
    `    expect(calls[0].sql).toMatch(/heartbeat_on > now\\(\\)/);
    expect(calls[0].params).toEqual([120]);`,
    `    expect(calls[0].sql).toMatch(/heartbeat_on > now\\(\\)/);
    expect(calls[0].sql).toMatch(/name = \\$2/); // only instances that take jobs: a sender (the API server of a deployment) takes none
    expect(calls[0].params).toEqual([120, 'enrichment-worker']);
    expect(WORKER_INSTANCE_NAME).toBe(buildBossOptions({ schema: 'pgboss' } as any, 'worker', {}).instanceName);
    expect(SENDER_INSTANCE_NAME).toBe(buildBossOptions({ schema: 'pgboss' } as any, 'sender', {}).instanceName);
    expect(SENDER_INSTANCE_NAME).not.toBe(WORKER_INSTANCE_NAME);`
  );
  t = rep(t, `import { liveWorkers, preflight, sendWords, type WorkerInstance } from '../../services/enrichment/oxford/send';`, `import { liveWorkers, preflight, sendWords, type WorkerInstance } from '../../services/enrichment/oxford/send';
import { buildBossOptions, SENDER_INSTANCE_NAME, WORKER_INSTANCE_NAME } from '../../services/queue/boss';`);
  return t;
});

// the runbook says what counts
edit('docs/lookup-runbook.md', (t) =>
  rep(
    t,
    `| Có đúng một worker, của máy bạn | \`--confirm\` tự kiểm bảng \`pgboss.instance\` (không dừng, nhịp tim trong 3 phút) | Có worker của máy khác (kể cả máy chủ triển khai) thì từ chối: worker đó cũng nhận job, với cấu hình và mã của nó |`,
    `| Có đúng một worker, của máy bạn | \`--confirm\` tự kiểm bảng \`pgboss.instance\`: chỉ đếm dòng có \`name = 'enrichment-worker'\`, không dừng, nhịp tim trong 3 phút | Có worker của máy khác thì từ chối: worker đó cũng nhận job, với cấu hình và mã của nó. Dòng \`name = 'enrichment-sender'\` (máy chủ triển khai chạy \`ENRICHMENT_WORKER_ENABLED=false\`, hoặc một công cụ dòng lệnh) **chỉ gửi, không nhận job** nên không tính. Trước P11 bộ kiểm tra không lọc theo tên và coi một sender là "worker khác" |`
  )
);
