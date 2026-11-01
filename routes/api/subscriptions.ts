import { Router, Response } from 'express';
import { z } from 'zod';
import NodeCache from 'node-cache';
import pool from '../../config/db';
import { ApiRequest, requireApiAuth, optionalApiAuth } from '../../middlewares/apiAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { apiSuccess, apiError } from '../../utils/apiResponse';
import { validateBody } from '../../middlewares/validateBody';
import { validatePaymentMethodConfig } from '../../utils/paymentMethodValidator';
import {
  getActiveSubscription,
  featuresForSubscription,
  getUsage,
  calcPeriodEnd,
  invalidateSubscriptionCache,
} from '../../utils/subscriptionHelper';
import { invalidatePendingCounts } from '../../utils/pendingCounts';

const router = Router();

// ── In-memory plan cache (5 min TTL) ─────────────────────────────────────────
const planCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const CACHE_KEY_ALL = 'plans:all';
const CACHE_KEY_ID  = (id: string) => `plan:${id}`;

// ── Helper: load plans with features + active payment_methods from DB ─────────

async function loadPlansFromDb(activeOnly = true) {
  const where = activeOnly ? `WHERE sp.status = 'active'` : '';
  const { rows: plans } = await pool.query(
    `SELECT sp.id, sp.name, sp.description, sp.icon_color,
            sp.price_monthly, sp.price_yearly, sp.price_weekly,
            sp.trial_days, sp.promo_price, sp.promo_start, sp.promo_end,
            sp.is_recommended, sp.status, sp.sort_order
       FROM subscription_plans sp
      ${where}
      ORDER BY sp.sort_order ASC, sp.created_at ASC`
  );
  if (plans.length === 0) return [];

  const planIds = plans.map((p: any) => p.id);

  const [featuresRes, methodsRes] = await Promise.all([
    pool.query(
      `SELECT plan_id, feature_key, feature_value
         FROM plan_features
        WHERE plan_id = ANY($1::uuid[])
        ORDER BY feature_key ASC`,
      [planIds]
    ),
    pool.query(
      `SELECT ppm.plan_id,
              pm.id, pm.code, pm.display_name, pm.logo_url,
              pm.method_type,
              COALESCE(pm.fee_percent, 0) AS fee_percent
         FROM plan_payment_methods ppm
         JOIN payment_methods pm ON pm.id = ppm.payment_method_id
        WHERE ppm.plan_id = ANY($1::uuid[])
          AND pm.is_active = TRUE
        ORDER BY pm.sort_order ASC`,
      [planIds]
    ),
  ]);

  const featureMap: Record<string, any[]> = {};
  for (const f of featuresRes.rows) {
    if (!featureMap[f.plan_id]) featureMap[f.plan_id] = [];
    featureMap[f.plan_id].push({ key: f.feature_key, value: f.feature_value });
  }

  const methodMap: Record<string, any[]> = {};
  for (const m of methodsRes.rows) {
    if (!methodMap[m.plan_id]) methodMap[m.plan_id] = [];
    methodMap[m.plan_id].push({
      id:           m.id,
      code:         m.code,
      display_name: m.display_name,
      logo_url:     m.logo_url ?? null,
      method_type:  m.method_type,
      fee_percent:  Number(m.fee_percent ?? 0),
    });
  }

  return plans.map((p: any) => ({
    ...p,
    price_monthly: Number(p.price_monthly ?? 0),
    price_yearly:  Number(p.price_yearly  ?? 0),
    price_weekly:  Number(p.price_weekly  ?? 0),
    trial_days:    Number(p.trial_days    ?? 0),
    sort_order:    Number(p.sort_order    ?? 0),
    promo_price:   p.promo_price != null ? Number(p.promo_price) : null,
    features:        featureMap[p.id] || [],
    payment_methods: methodMap[p.id]  || [],
  }));
}

// ── GET /api/v1/subscriptions/plans  (public) ─────────────────────────────────

router.get(
  '/plans',
  optionalApiAuth,
  asyncHandler(async (_req: ApiRequest, res: Response) => {
    let plans = planCache.get<any[]>(CACHE_KEY_ALL);
    if (!plans) {
      plans = await loadPlansFromDb(true);
      planCache.set(CACHE_KEY_ALL, plans);
    }
    return apiSuccess(res, plans);
  })
);

// ── GET /api/v1/subscriptions/plans/:id  (public) ────────────────────────────

router.get(
  '/plans/:id',
  optionalApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const { id } = req.params as { id: string };
    let plan = planCache.get<any>(CACHE_KEY_ID(id));
    if (!plan) {
      const allPlans = await loadPlansFromDb(false);
      plan = allPlans.find((p: any) => p.id === id) || null;
      if (plan) planCache.set(CACHE_KEY_ID(id), plan);
    }
    if (!plan) {
      return apiError(res, 404, 'NOT_FOUND', 'Plan không tồn tại');
    }
    return apiSuccess(res, plan);
  })
);

// ── GET /api/v1/subscriptions/me  (auth) ─────────────────────────────────────

router.get(
  '/me',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;

    const sub = await getActiveSubscription(userId);

    // The feature map and the current plan only need the subscription, so they are read together; the usage counters need the
    // feature keys and are read together too (they were one query after another).
    const [features, currentPlan] = await Promise.all([
      featuresForSubscription(sub),
      loadCurrentPlan(sub?.plan_id ?? null),
    ]);

    // Usage for all feature keys — always a number, never null
    const keys = Object.keys(features);
    const usages = await Promise.all(keys.map((key) => getUsage(userId, key)));
    const usageMap: Record<string, number> = {};
    keys.forEach((key, i) => {
      usageMap[key] = Number(usages[i] ?? 0);
    });

    return apiSuccess(res, {
      current_plan: currentPlan,
      subscription: sub
        ? {
            id:                   sub.id,
            status:               sub.status,
            billing_cycle:        sub.billing_cycle,
            current_period_start: sub.current_period_start,
            current_period_end:   sub.current_period_end,
            cancelled_at:         sub.cancelled_at,
            trial_end:            sub.trial_end,
          }
        : null,
      features,
      usage: usageMap,
    });
  })
);

/** The plan card for GET /subscriptions/me: from the plan cache when it is warm, else one read. Null without a subscription. */
async function loadCurrentPlan(planId: string | null) {
  if (!planId) return null;
  const cached = planCache.get<any>(CACHE_KEY_ID(planId));
  if (cached) return cached;

  const { rows } = await pool.query(
    `SELECT id, name, description, icon_color,
            price_monthly, price_yearly, price_weekly,
            trial_days, promo_price, is_recommended, sort_order
       FROM subscription_plans WHERE id = $1`,
    [planId]
  );
  if (!rows[0]) return null;
  const p = rows[0];
  return {
    id:            p.id,
    name:          p.name,
    description:   p.description   ?? null,
    icon_color:    p.icon_color     ?? null,
    price_monthly: Number(p.price_monthly ?? 0),
    price_yearly:  Number(p.price_yearly  ?? 0),
    price_weekly:  Number(p.price_weekly  ?? 0),
    trial_days:    Number(p.trial_days    ?? 0),
    promo_price:   p.promo_price != null ? Number(p.promo_price) : null,
    is_recommended: Boolean(p.is_recommended),
    sort_order:    Number(p.sort_order ?? 0),
  };
}

// ── Checkout schemas ──────────────────────────────────────────────────────────

const VALID_CYCLES = ['monthly', 'yearly', 'weekly'] as const;

const previewSchema = z.object({
  plan_id:             z.string().uuid(),
  billing_cycle:       z.enum(VALID_CYCLES),
  payment_method_code: z.string().min(1).max(30),
});

const confirmSchema = z.object({
  plan_id:             z.string().uuid(),
  billing_cycle:       z.enum(VALID_CYCLES),
  payment_method_code: z.string().min(1).max(30),
  payment_ref:         z.string().max(255).optional(),
  amount_paid:         z.number().int().min(0),
});

// ── POST /api/v1/subscriptions/checkout/preview  (auth) ──────────────────────

router.post(
  '/checkout/preview',
  requireApiAuth,
  validateBody(previewSchema),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { plan_id, billing_cycle, payment_method_code } = req.body;

    // Validate plan
    const { rows: planRows } = await pool.query(
      `SELECT * FROM subscription_plans WHERE id = $1 AND status = 'active'`,
      [plan_id]
    );
    if (!planRows[0]) {
      return apiError(res, 404, 'NOT_FOUND', 'Plan không tồn tại hoặc không active');
    }
    const plan = planRows[0];

    // Validate payment method — must be active and linked to this plan
    const { rows: pmRows } = await pool.query(
      `SELECT pm.*
         FROM payment_methods pm
         JOIN plan_payment_methods ppm ON ppm.payment_method_id = pm.id
        WHERE pm.code = $1 AND pm.is_active = TRUE AND ppm.plan_id = $2`,
      [payment_method_code, plan_id]
    );
    if (!pmRows[0]) {
      return apiError(res, 400, 'PAYMENT_METHOD_NOT_AVAILABLE',
        'Phương thức thanh toán không hợp lệ hoặc không được chấp nhận cho gói này');
    }
    const pm = pmRows[0];

    // Safety net: reject if method is active but config incomplete
    const pmValidation = validatePaymentMethodConfig(pm);
    if (!pmValidation.is_valid) {
      return apiError(res, 400, 'PAYMENT_METHOD_NOT_CONFIGURED',
        'Phương thức thanh toán này tạm thời không khả dụng',
        { missing_fields: pmValidation.missing_fields });
    }

    // Pricing — all numbers, never null
    const priceField: Record<string, string> = {
      monthly: 'price_monthly',
      yearly:  'price_yearly',
      weekly:  'price_weekly',
    };
    const basePrice = Number(plan[priceField[billing_cycle]] ?? 0);

    let promoDiscount = 0;
    if (plan.promo_price != null) {
      const now        = new Date();
      const promoStart = plan.promo_start ? new Date(plan.promo_start) : null;
      const promoEnd   = plan.promo_end   ? new Date(plan.promo_end)   : null;
      if ((!promoStart || now >= promoStart) && (!promoEnd || now <= promoEnd)) {
        promoDiscount = Math.max(0, basePrice - Number(plan.promo_price));
      }
    }

    const feePercent  = Number(pm.fee_percent ?? 0);
    const feeAmount   = Math.round((basePrice - promoDiscount) * feePercent / 100);
    const totalAmount = basePrice - promoDiscount + feeAmount;

    // Transfer content
    const shortId         = userId.replace(/-/g, '').substring(0, 8).toUpperCase();
    const transferContent = `EL_${shortId}_${Date.now()}`;

    // Payment instructions — structured per method_type
    const info = pm.account_info ?? {};
    let paymentInstructions: Record<string, any>;

    switch (pm.method_type) {
      case 'bank':
        paymentInstructions = {
          type: 'bank_transfer',
          account_info: {
            account_number: info.account_number ?? '',
            account_name:   info.account_name   ?? '',
            bank_name:      info.bank_name       ?? '',
            swift_code:     info.swift_code      ?? null,
            branch:         info.branch          ?? null,
          },
          transfer_content: transferContent,
          amount:           totalAmount,
          instructions_vi:  pm.instructions_vi ?? null,
          instructions_en:  pm.instructions_en ?? null,
        };
        break;

      case 'ewallet':
        paymentInstructions = {
          type:             'qr_code',
          qr_image_url:     info.qr_image_url ?? null,
          phone_number:     info.phone_number ?? null,
          account_name:     info.account_name ?? null,
          transfer_content: transferContent,
          amount:           totalAmount,
          instructions_vi:  pm.instructions_vi ?? null,
          instructions_en:  pm.instructions_en ?? null,
        };
        break;

      case 'card':
      case 'international':
        paymentInstructions = {
          type:         'redirect',
          redirect_url: null,
          amount:       totalAmount,
        };
        break;

      default:
        paymentInstructions = {
          type:             'manual',
          transfer_content: transferContent,
          amount:           totalAmount,
          instructions_vi:  pm.instructions_vi ?? null,
          instructions_en:  pm.instructions_en ?? null,
        };
    }

    return apiSuccess(res, {
      plan_id,
      plan_name:    plan.name,
      billing_cycle,
      pricing: {
        base_price:     basePrice,
        promo_discount: promoDiscount,
        fee_amount:     feeAmount,
        total_amount:   totalAmount,
      },
      payment_method: {
        code:         pm.code,
        display_name: pm.display_name,
        logo_url:     pm.logo_url ?? null,
        method_type:  pm.method_type,
        fee_percent:  feePercent,
      },
      payment_instructions: paymentInstructions,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  })
);

// ── POST /api/v1/subscriptions/checkout/confirm  (auth) ──────────────────────

router.post(
  '/checkout/confirm',
  requireApiAuth,
  validateBody(confirmSchema),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { plan_id, billing_cycle, payment_method_code, payment_ref, amount_paid } = req.body;

    // Check for existing active/pending subscription
    const { rows: existing } = await pool.query(
      `SELECT id FROM user_subscriptions
        WHERE user_id = $1 AND status IN ('active','trial','pending_payment')
          AND current_period_end > NOW()`,
      [userId]
    );
    if (existing.length > 0) {
      return apiError(res, 409, 'ALREADY_SUBSCRIBED',
        'Bạn đã có subscription đang hoạt động. Hãy cancel trước khi đăng ký mới.');
    }

    // Validate plan
    const { rows: planRows } = await pool.query(
      `SELECT id FROM subscription_plans WHERE id = $1 AND status = 'active'`,
      [plan_id]
    );
    if (!planRows[0]) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'Plan không hợp lệ hoặc không active');
    }

    // Validate payment method — active + linked to plan + configured
    const { rows: pmRows } = await pool.query(
      `SELECT pm.*
         FROM payment_methods pm
         JOIN plan_payment_methods ppm ON ppm.payment_method_id = pm.id
        WHERE pm.code = $1 AND pm.is_active = TRUE AND ppm.plan_id = $2`,
      [payment_method_code, plan_id]
    );
    if (!pmRows[0]) {
      return apiError(res, 400, 'PAYMENT_METHOD_NOT_AVAILABLE',
        'Phương thức thanh toán không hợp lệ hoặc không được chấp nhận cho gói này');
    }
    const pm = pmRows[0];
    const pmValidation = validatePaymentMethodConfig(pm);
    if (!pmValidation.is_valid) {
      return apiError(res, 400, 'PAYMENT_METHOD_NOT_CONFIGURED',
        'Phương thức thanh toán này tạm thời không khả dụng');
    }

    const periodStart = new Date();
    const periodEnd   = calcPeriodEnd(billing_cycle, periodStart);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: subRows } = await client.query(
        `INSERT INTO user_subscriptions
           (user_id, plan_id, billing_cycle, price_paid, status,
            current_period_start, current_period_end)
         VALUES ($1,$2,$3,$4,'pending_payment',$5,$6)
         RETURNING id`,
        [userId, plan_id, billing_cycle, amount_paid, periodStart, periodEnd]
      );
      const subscriptionId = subRows[0].id;

      const { rows: txRows } = await client.query(
        `INSERT INTO transactions
           (user_id, subscription_id, type, amount, payment_method, payment_ref, status)
         VALUES ($1,$2,'new',$3,$4,$5,'pending')
         RETURNING id`,
        [userId, subscriptionId, amount_paid, payment_method_code, payment_ref || null]
      );
      const transactionId = txRows[0].id;

      // Notify super_admins
      const { rows: adminRows } = await client.query(
        `SELECT id FROM admin_accounts WHERE role = 'super_admin'`
      );
      const userEmail = req.user!.email;
      for (const admin of adminRows) {
        await client.query(
          `INSERT INTO notifications (admin_id, type, title, message, link_url)
           VALUES ($1, 'payment_pending_review', 'Thanh toán chờ duyệt', $2, '/subscriptions/transactions')`,
          [admin.id, `User ${userEmail} vừa thanh toán, cần xác nhận`]
        );
      }

      await client.query('COMMIT');
      invalidateSubscriptionCache(userId);
      invalidatePendingCounts(); // a payment now waits for the super admins

      return apiSuccess(res, {
        subscription_id: subscriptionId,
        transaction_id:  transactionId,
        status:          'pending_payment',
        message:         'Đơn hàng đã tạo. Vui lòng hoàn tất thanh toán và chờ admin xác nhận.',
      }, 'Checkout thành công');

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

// ── POST /api/v1/subscriptions/cancel  (auth) ────────────────────────────────

router.post(
  '/cancel',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;

    const { rows } = await pool.query(
      `UPDATE user_subscriptions
          SET cancelled_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND status = 'active' AND cancelled_at IS NULL
        RETURNING id`,
      [userId]
    );

    if (rows.length === 0) {
      return apiError(res, 404, 'NOT_FOUND', 'Không tìm thấy subscription active để cancel');
    }
    invalidateSubscriptionCache(userId);

    return res.status(204).send();
  })
);

// ── GET /api/v1/subscriptions/transactions  (auth) ───────────────────────────

router.get(
  '/transactions',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const page   = Math.max(1, parseInt(String(req.query.page))  || 1);
    const limit  = Math.max(1, parseInt(String(req.query.limit)) || 20);
    const offset = (page - 1) * limit;

    const statusFilter = typeof req.query.status === 'string' && req.query.status
      ? req.query.status
      : null;

    const conditions = ['t.user_id = $1'];
    const params: any[] = [userId];

    if (statusFilter) {
      params.push(statusFilter);
      conditions.push(`t.status = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT t.id, t.type, COALESCE(t.amount, 0) AS amount,
                t.payment_method, t.payment_ref,
                t.status, t.created_at,
                sp.name AS plan_name,
                pm.display_name AS payment_method_display,
                pm.logo_url     AS payment_method_logo,
                pm.code         AS payment_method_code,
                pm.method_type  AS payment_method_type
           FROM transactions t
           LEFT JOIN user_subscriptions us ON us.id = t.subscription_id
           LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
           LEFT JOIN payment_methods pm ON pm.code = t.payment_method
          ${where}
          ORDER BY t.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM transactions t ${where}`,
        params
      ),
    ]);

    const total = countRes.rows[0].count;

    const items = dataRes.rows.map((r: any) => ({
      id:           r.id,
      type:         r.type,
      plan_name:    r.plan_name ?? null,
      amount:       Number(r.amount),
      payment_method: {
        code:         r.payment_method_code || r.payment_method,
        display_name: r.payment_method_display || r.payment_method,
        logo_url:     r.payment_method_logo  ?? null,
        method_type:  r.payment_method_type  ?? null,
      },
      status:      r.status,
      payment_ref: r.payment_ref ?? null,
      created_at:  r.created_at,
    }));

    return apiSuccess(res, { items, total, page, limit });
  })
);

export default router;
