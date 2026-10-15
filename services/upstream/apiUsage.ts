/**
 * Atomic usage counters backed by the api_usage_counters table (migration 33).
 *
 * Keys are (provider, period, unit):
 *   google_translate · 'YYYY-MM'      · chars
 *   enrichment       · 'YYYY-MM-DD'   · jobs
 *   anthropic        · 'YYYY-MM'      · input_tokens | output_tokens   (enrichment job; input includes cache writes and reads)
 *   anthropic_fast   · 'YYYY-MM-DD'   · input_tokens | output_tokens   (lookup fast path)
 * Periods are always UTC so every server instance agrees on the boundary.
 */

export interface UsageDb {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export type UsagePeriodKind = 'month' | 'day';

/** UTC period key: 'YYYY-MM' or 'YYYY-MM-DD'. */
export function currentPeriod(kind: UsagePeriodKind, now: Date = new Date()): string {
  const iso = now.toISOString(); // always UTC
  return kind === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

export class ApiUsage {
  constructor(private readonly db: UsageDb) {}

  /**
   * Atomically reserves `amount` units if the new total stays <= `limit`.
   * Returns true when reserved, false when it would exceed the limit (nothing is written then).
   *
   * One statement, no read-then-write race: the conflict branch only updates when
   * used + amount <= limit, evaluated on the locked row.
   */
  async reserve(provider: string, unit: string, period: string, amount: number, limit: number): Promise<boolean> {
    assertAmount(amount);
    if (amount === 0) return true;
    // A fresh row skips the conflict branch, so a single request larger than the limit must be refused here.
    if (amount > limit) return false;

    const { rows } = await this.db.query(
      `INSERT INTO api_usage_counters (provider, period, unit, used)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, period, unit) DO UPDATE
         SET used = api_usage_counters.used + EXCLUDED.used,
             updated_at = NOW()
         WHERE api_usage_counters.used + EXCLUDED.used <= $5
       RETURNING used`,
      [provider, period, unit, amount, limit]
    );
    return rows.length > 0;
  }

  /** Adds usage that is only known after the fact (e.g. tokens). No limit check. */
  async add(provider: string, unit: string, period: string, amount: number): Promise<void> {
    assertAmount(amount);
    if (amount === 0) return;
    await this.db.query(
      `INSERT INTO api_usage_counters (provider, period, unit, used)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, period, unit) DO UPDATE
         SET used = api_usage_counters.used + EXCLUDED.used,
             updated_at = NOW()`,
      [provider, period, unit, amount]
    );
  }

  /** Gives back a reservation (call failed before the provider processed it). Never goes below 0. */
  async release(provider: string, unit: string, period: string, amount: number): Promise<void> {
    assertAmount(amount);
    if (amount === 0) return;
    await this.db.query(
      `UPDATE api_usage_counters
          SET used = GREATEST(used - $4, 0), updated_at = NOW()
        WHERE provider = $1 AND period = $2 AND unit = $3`,
      [provider, period, unit, amount]
    );
  }

  async getUsed(provider: string, unit: string, period: string): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT used FROM api_usage_counters WHERE provider = $1 AND period = $2 AND unit = $3`,
      [provider, period, unit]
    );
    // BIGINT arrives as a string from node-postgres.
    return rows.length > 0 ? Number(rows[0].used) : 0;
  }
}

function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError('usage amount must be a non-negative integer');
  }
}
