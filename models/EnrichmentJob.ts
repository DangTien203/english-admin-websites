/**
 * word_enrichment_jobs — the ledger of background dictionary-enrichment jobs (docs/lookup-spec.md §2,
 * lifecycle in docs/lookup-queue.md). Thin query wrappers; every function takes the connection to use
 * (pg.Pool, or a PoolClient when it must run inside a transaction).
 */

export interface EnrichmentJobDb {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export type EnrichmentJobStatus = 'queued' | 'running' | 'succeeded' | 'rejected' | 'failed' | 'skipped';

export interface EnrichmentJobRow {
  id: string;
  word: string;
  status: EnrichmentJobStatus;
  reason: string | null;
  attempts: number;
  entry_id: string | null;
  requested_by: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export interface FinishFields {
  status: Exclude<EnrichmentJobStatus, 'queued' | 'running'>;
  reason?: string | null;
  entryId?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Inserts a `queued` row. ON CONFLICT on the partial unique index (one queued / running row per word)
 * makes a parallel enqueue lose quietly: returns null instead of throwing.
 * An unknown requestedBy (deleted user) is stored as NULL rather than failing the foreign key.
 */
export async function insertQueued(db: EnrichmentJobDb, input: { word: string; requestedBy: string | null }): Promise<string | null> {
  const { rows } = await db.query(
    `INSERT INTO word_enrichment_jobs (word, status, requested_by)
     VALUES ($1, 'queued', (SELECT id FROM users WHERE id = $2::uuid))
     ON CONFLICT (word) WHERE status IN ('queued', 'running') DO NOTHING
     RETURNING id`,
    [input.word, input.requestedBy]
  );
  return rows[0]?.id ?? null;
}

/** Re-creates the row of a pg-boss job whose row has disappeared, under the SAME id. Null = a row for this word is already active. */
export async function recreateQueued(db: EnrichmentJobDb, input: { id: string; word: string; requestedBy: string | null }): Promise<EnrichmentJobRow | null> {
  const { rows } = await db.query(
    `INSERT INTO word_enrichment_jobs (id, word, status, requested_by)
     VALUES ($1, $2, 'queued', (SELECT id FROM users WHERE id = $3::uuid))
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [input.id, input.word, input.requestedBy]
  );
  return rows[0] ?? null;
}

export async function findById(db: EnrichmentJobDb, id: string): Promise<EnrichmentJobRow | null> {
  const { rows } = await db.query(`SELECT * FROM word_enrichment_jobs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Is a queued / running row present for this word? */
export async function hasActiveForWord(db: EnrichmentJobDb, word: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM word_enrichment_jobs WHERE word = $1 AND status IN ('queued', 'running') LIMIT 1`,
    [word]
  );
  return rows.length > 0;
}

/**
 * Worker picked the job up: running, attempts + 1. Works on any current status (a row that was
 * wrongly reconciled to failed is revived); throws 23505 when ANOTHER active row of the word exists.
 */
export async function markRunning(db: EnrichmentJobDb, id: string): Promise<EnrichmentJobRow | null> {
  const { rows } = await db.query(
    `UPDATE word_enrichment_jobs
        SET status = 'running', attempts = attempts + 1, reason = NULL, finished_at = NULL
      WHERE id = $1
      RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}

/** Back to the queue, keeping `attempts`. Only touches an active row: a terminal status is never revived here. */
export async function markQueued(db: EnrichmentJobDb, id: string, reason: string | null): Promise<void> {
  await db.query(
    `UPDATE word_enrichment_jobs
        SET status = 'queued', reason = $2, finished_at = NULL
      WHERE id = $1 AND status IN ('queued', 'running')`,
    [id, reason]
  );
}

/** Terminal outcome (also used to overwrite a stale / reconciled status with the real result). */
export async function finish(db: EnrichmentJobDb, id: string, f: FinishFields): Promise<void> {
  await db.query(
    `UPDATE word_enrichment_jobs
        SET status = $2, reason = $3, entry_id = $4, model = $5, input_tokens = $6, output_tokens = $7,
            finished_at = NOW()
      WHERE id = $1`,
    [id, f.status, f.reason ?? null, f.entryId ?? null, f.model ?? null, f.inputTokens ?? null, f.outputTokens ?? null]
  );
}

/** failed + reason, only when the row is still queued / running. Returns whether a row changed. */
export async function failIfActive(db: EnrichmentJobDb, id: string, reason: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE word_enrichment_jobs
        SET status = 'failed', reason = $2, finished_at = NOW()
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING id`,
    [id, reason]
  );
  return rows.length > 0;
}

/** skipped + reason, only when the row is still queued / running. Returns whether a row changed. */
export async function skipIfActive(db: EnrichmentJobDb, id: string, reason: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE word_enrichment_jobs
        SET status = 'skipped', reason = $2, finished_at = NOW()
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING id`,
    [id, reason]
  );
  return rows.length > 0;
}

/** Rows whose worker went away (shutdown): running → queued. Returns the ids that changed. */
export async function requeueRunning(db: EnrichmentJobDb, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query(
    `UPDATE word_enrichment_jobs
        SET status = 'queued', reason = NULL, finished_at = NULL
      WHERE id = ANY($1::uuid[]) AND status = 'running'
      RETURNING id`,
    [ids]
  );
  return rows.map((r) => r.id);
}

/**
 * queued / running rows not touched for `minutes` (candidates for reconcileStaleJobs).
 * `wordPrefix` narrows the scan to words starting with it (plain prefix, no wildcards).
 */
export async function findActiveOlderThan(db: EnrichmentJobDb, minutes: number, wordPrefix?: string): Promise<EnrichmentJobRow[]> {
  const { rows } = await db.query(
    `SELECT * FROM word_enrichment_jobs
      WHERE status IN ('queued', 'running') AND updated_at < NOW() - make_interval(mins => $1::int)
        AND ($2::text IS NULL OR starts_with(word, $2::text))
      ORDER BY updated_at ASC`,
    [minutes, wordPrefix ?? null]
  );
  return rows;
}

export async function listRecent(db: EnrichmentJobDb, opts: { word?: string; limit: number }): Promise<EnrichmentJobRow[]> {
  const params: any[] = [];
  let where = '';
  if (opts.word) {
    params.push(opts.word);
    where = `WHERE word = $${params.length}`;
  }
  params.push(opts.limit);
  const { rows } = await db.query(
    `SELECT * FROM word_enrichment_jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

export async function countByStatus(db: EnrichmentJobDb): Promise<Record<string, number>> {
  const { rows } = await db.query(`SELECT status, COUNT(*)::int AS n FROM word_enrichment_jobs GROUP BY status`);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
