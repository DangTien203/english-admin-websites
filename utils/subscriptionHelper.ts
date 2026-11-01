import pool from '../config/db';
import { TtlCache } from './ttlCache';

/**
 * Subscription lookups. They sit on the path of many requests (an ebook page, every call behind requireFeature, the profile, the home
 * dashboard), each of them was 2-5 sequential round trips to the database, and the answer almost never changes: a user's active
 * subscription changes when a payment is approved or cancelled, a plan's features when an admin edits the plan.
 *
 * So the answers are kept in memory (SUBSCRIPTION_CACHE_TTL_MS, default 30 s, per user; PLAN_FEATURES_CACHE_TTL_MS, default 5 min, per
 * plan; 0 turns a cache off) and the code that writes the data drops them: invalidateSubscriptionCache(userId) after a payment is
 * approved / rejected, a subscription is created or cancelled, invalidatePlanCache() after a plan or its features are edited.
 * A change made by another process shows after at most the TTL. Quota USAGE (getUsage) is never cached.
 */

function ttlFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallbackMs;
}

const SUBSCRIPTION_TTL_MS = ttlFromEnv('SUBSCRIPTION_CACHE_TTL_MS', 30_000);
const PLAN_TTL_MS = ttlFromEnv('PLAN_FEATURES_CACHE_TTL_MS', 300_000);

type SubscriptionRow = Record<string, any>;

const activeSubscriptions = new TtlCache<SubscriptionRow | null>({ ttlMs: SUBSCRIPTION_TTL_MS, max: 5000 });
const badges = new TtlCache<string>({ ttlMs: SUBSCRIPTION_TTL_MS, max: 5000 });
const planFeatures = new TtlCache<Record<string, string>>({ ttlMs: PLAN_TTL_MS, max: 100 });
const freePlanFeatures = new TtlCache<Record<string, string>>({ ttlMs: PLAN_TTL_MS, max: 1 });

/** Forget what is known about one user's subscription (or everybody's when no id is given). */
export function invalidateSubscriptionCache(userId?: string | null): void {
  if (userId) {
    activeSubscriptions.delete(userId);
    badges.delete(userId);
  } else {
    activeSubscriptions.clear();
    badges.clear();
  }
}

/** Forget the features of every plan (a plan, its status or its features were edited). */
export function invalidatePlanCache(): void {
  planFeatures.clear();
  freePlanFeatures.clear();
}

// ── Active subscription ───────────────────────────────────────────────────────

export async function getActiveSubscription(userId: string) {
  const row = await activeSubscriptions.getOrLoad(userId, async () => {
    // The expiry UPDATE is housekeeping (it flips the status of periods that ended); the SELECT already ignores them through
    // `current_period_end > NOW()`, so the two do not depend on each other and run together: one round trip instead of two.
    const [, { rows }] = await Promise.all([
      pool.query(
        `UPDATE user_subscriptions
            SET status = 'expired', updated_at = NOW()
          WHERE user_id = $1 AND status = 'active' AND current_period_end < NOW()`,
        [userId]
      ),
      pool.query(
        `SELECT us.*, sp.name AS plan_name, sp.icon_color, sp.description AS plan_description
           FROM user_subscriptions us
           JOIN subscription_plans sp ON sp.id = us.plan_id
          WHERE us.user_id = $1
            AND us.status IN ('active', 'trial')
            AND us.current_period_end > NOW()
          ORDER BY us.created_at DESC
          LIMIT 1`,
        [userId]
      ),
    ]);
    return rows[0] || null;
  });
  return row ? { ...row } : null;
}

// ── Feature map ───────────────────────────────────────────────────────────────

export async function getFeaturesForUser(userId: string): Promise<Record<string, string>> {
  return featuresForSubscription(await getActiveSubscription(userId));
}

/** The feature map of a subscription already in hand (the free plan's features when there is none): no second look-up of the subscription. */
export async function featuresForSubscription(sub: SubscriptionRow | null): Promise<Record<string, string>> {
  const features = sub ? await loadPlanFeatures(sub.plan_id) : await loadFreePlanFeatures();
  return { ...features };
}

async function loadPlanFeatures(planId: string): Promise<Record<string, string>> {
  return planFeatures.getOrLoad(planId, async () => {
    const { rows } = await pool.query(
      `SELECT feature_key, feature_value FROM plan_features WHERE plan_id = $1`,
      [planId]
    );
    return toMap(rows);
  });
}

/** The features of the free plan (the cheapest active one), in one statement: no plan, or a plan without features, gives {}. */
async function loadFreePlanFeatures(): Promise<Record<string, string>> {
  return freePlanFeatures.getOrLoad('free', async () => {
    const { rows } = await pool.query(
      `SELECT pf.feature_key, pf.feature_value
         FROM (SELECT id FROM subscription_plans
                WHERE status = 'active'
                ORDER BY price_monthly ASC, sort_order ASC
                LIMIT 1) p
         JOIN plan_features pf ON pf.plan_id = p.id`
    );
    return toMap(rows);
  });
}

function toMap(rows: Array<{ feature_key: string; feature_value: string }>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of rows) {
    map[r.feature_key] = r.feature_value;
  }
  return map;
}

// ── Usage counters ────────────────────────────────────────────────────────────

export async function getUsage(userId: string, featureKey: string): Promise<number> {
  switch (featureKey) {
    case 'flashcard_max_decks': {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM decks
          WHERE user_id = $1 AND deck_type = 'user_created'`,
        [userId]
      );
      return rows[0].cnt;
    }

    case 'retrieval_practice_daily': {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM retrieval_sessions
          WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
        [userId]
      );
      return rows[0].cnt;
    }

    case 'translation_daily': {
      // translation_cache is keyed by content hash (not per-user).
      // Per-user tracking added in Phase 9 migration.
      return 0;
    }

    default:
      return 0;
  }
}

// ── Subscription badge ────────────────────────────────────────────────────────

export async function computeSubscriptionBadge(userId: string): Promise<string> {
  return badges.getOrLoad(userId, async () => {
    const { rows } = await pool.query(
      `SELECT sp.name
         FROM user_subscriptions us
         JOIN subscription_plans sp ON sp.id = us.plan_id
        WHERE us.user_id = $1
          AND us.status = 'active'
          AND us.current_period_end > NOW()
        LIMIT 1`,
      [userId]
    );
    return rows.length === 0 ? 'FREE' : rows[0].name.toUpperCase();
  });
}

// ── Period end calculator ─────────────────────────────────────────────────────

export function calcPeriodEnd(billingCycle: string, startDate: Date = new Date()): Date {
  const d = new Date(startDate);
  switch (billingCycle) {
    case 'yearly':  d.setFullYear(d.getFullYear() + 1); break;
    case 'weekly':  d.setDate(d.getDate() + 7);          break;
    case 'monthly':
    default:        d.setMonth(d.getMonth() + 1);        break;
  }
  return d;
}
