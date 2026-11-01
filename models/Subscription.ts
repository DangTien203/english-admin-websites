import pool from '../config/db';
import { paginate } from '../helpers/pagination';
import type { PoolClient } from 'pg';
import { fireNotification } from '../services/notificationService';
import { invalidatePlanCache, invalidateSubscriptionCache } from '../utils/subscriptionHelper';
import { invalidatePendingCounts } from '../utils/pendingCounts';

/**
 * The features of a plan as the two parallel arrays that `unnest($2::text[], $3::text[])` takes, without blank keys. A feature key that
 * appears twice keeps its LAST value when `lastWins` (what a loop of "insert … on conflict do update" ends up with); without it both
 * are sent and the unique key (plan_id, feature_key) refuses the second, as the loop of plain inserts did.
 */
function featureArrays(features: any[], lastWins: boolean): { keys: string[]; values: string[] } {
  const clean = features
    .filter((f) => f && f.key && String(f.key).trim())
    .map((f) => ({ key: String(f.key).trim(), value: f.value || '' }));
  const used = lastWins ? [...new Map(clean.map((f) => [f.key, f])).values()] : clean;
  return { keys: used.map((f) => f.key), values: used.map((f) => f.value) };
}

const Subscription = {
  /**
   * Get all plans with their features.
   * Returns each plan with a `.features` array: [{ feature_key, feature_value }]
   */
  async getPlans() {
    // Every plan is listed, so every plan_features row is wanted: the two reads do not depend on each other and run together.
    const [{ rows: plans }, { rows: features }] = await Promise.all([
      pool.query(
        `SELECT sp.*,
                (SELECT COUNT(*)::int FROM user_subscriptions us
                 WHERE us.plan_id = sp.id AND us.status = 'active') AS active_subscribers
         FROM subscription_plans sp
         ORDER BY sp.sort_order ASC, sp.created_at ASC`
      ),
      pool.query(
        `SELECT plan_id, feature_key, feature_value
         FROM plan_features
         ORDER BY feature_key ASC`
      ),
    ]);
    if (plans.length === 0) return [];

    const featureMap: Record<string, any[]> = {};
    for (const f of features) {
      if (!featureMap[f.plan_id]) featureMap[f.plan_id] = [];
      featureMap[f.plan_id].push({ feature_key: f.feature_key, feature_value: f.feature_value });
    }

    return plans.map((p: any) => ({ ...p, features: featureMap[p.id] || [] }));
  },

  /**
   * Get a single plan by id with features. Returns null if not found.
   */
  async getPlanById(id: string) {
    const { rows } = await pool.query(
      `SELECT sp.*,
              (SELECT COUNT(*)::int FROM user_subscriptions us
               WHERE us.plan_id = sp.id AND us.status = 'active') AS active_subscribers
       FROM subscription_plans sp
       WHERE sp.id = $1`,
      [id]
    );
    if (!rows[0]) return null;
    const plan = rows[0];

    const { rows: features } = await pool.query(
      `SELECT feature_key, feature_value FROM plan_features WHERE plan_id = $1 ORDER BY feature_key ASC`,
      [id]
    );
    plan.features = features;
    return plan;
  },

  /**
   * Create a new plan with features and optional payment method links.
   * @param {object} data       - Plan fields
   * @param {Array}  features   - [{ key, value }]
   * @param {Array}  methodIds  - payment_method UUIDs to link
   */
  async createPlan(data: any, features: any[] = [], methodIds: string[] = []) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO subscription_plans
           (name, description, icon_color,
            price_monthly, price_yearly, price_weekly,
            trial_days, promo_price, promo_start, promo_end,
            is_recommended, status, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          data.name,
          data.description || null,
          data.icon_color || null,
          data.price_monthly || 0,
          data.price_yearly || null,
          data.price_weekly || null,
          data.trial_days || 0,
          data.promo_price || null,
          data.promo_start || null,
          data.promo_end || null,
          data.is_recommended ? true : false,
          data.status || 'inactive',
          data.sort_order || 0,
        ]
      );
      const plan = rows[0];

      // One statement per kind of row instead of one per row (each was a round trip to the database).
      const created = featureArrays(features, true);
      if (created.keys.length > 0) {
        await client.query(
          `INSERT INTO plan_features (plan_id, feature_key, feature_value)
           SELECT $1, t.k, t.v FROM unnest($2::text[], $3::text[]) AS t(k, v)
           ON CONFLICT (plan_id, feature_key) DO UPDATE SET feature_value = EXCLUDED.feature_value`,
          [plan.id, created.keys, created.values]
        );
      }

      const methods = methodIds.filter(Boolean);
      if (methods.length > 0) {
        await client.query(
          `INSERT INTO plan_payment_methods (plan_id, payment_method_id)
           SELECT $1, m FROM unnest($2::uuid[]) AS m ON CONFLICT DO NOTHING`,
          [plan.id, methods]
        );
      }

      await client.query('COMMIT');
      invalidatePlanCache();
      return plan;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Update a plan and replace its features and payment method links entirely.
   * @param {string} id
   * @param {object} data
   * @param {Array}  features   - [{ key, value }]
   * @param {Array}  methodIds  - payment_method UUIDs to link
   */
  async updatePlan(id: string, data: any, features: any[] = [], methodIds: string[] = []) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `UPDATE subscription_plans SET
           name           = $1,
           description    = $2,
           icon_color     = $3,
           price_monthly  = $4,
           price_yearly   = $5,
           price_weekly   = $6,
           trial_days     = $7,
           promo_price    = $8,
           promo_start    = $9,
           promo_end      = $10,
           is_recommended = $11,
           status         = $12,
           sort_order     = $13
         WHERE id = $14
         RETURNING *`,
        [
          data.name,
          data.description || null,
          data.icon_color || null,
          data.price_monthly || 0,
          data.price_yearly || null,
          data.price_weekly || null,
          data.trial_days || 0,
          data.promo_price || null,
          data.promo_start || null,
          data.promo_end || null,
          data.is_recommended ? true : false,
          data.status || 'inactive',
          data.sort_order || 0,
          id,
        ]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }

      // Replace features
      await client.query('DELETE FROM plan_features WHERE plan_id = $1', [id]);
      const replaced = featureArrays(features, false);
      if (replaced.keys.length > 0) {
        await client.query(
          `INSERT INTO plan_features (plan_id, feature_key, feature_value)
           SELECT $1, t.k, t.v FROM unnest($2::text[], $3::text[]) AS t(k, v)`,
          [id, replaced.keys, replaced.values]
        );
      }

      // Replace payment method links
      await client.query('DELETE FROM plan_payment_methods WHERE plan_id = $1', [id]);
      const methods = methodIds.filter(Boolean);
      if (methods.length > 0) {
        await client.query(
          `INSERT INTO plan_payment_methods (plan_id, payment_method_id)
           SELECT $1, m FROM unnest($2::uuid[]) AS m ON CONFLICT DO NOTHING`,
          [id, methods]
        );
      }

      await client.query('COMMIT');
      invalidatePlanCache();
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Delete a plan. Throws if there are active subscribers.
   */
  async deletePlan(id: string) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM user_subscriptions WHERE plan_id = $1 AND status = 'active'`,
      [id]
    );
    if (rows[0].cnt > 0) {
      const err: any = new Error('Không thể xóa gói đang có người đăng ký.');
      err.code = 'HAS_ACTIVE_SUBSCRIBERS';
      throw err;
    }
    await pool.query('DELETE FROM subscription_plans WHERE id = $1', [id]);
    invalidatePlanCache();
  },

  /**
   * Get paginated subscribers for a plan, newest first.
   */
  async getSubscribers(planId: string, { page = 1, limit = 20 }: { page?: number; limit?: number } = {}) {
    const query = `
      SELECT us.id, us.billing_cycle, us.price_paid, us.status,
             us.trial_end, us.current_period_start, us.current_period_end, us.cancelled_at,
             us.created_at,
             u.full_name, u.email,
             sp.name AS plan_name
        FROM user_subscriptions us
        JOIN users u ON u.id = us.user_id
        JOIN subscription_plans sp ON sp.id = us.plan_id
       WHERE us.plan_id = $1
       ORDER BY us.created_at DESC
       LIMIT $2 OFFSET $3`;
    const countQuery = `
      SELECT COUNT(*)::int AS count
        FROM user_subscriptions us
       WHERE us.plan_id = $1`;
    return paginate(query, countQuery, [planId], [planId], page, limit);
  },

  /**
   * Get all recent transactions (all plans), paginated, newest first.
   */
  async getRecentTransactions({ page = 1, limit = 20 }: { page?: number; limit?: number } = {}) {
    const query = `
      SELECT t.id, t.type, t.amount, t.payment_method, t.payment_ref, t.status,
             t.created_at,
             u.full_name, u.email,
             sp.name AS plan_name
        FROM transactions t
        JOIN users u ON u.id = t.user_id
        LEFT JOIN user_subscriptions us ON us.id = t.subscription_id
        LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
       ORDER BY t.created_at DESC
       LIMIT $1 OFFSET $2`;
    const countQuery = `SELECT COUNT(*)::int AS count FROM transactions`;
    return paginate(query, countQuery, [], [], page, limit);
  },

  /**
   * Compute high-level stats.
   * Returns { mrr, totalSubscribers, churnRate, pendingTransactions }
   */
  async getStats() {
    // One statement for all four figures (they were four sequential round trips). The per-cycle rows also give the head count.
    const { rows } = await pool.query(`
      SELECT
        COALESCE((SELECT json_agg(json_build_object('billing_cycle', c.billing_cycle, 'total_paid', c.total_paid, 'cnt', c.cnt))
                    FROM (SELECT billing_cycle, SUM(price_paid)::bigint AS total_paid, COUNT(*)::int AS cnt
                            FROM user_subscriptions
                           WHERE status = 'active'
                           GROUP BY billing_cycle) c), '[]'::json)                                    AS by_cycle,
        (SELECT COUNT(*)::int FROM user_subscriptions
          WHERE status = 'cancelled' AND cancelled_at >= NOW() - INTERVAL '30 days')                  AS cancelled_last_30,
        (SELECT COUNT(*)::int FROM transactions WHERE status = 'pending')                             AS pending_transactions`);
    const stats = rows[0];

    let mrr = 0;
    let totalSubscribers = 0;
    for (const r of stats.by_cycle as Array<{ billing_cycle: string | null; total_paid: string | number | null; cnt: number }>) {
      totalSubscribers += r.cnt;
      const paid = Number(r.total_paid) || 0;
      if (r.billing_cycle === 'monthly') mrr += paid;
      else if (r.billing_cycle === 'yearly') mrr += Math.round(paid / 12);
      else if (r.billing_cycle === 'weekly') mrr += Math.round(paid * 4.33);
    }

    const cancelledLast30: number = stats.cancelled_last_30;
    const churnRate = totalSubscribers > 0
      ? Math.round((cancelledLast30 / (totalSubscribers + cancelledLast30)) * 100)
      : 0;

    return { mrr, totalSubscribers, churnRate, pendingTransactions: stats.pending_transactions as number };
  },

  async getPendingTransactionsCount(): Promise<number> {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM transactions WHERE status = 'pending'`
    );
    return rows[0].cnt;
  },

  /**
   * Get transactions with optional filters, paginated.
   */
  async getTransactionsFiltered({
    status = '',
    payment_method = '',
    date_from = '',
    date_to = '',
    page = 1,
    limit = 20,
  }: {
    status?: string;
    payment_method?: string;
    date_from?: string;
    date_to?: string;
    page?: number;
    limit?: number;
  } = {}) {
    const conditions: string[] = [];
    const params: any[] = [];

    if (status) {
      params.push(status);
      conditions.push(`t.status = $${params.length}`);
    }
    if (payment_method) {
      params.push(payment_method);
      conditions.push(`t.payment_method = $${params.length}`);
    }
    if (date_from) {
      params.push(date_from);
      conditions.push(`t.created_at >= $${params.length}`);
    }
    if (date_to) {
      params.push(date_to);
      conditions.push(`t.created_at <= ($${params.length}::date + INTERVAL '1 day')`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT t.id, t.type, t.amount, t.payment_method, t.payment_ref,
             t.status, t.admin_note, t.created_at,
             u.full_name, u.email,
             sp.name AS plan_name,
             us.billing_cycle
        FROM transactions t
        JOIN users u ON u.id = t.user_id
        LEFT JOIN user_subscriptions us ON us.id = t.subscription_id
        LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    const countQuery = `
      SELECT COUNT(*)::int AS count
        FROM transactions t
        LEFT JOIN users u ON u.id = t.user_id
       ${where}`;

    return paginate(query, countQuery, params, params, page, limit);
  },

  /**
   * Get a single transaction with subscription and user info.
   */
  async getTransactionById(id: string) {
    const { rows } = await pool.query(
      `SELECT t.*, u.full_name, u.email,
              us.billing_cycle, us.plan_id,
              sp.name AS plan_name
         FROM transactions t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN user_subscriptions us ON us.id = t.subscription_id
         LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
        WHERE t.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  /**
   * Approve a pending transaction: mark completed, activate subscription.
   */
  async approveTransaction(id: string) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: txRows } = await client.query(
        `SELECT t.*, us.billing_cycle, us.user_id, us.plan_id, sp.name AS plan_name
           FROM transactions t
           LEFT JOIN user_subscriptions us ON us.id = t.subscription_id
           LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
          WHERE t.id = $1`,
        [id]
      );
      if (!txRows[0]) throw Object.assign(new Error('Transaction not found'), { code: 'NOT_FOUND' });

      const tx = txRows[0];

      await client.query(
        `UPDATE transactions SET status = 'completed' WHERE id = $1`,
        [id]
      );

      // Calculate period end based on billing_cycle
      const intervalMap: Record<string, string> = {
        monthly: '1 month',
        yearly:  '1 year',
        weekly:  '7 days',
      };
      const interval = intervalMap[tx.billing_cycle] || '1 month';

      await client.query(
        `UPDATE user_subscriptions
            SET status               = 'active',
                current_period_start = NOW(),
                current_period_end   = NOW() + INTERVAL '${interval}',
                updated_at           = NOW()
          WHERE id = $1`,
        [tx.subscription_id]
      );

      await client.query('COMMIT');
      invalidateSubscriptionCache(tx.user_id); // the user is on the paid plan from the next request on
      invalidatePendingCounts();

      // Notify user — fire-and-forget, post-commit so we never roll back the
      // approval just because notification insert fails.
      if (tx.user_id) {
        fireNotification({
          userId: tx.user_id,
          type: 'subscription_activated',
          title: 'Đăng ký thành công',
          message: `Gói ${tx.plan_name ?? ''} đã được kích hoạt.`.trim(),
          linkUrl: '/subscription/me',
        });
      }

      return tx;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Reject a pending transaction: mark failed with reason, cancel subscription.
   */
  async rejectTransaction(id: string, reason: string) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: txRows } = await client.query(
        `SELECT t.*, us.user_id, us.plan_id, sp.name AS plan_name
           FROM transactions t
           LEFT JOIN user_subscriptions us ON us.id = t.subscription_id
           LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
          WHERE t.id = $1`,
        [id]
      );
      if (!txRows[0]) throw Object.assign(new Error('Transaction not found'), { code: 'NOT_FOUND' });

      const tx = txRows[0];

      await client.query(
        `UPDATE transactions SET status = 'failed', admin_note = $1 WHERE id = $2`,
        [reason || null, id]
      );

      await client.query(
        `UPDATE user_subscriptions
            SET status       = 'cancelled',
                cancelled_at = NOW(),
                updated_at   = NOW()
          WHERE id = $1`,
        [tx.subscription_id]
      );

      await client.query('COMMIT');
      invalidateSubscriptionCache(tx.user_id);
      invalidatePendingCounts();

      // Notify user — include reason so they understand the rejection.
      if (tx.user_id) {
        const planLabel = tx.plan_name ? ` cho gói ${tx.plan_name}` : '';
        const reasonSuffix = reason ? ` Lý do: ${reason}` : '';
        fireNotification({
          userId: tx.user_id,
          type: 'subscription_rejected',
          title: 'Giao dịch bị từ chối',
          message: `Giao dịch${planLabel} đã bị từ chối.${reasonSuffix}`,
          linkUrl: '/subscription/transactions',
        });
      }

      return tx;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Save features for a plan (used by the standalone features editor).
   */
  async savePlanFeatures(planId: string, features: Array<{ key: string; value: string }>) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM plan_features WHERE plan_id = $1', [planId]);
      const saved = featureArrays(features, false);
      if (saved.keys.length > 0) {
        await client.query(
          `INSERT INTO plan_features (plan_id, feature_key, feature_value)
           SELECT $1, t.k, t.v FROM unnest($2::text[], $3::text[]) AS t(k, v)`,
          [planId, saved.keys, saved.values]
        );
      }
      await client.query('COMMIT');
      invalidatePlanCache();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

export = Subscription;
