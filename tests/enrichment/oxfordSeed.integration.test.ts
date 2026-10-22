/**
 * `enrich:seed-oxford` (services/enrichment/oxford/run.ts) against the real PostgreSQL (the dev database) with a FAKE pg-boss: the real
 * enqueuer runs (ledger rows, daily cap counter, singletonKey) but no queue exists and no Haiku call can happen. Every word is
 * "qzq<run>…", every counter is under its own provider key, and everything is removed at the end.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pool from '../../config/db';
import { PgBossEnrichmentEnqueuer } from '../../services/queue/pgBossEnqueuer';
import { runSeed, type SeedDeps } from '../../services/enrichment/oxford/run';
import { classifyWords, buildSeedPlan } from '../../services/enrichment/oxford/plan';
import { liveWorkers, preflight, sendWords, type WorkerInstance } from '../../services/enrichment/oxford/send';
import { buildBossOptions, SENDER_INSTANCE_NAME, WORKER_INSTANCE_NAME } from '../../services/queue/boss';
import { parseOxford } from '../../services/enrichment/oxford/list';
import { readState } from '../../services/enrichment/oxford/state';
import { BEGIN_MARK, END_MARK } from '../../services/enrichment/oxford/report';
import { RUN, cleanup, createEntry, fixtureWord } from '../helpers/lookupAdminFixtures';

const PROVIDER = `oxford-test-${RUN}`;
/** every harness has its own daily counter, unless a test hands several of them the same one (a rerun "the next day") */
let counterSeq = 0;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oxford-seed-'));
/** the word cleaner refuses digits: a digit in a tag becomes a letter, everywhere the same way */
const L = (tag: string): string => tag.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
const word = (tag: string) => fixtureWord(L(tag));

afterAll(async () => {
  await pool.query(`DELETE FROM word_enrichment_jobs WHERE word LIKE $1`, [`qzq${RUN}%`]);
  await pool.query(`DELETE FROM api_usage_counters WHERE provider LIKE $1`, [`${PROVIDER}%`]);
  await cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
  await pool.end();
});

// the first connection of a run can be cut while a serverless database wakes: wake it first
beforeAll(async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}, 30_000);

jest.setTimeout(120_000);

/** An Oxford file with these words: [tag, level, type]. Returns its path. */
function oxfordFile(name: string, rows: Array<[string, string, string]>, extra: object[] = []): string {
  const file = path.join(TMP, `${name}.json`);
  const list = rows.map(([tag, level, type], id) => ({ id, value: { word: word(tag), type, level, us: {}, uk: {}, phonetics: {}, examples: ['FIXTURE-NOT-FOR-USE'] } }));
  fs.writeFileSync(file, JSON.stringify([...list, ...extra]));
  return file;
}

function harness(over: Partial<SeedDeps['config']> & { maxJobsPerDay?: number; workers?: WorkerInstance[]; ranks?: Record<string, number>; counter?: string } = {}) {
  const sent: Array<{ name: string; data: any; options: any }> = [];
  const boss = {
    send: jest.fn(async (name: string, data: object, options?: Record<string, unknown>) => {
      sent.push({ name, data, options });
      return `job-${sent.length}`;
    }),
  };
  const enqueuer = new PgBossEnrichmentEnqueuer({ pool: pool as any, getBoss: async () => boss, maxJobsPerDay: over.maxJobsPerDay ?? 500, usageProvider: over.counter ?? `${PROVIDER}-${counterSeq++}` });
  const out: string[] = [];
  const err: string[] = [];
  const stateFile = path.join(TMP, `state-${Math.random().toString(36).slice(2)}.json`);
  const createEnqueuer = jest.fn(async () => enqueuer);
  const refDb = over.ranks
    ? { query: async (_sql: string, params?: any[]) => ({ rows: (params![0] as string[]).filter((w) => over.ranks![w] !== undefined).map((w) => ({ word: w, rank: over.ranks![w] })) }) }
    : (pool as any);
  const deps: SeedDeps = {
    db: pool as any,
    refDb,
    config: {
      enrichmentEnabled: over.enrichmentEnabled ?? true,
      publishPolicy: over.publishPolicy ?? 'review',
      model: 'claude-haiku-5-5',
      concurrency: 2,
      dailyCap: over.maxJobsPerDay ?? 500,
      schema: 'pgboss',
    },
    hostname: 'test-host',
    loadTopics: async () => undefined,
    listWorkers: async () => over.workers ?? [{ name: 'enrichment-worker', host: 'test-host', pid: 1, started_on: new Date(), heartbeat_on: new Date() }],
    createEnqueuer,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stateFile,
    reportFile: path.join(TMP, `report-${Math.random().toString(36).slice(2)}.md`),
  };
  return { deps, boss, sent, out, err, stateFile, createEnqueuer, text: () => out.join('\n') };
}

const jobRows = async (words: string[]) => (await pool.query(`SELECT word, status FROM word_enrichment_jobs WHERE word = ANY($1::text[]) ORDER BY word`, [words])).rows;

// ═════════════════════════════════════════════════════════════════════════════
describe('the dry run (the default)', () => {
  it('prints the plan and sends NOTHING: no job row, no queue call, no state file, the queue is not even opened', async () => {
    const file = oxfordFile('dry', [['dry1', 'A1', 'noun'], ['dry2', 'B1', 'verb'], ['dry3', 'C1', 'adjective']]);
    const h = harness();
    expect(await runSeed(['--file', file], h.deps)).toBe(0);
    expect(h.text()).toContain('CHƯA GỬI GÌ');
    expect(h.text()).toContain('--confirm');
    expect(await jobRows([word('dry1'), word('dry2'), word('dry3')])).toEqual([]);
    expect(h.boss.send).not.toHaveBeenCalled();
    expect(h.createEnqueuer).not.toHaveBeenCalled();
    expect(fs.existsSync(h.stateFile)).toBe(false);
  });

  it('--dry-run is the same; --dry-run with --confirm is refused', async () => {
    const file = oxfordFile('dry2', [['dryb1', 'A1', 'noun']]);
    const h = harness();
    expect(await runSeed(['--file', file, '--dry-run'], h.deps)).toBe(0);
    expect(h.boss.send).not.toHaveBeenCalled();
    const h2 = harness();
    expect(await runSeed(['--file', file, '--dry-run', '--confirm'], h2.deps)).toBe(2);
    expect(h2.err.join('\n')).toContain('cannot be used together');
    expect(await jobRows([word('dryb1')])).toEqual([]);
  });

  it('is told wrong usage (no file, an unknown option, a typo of --confirm) with exit 2 and does nothing', async () => {
    const file = oxfordFile('usage', [['usage1', 'A1', 'noun']]);
    for (const argv of [[], ['--file', file, '--confirmed'], ['--file', file, '--yes'], ['--file']]) {
      const h = harness();
      expect(await runSeed(argv, h.deps)).toBe(2);
      expect(h.boss.send).not.toHaveBeenCalled();
    }
    expect(await jobRows([word('usage1')])).toEqual([]);
  });

  it('prints the cost, the time and the days, saying whether they are a real average or an estimate', async () => {
    const file = oxfordFile('est', [['est1', 'A1', 'noun'], ['est2', 'A2', 'noun']]);
    const h = harness();
    // a day nobody has sent anything on: the real counter of today (hundreds of jobs after a real run) does not belong in this test
    h.deps.now = () => new Date('2099-01-01T12:00:00Z');
    await runSeed(['--file', file], h.deps);
    expect(h.text()).toMatch(/chi phí: +\$[\d.]+/);
    expect(h.text()).toMatch(/trung bình thật của \d+ job|ƯỚC TÍNH/);
    expect(h.text()).toMatch(/thời gian: /);
    expect(h.text()).toMatch(/số ngày: +1 +\(ENRICHMENT_MAX_JOBS_PER_DAY = 500/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('who is left out, and why', () => {
  it('an entry (published or not), a word form, a queued job and a closed earlier outcome are left out; a job that may pass is not', async () => {
    const tags = ['exEntryPub', 'exEntryHid', 'exForm', 'exQueued', 'exRejected', 'exVariant', 'exInvalid', 'exUpstream', 'exSucceeded', 'exFree'];
    const file = oxfordFile('classify', tags.map((t) => [t, 'A1', 'noun'] as [string, string, string]));
    const entryPub = await createEntry({ tag: L('exEntryPub'), published: true });
    await createEntry({ tag: L('exEntryHid'), published: false });
    await pool.query(`INSERT INTO word_forms (entry_id, form_type, form_value) VALUES ($1, 'plural', $2)`, [entryPub, word('exForm')]);
    const job = (tag: string, status: string, reason: string | null) =>
      pool.query(`INSERT INTO word_enrichment_jobs (word, status, reason, finished_at) VALUES ($1, $2::varchar, $3, CASE WHEN $2::varchar IN ('queued','running') THEN NULL ELSE NOW() END)`, [word(tag), status, reason]);
    await job('exQueued', 'queued', null);
    await job('exRejected', 'rejected', 'proper_noun');
    await job('exVariant', 'skipped', 'variant_form');
    await job('exInvalid', 'failed', 'invalid_output'); // two runs that ended invalid: final
    await job('exInvalid', 'failed', 'invalid_output');
    await job('exUpstream', 'failed', 'upstream_error');
    await job('exSucceeded', 'succeeded', null); // its entry was deleted since: the word is eligible again

    const parsed = parseOxford(JSON.parse(fs.readFileSync(file, 'utf8')));
    const { eligible, excluded } = await classifyWords(pool as any, parsed.words);
    const reasonOf = Object.fromEntries(excluded.map((e) => [e.word, e.reason]));
    expect(reasonOf).toEqual({
      [word('exEntryPub')]: 'in_dictionary',
      [word('exEntryHid')]: 'in_dictionary',
      [word('exForm')]: 'in_word_forms',
      [word('exQueued')]: 'in_queue',
      [word('exRejected')]: 'done_before',
      [word('exVariant')]: 'done_before',
      [word('exInvalid')]: 'done_before',
    });
    expect(eligible.map((w) => w.word).sort()).toEqual([word('exFree'), word('exSucceeded'), word('exUpstream')].sort());
  });

  it('the same cleaner as the lookup path: a word it refuses is reported and never sent', async () => {
    const file = oxfordFile('cleaner', [['cleaner1', 'A1', 'noun']], [{ id: 99, value: { word: 'two words', type: 'noun', level: 'A1' } }, { id: 100, value: { word: 'x1y', type: 'noun', level: 'A1' } }]);
    const h = harness();
    expect(await runSeed(['--file', file, '--confirm'], h.deps)).toBe(0);
    expect(h.text()).toContain('two words');
    expect(h.text()).toContain('x1y');
    expect(h.sent.map((s) => s.data.word)).toEqual([word('cleaner1')]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('--confirm', () => {
  it('sends exactly the chosen words, in order (CEFR ascending, then frequency), one job each, singletonKey = the word', async () => {
    const file = oxfordFile('send', [
      ['sendC', 'B1', 'noun'],
      ['sendA', 'A1', 'noun'],
      ['sendB', 'A1', 'verb'],
      ['sendD', 'A2', 'noun'],
    ]);
    const ranks = { [word('sendA')]: 500, [word('sendB')]: 20, [word('sendC')]: 1, [word('sendD')]: 3 };
    const h = harness({ ranks });
    expect(await runSeed(['--file', file, '--confirm'], h.deps)).toBe(0);
    expect(h.sent.map((s) => s.data.word)).toEqual([word('sendB'), word('sendA'), word('sendD'), word('sendC')]);
    for (const s of h.sent) {
      expect(s.name).toBe('dictionary.enrich_word');
      expect(s.options.singletonKey).toBe(s.data.word);
      expect(s.data).toMatchObject({ requestedBy: null, ebookId: null });
    }
    expect(await jobRows(h.sent.map((s) => s.data.word))).toHaveLength(4);
    expect((await jobRows([word('sendA')]))[0].status).toBe('queued');
    expect(h.text()).toContain('job mới trong hàng đợi: 4');
  });

  it('--limit and --offset cut the ordered list; --only-cefr keeps some levels', async () => {
    const file = oxfordFile('cut', [['cut1', 'A1', 'noun'], ['cut2', 'A1', 'noun'], ['cut3', 'A2', 'noun'], ['cut4', 'B1', 'noun'], ['cut5', 'B1', 'noun']]);
    const ranks = Object.fromEntries(['cut1', 'cut2', 'cut3', 'cut4', 'cut5'].map((t, i) => [word(t), i + 1]));
    const h = harness({ ranks });
    expect(await runSeed(['--file', file, '--confirm', '--only-cefr', 'A1,B1', '--offset', '1', '--limit', '2'], h.deps)).toBe(0);
    expect(h.sent.map((s) => s.data.word)).toEqual([word('cut2'), word('cut4')]);
  });

  it('--sample picks a stratified sample and sends only that', async () => {
    const levels = ['A1', 'A2', 'B1'];
    const file = oxfordFile('sample', levels.flatMap((l, li) => [0, 1, 2, 3].map((i) => [`smp${l.toLowerCase()}${'abcd'[i]}`, l, 'noun'] as [string, string, string])));
    const h = harness();
    expect(await runSeed(['--file', file, '--confirm', '--sample', '6'], h.deps)).toBe(0);
    expect(h.sent).toHaveLength(6);
    const count = (prefix: string) => h.sent.filter((s) => s.data.word.startsWith(word(prefix))).length;
    expect([count('smpa1'), count('smpa2'), count('smpb1')]).toEqual([2, 2, 2]);
  });

  it('writes down what it sent: the words, the options, the size and counters before, the estimate', async () => {
    const file = oxfordFile('state', [['state1', 'A1', 'noun'], ['state2', 'A2', 'noun']]);
    const h = harness();
    await runSeed(['--file', file, '--confirm'], h.deps);
    const state = readState(h.stateFile);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].words.sort()).toEqual([word('state1'), word('state2')].sort());
    expect(state.runs[0].before.dbBytes).toBeGreaterThan(0);
    expect(state.runs[0].estimate.words).toBe(2);
    expect(state.runs[0].stoppedBy).toBeNull();
    expect(JSON.stringify(state)).not.toMatch(/ANTHROPIC_API|sk-ant|password|secret/i);
  });

  it('stops at the first daily_cap and says how many are left; a rerun sends ONLY the rest, with no duplicate job', async () => {
    const tags = ['cap1', 'cap2', 'cap3', 'cap4', 'cap5', 'cap6'];
    const file = oxfordFile('cap', tags.map((t, i) => [t, 'A1', 'noun'] as [string, string, string]));
    const ranks = Object.fromEntries(tags.map((t, i) => [word(t), i + 1]));

    const counter = `${PROVIDER}-cap`;
    const first = harness({ maxJobsPerDay: 3, ranks, counter });
    expect(await runSeed(['--file', file, '--confirm'], first.deps)).toBe(0);
    expect(first.sent.map((s) => s.data.word)).toEqual(tags.slice(0, 3).map(word));
    expect(first.text()).toContain('DỪNG vì daily_cap: còn 3 từ chưa gửi');
    expect(readState(first.stateFile).runs[0]).toMatchObject({ stoppedBy: 'daily_cap' });
    expect(await jobRows(tags.map(word))).toHaveLength(3); // the word that met the cap left no row

    // "the next day": a bigger cap on the same counter
    const second = harness({ maxJobsPerDay: 10, ranks, counter });
    expect(await runSeed(['--file', file, '--confirm'], second.deps)).toBe(0);
    expect(second.sent.map((s) => s.data.word)).toEqual(tags.slice(3).map(word));

    const rows = await jobRows(tags.map(word));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.word)).size).toBe(6);

    // and a third run has nothing left
    const third = harness({ maxJobsPerDay: 10, ranks, counter });
    expect(await runSeed(['--file', file, '--confirm'], third.deps)).toBe(0);
    expect(third.text()).toContain('Không có từ nào để gửi');
    expect(third.boss.send).not.toHaveBeenCalled();
  });

  it('a rerun right after a run (the worker has not started) sends nothing: the words are in the queue', async () => {
    const file = oxfordFile('rerun', [['rerun1', 'A1', 'noun'], ['rerun2', 'A1', 'noun']]);
    const a = harness();
    await runSeed(['--file', file, '--confirm'], a.deps);
    const b = harness();
    expect(await runSeed(['--file', file, '--confirm'], b.deps)).toBe(0);
    expect(b.boss.send).not.toHaveBeenCalled();
    expect(await jobRows([word('rerun1'), word('rerun2')])).toHaveLength(2);
  });

  it('a word that gained an entry between two runs is not sent again', async () => {
    const file = oxfordFile('gained', [['gained1', 'A1', 'noun'], ['gained2', 'A1', 'noun']]);
    await createEntry({ tag: L('gained1') });
    const h = harness();
    await runSeed(['--file', file, '--confirm'], h.deps);
    expect(h.sent.map((s) => s.data.word)).toEqual([word('gained2')]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the checks before --confirm: any failure sends nothing and creates nothing', () => {
  let n = 0;
  const run = async (over: Parameters<typeof harness>[0], extra: string[] = []) => {
    const id = `chk${n++}`;
    const file = oxfordFile(id, [[id, 'A1', 'noun']]);
    const h = harness(over);
    // the file has its own fresh name per call, so tags are shared only inside this call
    const code = await runSeed(['--file', file, '--confirm', ...extra], h.deps);
    return { code, h };
  };
  const nothingHappened = async (h: ReturnType<typeof harness>) => {
    expect(h.boss.send).not.toHaveBeenCalled();
    expect(h.createEnqueuer).not.toHaveBeenCalled();
    expect(fs.existsSync(h.stateFile)).toBe(false);
    expect(h.err.join('\n')).toContain('KHÔNG GỬI');
  };

  it('ENRICHMENT_ENABLED=false', async () => {
    const { code, h } = await run({ enrichmentEnabled: false });
    expect(code).toBe(1);
    expect(h.text()).toContain('[KHÔNG ĐẠT] ENRICHMENT_ENABLED');
    await nothingHappened(h);
  });

  it('ENRICHMENT_PUBLISH_POLICY=auto is refused unless --allow-auto is also given', async () => {
    const refused = await run({ publishPolicy: 'auto' });
    expect(refused.code).toBe(1);
    expect(refused.h.text()).toContain('[KHÔNG ĐẠT] ENRICHMENT_PUBLISH_POLICY');
    expect(refused.h.text()).toContain('--allow-auto');
    await nothingHappened(refused.h);

    const allowed = await run({ publishPolicy: 'auto' }, ['--allow-auto']);
    expect(allowed.code).toBe(0);
    expect(allowed.h.text()).toContain('CHẤP NHẬN vì có --allow-auto');
    expect(allowed.h.boss.send).toHaveBeenCalledTimes(1);
  });

  it('no worker of this machine is alive', async () => {
    const { code, h } = await run({ workers: [] });
    expect(code).toBe(1);
    expect(h.text()).toContain('không có worker nào của máy này');
    await nothingHappened(h);
  });

  it('a worker of ANOTHER machine is also connected (it would take the jobs, with its own configuration)', async () => {
    const mine = { name: 'enrichment-worker', host: 'test-host', pid: 1, started_on: new Date(), heartbeat_on: new Date() };
    const other = { name: 'enrichment-worker', host: 'srv-deployed', pid: 70, started_on: new Date(), heartbeat_on: new Date() };
    const { code, h } = await run({ workers: [mine, other] });
    expect(code).toBe(1);
    expect(h.text()).toContain('có worker KHÁC cùng nhận job: srv-deployed#70');
    await nothingHappened(h);
  });

  it('the 30 topic tags are missing', async () => {
    const file = oxfordFile('topics', [['topics1', 'A1', 'noun']]);
    const h = harness();
    h.deps.loadTopics = async () => {
      throw new Error('topics_not_seeded: 3 of 30 topic tags are missing: a, b, c');
    };
    expect(await runSeed(['--file', file, '--confirm'], h.deps)).toBe(1);
    expect(h.text()).toContain('topics_not_seeded');
    expect(h.text()).toContain('docs/seed-topics.sql');
    await nothingHappened(h);
  });

  it('all checks pass → it reminds about the monthly spending cap of Anthropic before it sends', async () => {
    const { code, h } = await run({});
    expect(code).toBe(0);
    expect(h.text()).toMatch(/trần chi tiêu hằng tháng của Anthropic/);
    expect(h.text().indexOf('trần chi tiêu')).toBeLessThan(h.text().indexOf('Bắt đầu gửi'));
  });

  it('the dry run shows the same checks without failing', async () => {
    const file = oxfordFile('chkdry', [['chkdry1', 'A1', 'noun']]);
    const h = harness({ enrichmentEnabled: false, workers: [] });
    expect(await runSeed(['--file', file], h.deps)).toBe(0);
    expect(h.text()).toContain('[KHÔNG ĐẠT] ENRICHMENT_ENABLED');
    expect(h.text()).toContain('CHƯA GỬI GÌ');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('sending and the worker list in isolation', () => {
  it('sendWords stops at daily_cap, counts already_queued, collects skips and stops after three errors in a row', async () => {
    const answers: any[] = [{ status: 'queued' }, { status: 'already_queued' }, { status: 'skipped', reason: 'exists' }, { status: 'skipped', reason: 'daily_cap' }, { status: 'queued' }];
    const enqueuer = { enqueue: jest.fn(async () => answers.shift()) };
    const r = await sendWords(enqueuer, ['a', 'b', 'c', 'd', 'e']);
    expect(r).toMatchObject({ queued: ['a'], alreadyQueued: ['b'], skipped: [{ word: 'c', reason: 'exists' }], stoppedBy: 'daily_cap', notAttempted: ['d', 'e'] });

    const failing = { enqueue: jest.fn(async () => { throw new Error('boom'); }) };
    const e = await sendWords(failing, ['a', 'b', 'c', 'd']);
    expect(e.stoppedBy).toBe('errors');
    expect(e.errors).toHaveLength(3);
    expect(e.notAttempted).toEqual(['d']);

    const flaky = { enqueue: jest.fn() as any };
    flaky.enqueue.mockRejectedValueOnce(new Error('x')).mockResolvedValue({ status: 'queued' });
    expect((await sendWords(flaky, ['a', 'b', 'c'])).stoppedBy).toBeNull();

    const disabled = { enqueue: jest.fn(async () => ({ status: 'disabled' as const })) };
    expect((await sendWords(disabled, ['a', 'b'])).stoppedBy).toBe('disabled');
  });

  it('liveWorkers reads the pg-boss instance table of the schema, only workers that are not stopped and have a fresh heartbeat', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const fake = { query: async (sql: string, params?: any[]) => (calls.push({ sql, params }), { rows: [] }) };
    await liveWorkers(fake, 'pgboss', 120);
    expect(calls[0].sql).toMatch(/FROM "pgboss"\.instance/);
    expect(calls[0].sql).toMatch(/stopped_on IS NULL/);
    expect(calls[0].sql).toMatch(/heartbeat_on > now\(\)/);
    expect(calls[0].sql).toMatch(/name = \$2/); // only instances that take jobs: a sender (the API server of a deployment) takes none
    expect(calls[0].params).toEqual([120, 'enrichment-worker']);
    expect(WORKER_INSTANCE_NAME).toBe(buildBossOptions({ schema: 'pgboss' } as any, 'worker', {}).instanceName);
    expect(SENDER_INSTANCE_NAME).toBe(buildBossOptions({ schema: 'pgboss' } as any, 'sender', {}).instanceName);
    expect(SENDER_INSTANCE_NAME).not.toBe(WORKER_INSTANCE_NAME);
    await expect(liveWorkers(fake, 'pg"boss; drop table x')).rejects.toThrow(/plain identifier/);
    // and the real table answers (every worker recorded in it is old or stopped, or it is one of this machine's)
    const real = await liveWorkers(pool as any, 'pgboss');
    expect(Array.isArray(real)).toBe(true);
    // against the real table, with a window long enough to take in every row ever written: senders are in it and are left out
    const names = (await pool.query(`SELECT DISTINCT name FROM pgboss.instance`)).rows.map((r) => r.name);
    const everyone = await liveWorkers(pool as any, 'pgboss', 315_000_000);
    expect(everyone.every((w) => w.name === 'enrichment-worker')).toBe(true);
    if (names.includes('enrichment-sender') && names.includes('enrichment-worker')) {
      const stopped = (await pool.query(`SELECT count(*)::int AS n FROM pgboss.instance WHERE name = 'enrichment-worker' AND stopped_on IS NULL`)).rows[0].n;
      expect(everyone).toHaveLength(stopped);
    }
  });

  it('preflight reports every check, not just the first failure', async () => {
    const r = await preflight({
      db: pool as any,
      enrichmentEnabled: false,
      publishPolicy: 'auto',
      allowAuto: false,
      schema: 'pgboss',
      hostname: 'h',
      loadTopics: async () => {
        throw new Error('topics_not_seeded: 1 missing');
      },
      listWorkers: async () => [],
    });
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['ENRICHMENT_ENABLED', '30 chủ đề trong bảng tags', 'ENRICHMENT_PUBLISH_POLICY', 'worker đang chạy']);
  });

  it('buildSeedPlan puts the ranks from the reference table into the order', async () => {
    const file = oxfordFile('plan', [['plan1', 'A1', 'noun'], ['plan2', 'A1', 'noun']]);
    const parsed = parseOxford(JSON.parse(fs.readFileSync(file, 'utf8')));
    const refDb = { query: async () => ({ rows: [{ word: word('plan2'), rank: 7 }] }) };
    const plan = await buildSeedPlan(pool as any, refDb, parsed, {});
    expect(plan.selected.map((w) => [w.word, w.rank])).toEqual([[word('plan2'), 7], [word('plan1'), null]]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('--report', () => {
  it('writes the report from the database and the state file, keeps what was written by hand after the end mark, and prints no secret', async () => {
    const file = oxfordFile('report', [['report1', 'A1', 'noun'], ['report2', 'B1', 'verb']]);
    const h = harness();
    await runSeed(['--file', file, '--confirm'], h.deps);

    const target = path.join(TMP, 'report-out.md');
    const r1 = harness();
    r1.deps.stateFile = h.stateFile;
    r1.deps.reportFile = target;
    expect(await runSeed(['--file', file, '--report'], r1.deps)).toBe(0);
    let text = fs.readFileSync(target, 'utf8');
    expect(text).toContain(BEGIN_MARK);
    expect(text).toContain(END_MARK);
    for (const heading of ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '## 6.', '## 7.', '## 8.', '## 9.', '## 10.', '## 11.', '## 12.']) expect(text).toContain(heading);
    expect(text).toContain('queued / -'); // the two jobs are waiting for a worker
    expect(text).toContain('SELECT status');
    expect(text).not.toMatch(/sk-ant|ANTHROPIC_API_KEY=|postgres(ql)?:\/\//);
    expect(text).not.toContain('FIXTURE-NOT-FOR-USE');

    // hand-written notes after the end mark survive a second run
    fs.writeFileSync(target, text.replace(/\n## Ghi chú các giai đoạn[\s\S]*$/, '\n## Ghi chú các giai đoạn (viết tay)\n\nGHI CHÚ GIAI ĐOẠN 1 VIẾT TAY\n'));
    expect(await runSeed(['--file', file, '--report'], r1.deps)).toBe(0);
    text = fs.readFileSync(target, 'utf8');
    expect(text).toContain('GHI CHÚ GIAI ĐOẠN 1 VIẾT TAY');
    expect(text.match(new RegExp(BEGIN_MARK.replace(/[()]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('works before any run (no state file): says there is nothing yet instead of failing', async () => {
    const file = oxfordFile('report0', [['reportz1', 'A1', 'noun']]);
    const h = harness();
    h.deps.reportFile = path.join(TMP, 'report-empty.md');
    expect(await runSeed(['--file', file, '--report'], h.deps)).toBe(0);
    expect(fs.readFileSync(h.deps.reportFile!, 'utf8')).toContain('Chưa có lần gửi nào');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('a second pass: invalid_output is tried once more, and --retry-last-run sends only the words of the last run', () => {
  const addJob = (tag: string, status: string, reason: string | null, ageSeconds = 0) =>
    pool.query(
      `INSERT INTO word_enrichment_jobs (word, status, reason, created_at, finished_at) VALUES ($1, $2::varchar, $3, NOW() - ($4::int * INTERVAL '1 second'), NOW() - ($4::int * INTERVAL '1 second'))`,
      [word(tag), status, reason, ageSeconds]
    );
  const setLatest = (tag: string, status: string, reason: string | null) =>
    pool.query(`UPDATE word_enrichment_jobs SET status = $2::varchar, reason = $3, finished_at = NOW() WHERE word = $1 AND status IN ('queued', 'running')`, [word(tag), status, reason]);

  it('the first invalid_output does not close a word (it is a retry); the second does', async () => {
    const tags = ['inv0', 'inv1', 'inv2'];
    const file = oxfordFile('invalid', tags.map((t) => [t, 'A1', 'noun'] as [string, string, string]));
    await addJob('inv1', 'failed', 'invalid_output', 60); // one earlier failure
    await addJob('inv2', 'failed', 'invalid_output', 120); // two earlier failures
    await addJob('inv2', 'failed', 'invalid_output', 60);
    const parsed = parseOxford(JSON.parse(fs.readFileSync(file, 'utf8')));
    const { eligible, excluded, retries } = await classifyWords(pool as any, parsed.words);
    expect(eligible.map((w) => w.word).sort()).toEqual([word('inv0'), word('inv1')].sort());
    expect(excluded).toEqual([{ word: word('inv2'), reason: 'done_before', detail: 'failed / invalid_output (2 lượt)' }]);
    expect([...retries.entries()]).toEqual([[word('inv1'), 'failed / invalid_output (1 lượt)']]);
  });

  it('the dry run says how many words are SENT AGAIN and why', async () => {
    const file = oxfordFile('retryfmt', [['rf1', 'A1', 'noun'], ['rf2', 'A1', 'noun'], ['rf3', 'A1', 'noun']]);
    await addJob('rf1', 'failed', 'invalid_output');
    await addJob('rf2', 'failed', 'upstream_error');
    const h = harness();
    expect(await runSeed(['--file', file], h.deps)).toBe(0);
    expect(h.text()).toContain('trong đó GỬI LẠI 2 từ vì job trước chưa thành mục từ');
    expect(h.text()).toContain('failed / invalid_output (1 lượt) 1');
    expect(h.text()).toContain('failed / upstream_error 1');
    expect(h.boss.send).not.toHaveBeenCalled();
  });

  it('--retry-last-run: the dry run lists them and sends nothing; --confirm sends them and NOTHING else; no active word gets a second job', async () => {
    const tags = ['rl1', 'rl2', 'rl3', 'rl4', 'rl5'];
    const file = oxfordFile('retrylast', tags.map((t) => [t, 'A1', 'noun'] as [string, string, string]));
    const ranks = Object.fromEntries(tags.map((t, i) => [word(t), i + 1]));
    const counter = `${PROVIDER}-retrylast`;
    const stateFile = path.join(TMP, 'retry-state.json');

    // pass 1: the first three words
    const first = harness({ ranks, counter });
    first.deps.stateFile = stateFile;
    expect(await runSeed(['--file', file, '--confirm', '--limit', '3'], first.deps)).toBe(0);
    expect(first.sent.map((s) => s.data.word)).toEqual(tags.slice(0, 3).map(word));

    // the worker's verdicts: rl1 made an entry, rl2 failed on the validator, rl3 on the network
    await createEntry({ tag: L('rl1') });
    await setLatest('rl1', 'succeeded', null);
    await setLatest('rl2', 'failed', 'invalid_output');
    await setLatest('rl3', 'failed', 'upstream_error');

    // dry run
    const dry = harness({ ranks, counter });
    dry.deps.stateFile = stateFile;
    expect(await runSeed(['--file', file, '--retry-last-run'], dry.deps)).toBe(0);
    expect(dry.text()).toContain('Lần gửi gần nhất');
    expect(dry.text()).toContain('3 từ');
    expect(dry.text()).toContain('trong đó GỬI LẠI 2 từ');
    expect(dry.text()).toContain('CHƯA GỬI GÌ');
    expect(dry.boss.send).not.toHaveBeenCalled();

    // for real: only rl2 and rl3 — not rl4, rl5 (new words), not rl1 (has its entry)
    const again = harness({ ranks, counter });
    again.deps.stateFile = stateFile;
    expect(await runSeed(['--file', file, '--retry-last-run', '--confirm'], again.deps)).toBe(0);
    expect(again.sent.map((s) => s.data.word).sort()).toEqual([word('rl2'), word('rl3')].sort());
    expect(readState(stateFile).runs).toHaveLength(2);
    expect(readState(stateFile).runs[1].options.retryLastRun).toBe(true);

    // the history of the old rows is kept, the new rows are the active ones, and no word has two active rows
    const rows = (await pool.query(`SELECT word, status FROM word_enrichment_jobs WHERE word = ANY($1::text[]) ORDER BY word, created_at`, [tags.map(word)])).rows;
    expect(rows.filter((r) => r.word === word('rl2')).map((r) => r.status)).toEqual(['failed', 'queued']);
    expect(rows.filter((r) => r.word === word('rl4'))).toEqual([]);
    const active = (await pool.query(`SELECT word, count(*)::int AS n FROM word_enrichment_jobs WHERE word = ANY($1::text[]) AND status IN ('queued','running') GROUP BY word HAVING count(*) > 1`, [tags.map(word)])).rows;
    expect(active).toEqual([]);

    // the same command again, before the worker has answered: nothing more to send
    const third = harness({ ranks, counter });
    third.deps.stateFile = stateFile;
    expect(await runSeed(['--file', file, '--retry-last-run', '--confirm'], third.deps)).toBe(0);
    expect(third.text()).toContain('Không có từ nào để gửi');
    expect(third.boss.send).not.toHaveBeenCalled();

    // the second answer: rl2 fails on the validator AGAIN (now final), rl3 on the network again (still may pass)
    await setLatest('rl2', 'failed', 'invalid_output');
    await setLatest('rl3', 'failed', 'upstream_error');
    const fourth = harness({ ranks, counter });
    fourth.deps.stateFile = stateFile;
    expect(await runSeed(['--file', file, '--retry-last-run', '--confirm'], fourth.deps)).toBe(0);
    expect(fourth.sent.map((s) => s.data.word)).toEqual([word('rl3')]);
    expect(fourth.text()).toContain('failed / invalid_output (2 lượt)');
  });

  it('--retry-last-run without any earlier run says so, and combined with a selection option is refused', async () => {
    const file = oxfordFile('retrynone', [['rn1', 'A1', 'noun']]);
    const h = harness();
    h.deps.stateFile = path.join(TMP, 'does-not-exist.json');
    expect(await runSeed(['--file', file, '--retry-last-run'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('chưa có lần gửi nào');
    for (const extra of [['--limit', '5'], ['--offset', '1'], ['--sample', '5'], ['--only-cefr', 'A1']]) {
      const x = harness();
      expect(await runSeed(['--file', file, '--retry-last-run', ...extra], x.deps)).toBe(2);
      expect(x.err.join('\n')).toContain('--retry-last-run cannot be combined');
    }
  });
});

describe('--report scoped to the runs from N', () => {
  it('reports only the words of those runs, counts rows per run, explains invalid_output from the worker log, and lists entries that pass the publish rule', async () => {
    const tags = ['sc1', 'sc2', 'sc3', 'sc4'];
    const file = oxfordFile('scoped', tags.map((t, i) => [t, i < 2 ? 'A1' : 'B1', i === 3 ? 'verb' : 'noun'] as [string, string, string]));
    const ranks = Object.fromEntries(tags.map((t, i) => [word(t), i + 1]));
    const stateFile = path.join(TMP, 'scoped-state.json');
    const counter = `${PROVIDER}-scoped`;

    const one = harness({ ranks, counter });
    one.deps.stateFile = stateFile;
    await runSeed(['--file', file, '--confirm', '--limit', '1'], one.deps); // run 1: sc1
    const two = harness({ ranks, counter });
    two.deps.stateFile = stateFile;
    await runSeed(['--file', file, '--confirm', '--limit', '3'], two.deps); // run 2: sc2 sc3 sc4

    // verdicts: sc1 made an entry; sc2 made an entry; sc3 failed on the validator; sc4 made an entry with a blocking note
    const e1 = await createEntry({ tag: L('sc1') });
    const e2 = await createEntry({ tag: L('sc2') });
    const e4 = await createEntry({ tag: L('sc4'), adminNote: `${'[auto] nguồn: wiktionary, haiku · model: m · job: j'} · ghi chú của Haiku: Nghĩa 'phố' và 'dãy nhà' có thể gộp, cần kiểm tra lại.` });
    await pool.query(`UPDATE word_enrichment_jobs SET status = 'succeeded', entry_id = $2, finished_at = NOW() WHERE word = $1 AND status = 'queued'`, [word('sc1'), e1]);
    await pool.query(`UPDATE word_enrichment_jobs SET status = 'succeeded', entry_id = $2, finished_at = NOW() WHERE word = $1 AND status = 'queued'`, [word('sc2'), e2]);
    await pool.query(`UPDATE word_enrichment_jobs SET status = 'succeeded', entry_id = $2, finished_at = NOW() WHERE word = $1 AND status = 'queued'`, [word('sc4'), e4]);
    await pool.query(`UPDATE word_enrichment_jobs SET status = 'failed', reason = 'invalid_output', finished_at = NOW() WHERE word = $1 AND status = 'queued'`, [word('sc3')]);

    const log = path.join(TMP, 'worker.log');
    const sc3Job = (await pool.query(`SELECT id FROM word_enrichment_jobs WHERE word = $1 AND status = 'failed'`, [word('sc3')])).rows[0].id;
    fs.writeFileSync(
      log,
      [
        'Enrichment worker running',
        JSON.stringify({ evt: 'enrich', word: word('sc3'), job_id: sc3Job, output_tokens: 4300, status: 'failed', reason: 'invalid_output', attempt: 1, duration_ms: 9000, issues: [{ path: 'senses[2].meanings_vi[1]', code: 'parenthesis' }], first_issues: [{ path: 'senses[0].examples[1].example_vi', code: 'same_as_english' }, { path: 'senses[2].meanings_vi[1]', code: 'parenthesis' }] }),
        JSON.stringify({ evt: 'enrich', word: word('sc1'), status: 'succeeded', attempt: 1, duration_ms: 8000, stages_ms: { s3_haiku: 6000 } }),
      ].join('\n')
    );

    const h = harness();
    h.deps.stateFile = stateFile;
    const target = path.join(TMP, 'scoped-report.md');
    h.deps.reportFile = target;
    expect(await runSeed(['--file', file, '--report', '--from-run', '2', '--worker-log', log], h.deps)).toBe(0);
    const text = fs.readFileSync(target, 'utf8');

    expect(text).toContain('các lần gửi #2 đến #2');
    expect(text).toContain('Tổng 3 từ đã gửi'); // sc2 sc3 sc4: sc1 belongs to run 1
    expect(text).toMatch(/failed \/ invalid_output \| 1/);
    // why
    expect(text).toContain('*Lần #2* (3 từ): 1 job `invalid_output`');
    expect(text).toContain('Token ra của các job hỏng: trung vị 4,300');
    expect(text).toContain('ở LƯỢT ĐẦU (lần #2, 3 từ) `invalid_output` là 1 (33.3%');
    expect(text).toContain('parenthesis @ senses[].meanings_vi[]'); // indexes taken out
    expect(text).toContain('same_as_english @ senses[].examples[].example_vi');
    // by part of speech: sc3 is a noun, sc4 a verb
    expect(text).toMatch(/\| noun \| 2 \| 1 \| 50\.0% \|/);
    // eligible for the bulk publish: sc2 only (sc4 has a blocking note, sc3 has no entry, sc1 is not in the scope)
    expect(text).toContain('## 10b.');
    expect(text).toContain('1/2 mục từ mới đủ điều kiện');
    expect(text).toContain(word('sc2'));
    expect(text).not.toMatch(new RegExp(`\\| ${word('sc4')} \\|.*\\(noun\\)`));

    // without --from-run it covers every run, with --from-run 3 there is nothing
    expect(await runSeed(['--file', file, '--report', '--worker-log', log], h.deps)).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toContain('Tổng 4 từ đã gửi');
    expect(await runSeed(['--file', file, '--report', '--from-run', '3'], h.deps)).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toContain('Chưa có lần gửi nào');
  });

  it('--from-run without --report is refused', async () => {
    const file = oxfordFile('fromrun', [['fr1', 'A1', 'noun']]);
    const h = harness();
    expect(await runSeed(['--file', file, '--from-run', '2'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('--from-run only goes with --report');
  });
});

describe('sizes', () => {
  it('payloadBytes adds up the data of an entry and of what hangs on it (indexes not included), and is 0 for no entry', async () => {
    const { payloadBytes, measureDb } = await import('../../services/enrichment/oxford/measure');
    expect(await payloadBytes(pool as any, [])).toEqual({ total: 0, perTable: {} });
    expect((await payloadBytes(pool as any, ['00000000-0000-0000-0000-000000000000'])).total).toBe(0);

    const id = await createEntry({ tag: L('sizeOne') });
    const one = await payloadBytes(pool as any, [id]);
    expect(one.perTable.dictionary_entries).toBeGreaterThan(100);
    expect(one.perTable.entry_senses).toBeGreaterThan(0);
    expect(one.perTable.sense_examples).toBeGreaterThan(0);
    expect(one.total).toBe(Object.values(one.perTable).reduce((s, v) => s + v, 0));

    const id2 = await createEntry({ tag: L('sizeTwo') });
    const both = await payloadBytes(pool as any, [id, id2]);
    expect(both.total).toBeGreaterThan(one.total);

    const m = await measureDb(pool as any);
    expect(m.dbBytes).toBeGreaterThan(0);
    expect(Object.keys(m.perTable)).toContain('dictionary_entries');
    expect(m.tableBytes).toBeGreaterThan(0);
  });
});
