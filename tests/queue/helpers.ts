import type { BossSender, TxClient, TxPool, UsageLedger } from '../../services/queue/pgBossEnqueuer';

/**
 * Fake database + pg-boss + usage ledger for the enqueuer unit tests. Every statement the enqueuer issues
 * is recognized by a fragment of its SQL, and `events` records the order things happened in.
 */
export interface FakeOptions {
  /** hasActiveForWord → a queued / running row exists */
  activeRow?: boolean;
  /** dictionary_entries / word_forms already has the word */
  entryExists?: boolean;
  /** ApiUsage.reserve result */
  capAvailable?: boolean;
  /** insertQueued loses the unique-index race (returns no row) */
  insertConflict?: boolean;
  /** boss.send result: id, null (pg-boss already has a job) or an Error to throw */
  sendResult?: string | null | Error;
  /** make the transaction's ROLLBACK fail */
  rollbackFails?: boolean;
  /** make getBoss() fail */
  getBossFails?: boolean;
}

export function makeEnqueuerFakes(opts: FakeOptions = {}) {
  const events: string[] = [];
  const poolSql: Array<{ sql: string; params?: any[] }> = [];
  const clientSql: Array<{ sql: string; params?: any[] }> = [];

  const client: TxClient & { query: jest.Mock; release: jest.Mock } = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      clientSql.push({ sql, params });
      const s = sql.trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
        events.push(s);
        if (s === 'ROLLBACK' && opts.rollbackFails) throw new Error('rollback failed');
        return { rows: [] };
      }
      if (s.startsWith('INSERT INTO word_enrichment_jobs (word, status, requested_by)')) {
        events.push('insert_row');
        return { rows: opts.insertConflict ? [] : [{ id: 'row-1' }] };
      }
      if (s.startsWith('UPDATE word_enrichment_jobs')) {
        events.push(`update_row:${params?.[1]}:${params?.[2]}`);
        return { rows: [] };
      }
      if (s === 'SELECT 1') return { rows: [] };
      throw new Error('client: unexpected SQL ' + s.slice(0, 80));
    }),
    release: jest.fn(),
  };

  const pool: TxPool & { query: jest.Mock; connect: jest.Mock } = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      poolSql.push({ sql, params });
      const s = sql.trim();
      if (s.startsWith('SELECT 1 FROM word_enrichment_jobs')) return { rows: opts.activeRow ? [{ '?column?': 1 }] : [] };
      if (s.includes('AS found')) return { rows: [{ found: Boolean(opts.entryExists) }] };
      if (s.startsWith('INSERT INTO word_enrichment_jobs (word, status, reason')) {
        events.push(`audit:${params?.[0]}`);
        return { rows: [] };
      }
      throw new Error('pool: unexpected SQL ' + s.slice(0, 80));
    }),
    connect: jest.fn(async () => {
      events.push('connect');
      return client;
    }),
  };

  const send = jest.fn(async (_name: string, _data: object, _options?: Record<string, unknown>) => {
    events.push('send');
    const r = opts.sendResult === undefined ? 'boss-job-1' : opts.sendResult;
    if (r instanceof Error) throw r;
    return r;
  });
  const boss: BossSender = { send };
  const getBoss = jest.fn(async () => {
    events.push('getBoss');
    if (opts.getBossFails) throw new Error('pg-boss is down');
    return boss;
  });

  const usage = {
    reserve: jest.fn(async (..._args: any[]) => {
      events.push('reserve');
      return opts.capAvailable ?? true;
    }),
    release: jest.fn(async (..._args: any[]) => {
      events.push('release');
    }),
  } as unknown as UsageLedger & { reserve: jest.Mock; release: jest.Mock };
  const usageFor = jest.fn((_db: unknown) => usage);

  return { events, pool, client, poolSql, clientSql, send, getBoss, usage, usageFor };
}
