import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const EMAIL_PREFIX = `sub-test-${TS}-`;

let token = '';
let userId = '';

// Test plan with quota limit
let testPlanId = '';
let testSubId = '';
let testPmId = '';

// Deck IDs for quota test
let deck1Id = '';
let deck2Id = '';

// Checkout flow state
let checkoutPlanId = '';
let checkoutPmId = '';
let checkoutTxId = '';
let checkoutSubId = '';

// Extra PMs for error-case tests
let inactivePmId = '';
let unconfigPmId = '';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Register test user
  const reg = await request(app).post('/api/v1/auth/register').send({
    email:     `${EMAIL_PREFIX}u@example.com`,
    password:  'password123',
    full_name: 'Sub Tester',
  });
  if (reg.status !== 201) throw new Error(`Register failed: ${JSON.stringify(reg.body)}`);
  token  = reg.body.data.access_token;
  userId = reg.body.data.user.id;

  // ── Plan with flashcard_max_decks: 2 (for quota test) ──
  const { rows: planRows } = await pool.query(
    `INSERT INTO subscription_plans
       (name, description, price_monthly, status, sort_order)
     VALUES ($1, 'Test quota plan', 0, 'active', 99)
     RETURNING id`,
    [`TestQuota-${TS}`]
  );
  testPlanId = planRows[0].id;

  await pool.query(
    `INSERT INTO plan_features (plan_id, feature_key, feature_value)
     VALUES ($1, 'flashcard_max_decks', '2')`,
    [testPlanId]
  );

  // Assign user to this plan (active subscription)
  const periodEnd = new Date();
  periodEnd.setFullYear(periodEnd.getFullYear() + 1);

  const { rows: subRows } = await pool.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_id, billing_cycle, price_paid, status,
        current_period_start, current_period_end)
     VALUES ($1, $2, 'yearly', 0, 'active', NOW(), $3)
     RETURNING id`,
    [userId, testPlanId, periodEnd]
  );
  testSubId = subRows[0].id;

  // ── Plan + payment method for checkout tests ──
  const { rows: cp } = await pool.query(
    `INSERT INTO subscription_plans
       (name, price_monthly, price_yearly, status, sort_order)
     VALUES ($1, 99000, 990000, 'active', 98)
     RETURNING id`,
    [`TestPremium-${TS}`]
  );
  checkoutPlanId = cp[0].id;

  await pool.query(
    `INSERT INTO plan_features (plan_id, feature_key, feature_value)
     VALUES ($1, 'flashcard_max_decks', 'unlimited')`,
    [checkoutPlanId]
  );

  const { rows: pmRows } = await pool.query(
    `INSERT INTO payment_methods
       (code, display_name, method_type, is_active, sort_order,
        logo_url, instructions_vi, account_info)
     VALUES ($1, 'Test Ewallet', 'ewallet', TRUE, 99,
             'https://example.com/test-logo.png',
             'Chuyển tiền qua ví điện tử test',
             $2)
     RETURNING id`,
    [`test_ew_${TS}`, { phone_number: '0901234567', account_name: 'Test Account', qr_image_url: 'https://example.com/qr.png' }]
  );
  checkoutPmId = pmRows[0].id;
  testPmId = pmRows[0].id;

  await pool.query(
    `INSERT INTO plan_payment_methods (plan_id, payment_method_id)
     VALUES ($1, $2)`,
    [checkoutPlanId, checkoutPmId]
  );

  // Inactive PM (is_active=FALSE) — linked to plan to verify it's excluded from plan.payment_methods
  const { rows: inactivePmRows } = await pool.query(
    `INSERT INTO payment_methods
       (code, display_name, method_type, is_active, sort_order)
     VALUES ($1, 'Test Inactive PM', 'ewallet', FALSE, 97)
     RETURNING id`,
    [`test_inactive_${TS}`]
  );
  inactivePmId = inactivePmRows[0].id;

  await pool.query(
    `INSERT INTO plan_payment_methods (plan_id, payment_method_id)
     VALUES ($1, $2)`,
    [checkoutPlanId, inactivePmId]
  );

  // Unconfigured PM (is_active=TRUE but missing logo_url, instructions_vi, account_info)
  const { rows: unconfigPmRows } = await pool.query(
    `INSERT INTO payment_methods
       (code, display_name, method_type, is_active, sort_order)
     VALUES ($1, 'Test Unconfig PM', 'ewallet', TRUE, 96)
     RETURNING id`,
    [`test_unconf_${TS}`]
  );
  unconfigPmId = unconfigPmRows[0].id;

  await pool.query(
    `INSERT INTO plan_payment_methods (plan_id, payment_method_id)
     VALUES ($1, $2)`,
    [checkoutPlanId, unconfigPmId]
  );
});

afterAll(async () => {
  // Cleanup in FK-safe order
  await pool.query(`DELETE FROM notifications WHERE message LIKE $1`, [`%${EMAIL_PREFIX}%`]);
  await pool.query(`DELETE FROM transactions WHERE user_id = $1`,     [userId]);
  await pool.query(`DELETE FROM user_subscriptions WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM decks WHERE user_id = $1`,            [userId]);
  await pool.query(`DELETE FROM plan_payment_methods WHERE plan_id IN ($1, $2)`,
    [testPlanId, checkoutPlanId]);
  await pool.query(`DELETE FROM plan_features WHERE plan_id IN ($1, $2)`,
    [testPlanId, checkoutPlanId]);
  await pool.query(`DELETE FROM subscription_plans WHERE id IN ($1, $2)`,
    [testPlanId, checkoutPlanId]);
  await pool.query(
    `DELETE FROM payment_methods WHERE id IN ($1, $2, $3)`,
    [checkoutPmId, inactivePmId, unconfigPmId]
  );
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  await pool.end();
});

// ── GET /subscriptions/plans ──────────────────────────────────────────────────

describe('GET /api/v1/subscriptions/plans', () => {
  it('returns 200 with array of plans (public, no auth)', async () => {
    const res = await request(app).get('/api/v1/subscriptions/plans');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('each plan has snake_case fields: price_monthly, is_recommended, payment_methods', async () => {
    const res = await request(app).get('/api/v1/subscriptions/plans');
    expect(res.status).toBe(200);
    for (const plan of res.body.data) {
      expect(plan).toHaveProperty('price_monthly');
      expect(plan).toHaveProperty('is_recommended');
      expect(plan).toHaveProperty('payment_methods');
      expect(Array.isArray(plan.payment_methods)).toBe(true);
      expect(Array.isArray(plan.features)).toBe(true);
    }
  });

  it('plan objects do NOT have camelCase keys like priceMontly', async () => {
    const res = await request(app).get('/api/v1/subscriptions/plans');
    for (const plan of res.body.data) {
      expect(plan).not.toHaveProperty('priceMonthly');
      expect(plan).not.toHaveProperty('isRecommended');
    }
  });

  it('payment_methods only includes is_active=TRUE methods (inactive PM excluded)', async () => {
    const res = await request(app).get('/api/v1/subscriptions/plans');
    expect(res.status).toBe(200);
    const testPlan = res.body.data.find((p: any) => p.id === checkoutPlanId);
    expect(testPlan).toBeDefined();
    const pmCodes: string[] = testPlan.payment_methods.map((m: any) => m.code);
    expect(pmCodes).toContain(`test_ew_${TS}`);
    expect(pmCodes).not.toContain(`test_inactive_${TS}`);
  });

  it('numeric plan fields (price_monthly, trial_days, sort_order) are always numbers, never null', async () => {
    const res = await request(app).get('/api/v1/subscriptions/plans');
    expect(res.status).toBe(200);
    for (const plan of res.body.data) {
      expect(typeof plan.price_monthly).toBe('number');
      expect(typeof plan.price_yearly).toBe('number');
      expect(typeof plan.trial_days).toBe('number');
      expect(typeof plan.sort_order).toBe('number');
    }
  });
});

// ── GET /subscriptions/plans/:id ─────────────────────────────────────────────

describe('GET /api/v1/subscriptions/plans/:id', () => {
  it('returns the test plan by id', async () => {
    const res = await request(app).get(`/api/v1/subscriptions/plans/${checkoutPlanId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(checkoutPlanId);
    expect(res.body.data).toHaveProperty('features');
    expect(res.body.data).toHaveProperty('payment_methods');
  });

  it('404 for unknown plan id', async () => {
    const res = await request(app)
      .get('/api/v1/subscriptions/plans/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ── GET /subscriptions/me ─────────────────────────────────────────────────────

describe('GET /api/v1/subscriptions/me', () => {
  it('returns current_plan, subscription, features, usage for authenticated user', async () => {
    const res = await request(app)
      .get('/api/v1/subscriptions/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('current_plan');
    expect(res.body.data).toHaveProperty('subscription');
    expect(res.body.data).toHaveProperty('features');
    expect(res.body.data).toHaveProperty('usage');
    // Our test plan has flashcard_max_decks: 2
    expect(res.body.data.features.flashcard_max_decks).toBe('2');
  });

  it('401 without token', async () => {
    const res = await request(app).get('/api/v1/subscriptions/me');
    expect(res.status).toBe(401);
  });
});

// ── flashcard_max_decks quota enforcement ─────────────────────────────────────

describe('POST /api/v1/decks — quota enforcement (flashcard_max_decks: 2)', () => {
  it('deck 1 → 201 created', async () => {
    const res = await request(app)
      .post('/api/v1/decks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: `QuotaTest Deck 1 ${TS}` });
    expect(res.status).toBe(201);
    deck1Id = res.body.data.id;
  });

  it('deck 2 → 201 created (at limit)', async () => {
    const res = await request(app)
      .post('/api/v1/decks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: `QuotaTest Deck 2 ${TS}` });
    expect(res.status).toBe(201);
    deck2Id = res.body.data.id;
  });

  it('deck 3 → 403 QUOTA_EXCEEDED with { limit: 2, used: 2 }', async () => {
    const res = await request(app)
      .post('/api/v1/decks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: `QuotaTest Deck 3 ${TS}` });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.error.details).toMatchObject({ limit: 2, used: 2 });
  });
});

// ── Checkout: preview ─────────────────────────────────────────────────────────

describe('POST /api/v1/subscriptions/checkout/preview', () => {
  // Remove test quota subscription so user has no active sub
  beforeAll(async () => {
    await pool.query(`DELETE FROM user_subscriptions WHERE id = $1`, [testSubId]);
  });

  it('GET /me with no subscription — usage values are numeric (never null) for all keys', async () => {
    const res = await request(app)
      .get('/api/v1/subscriptions/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.subscription).toBeNull();
    const usage = res.body.data.usage;
    expect(usage).toBeDefined();
    expect(typeof usage).toBe('object');
    for (const val of Object.values(usage as Record<string, any>)) {
      expect(typeof val).toBe('number');
      expect(val).not.toBeNull();
    }
  });

  it('returns pricing + payment_instructions with transfer_content', async () => {
    const res = await request(app)
      .post('/api/v1/subscriptions/checkout/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plan_id:             checkoutPlanId,
        billing_cycle:       'monthly',
        payment_method_code: `test_ew_${TS}`,
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('pricing');
    expect(res.body.data.pricing.base_price).toBe(99000);
    expect(res.body.data).toHaveProperty('payment_instructions');
    expect(res.body.data.payment_instructions.type).toBe('qr_code');
    expect(res.body.data.payment_instructions).toHaveProperty('transfer_content');
    expect(res.body.data.payment_instructions.transfer_content).toMatch(/^EL_/);
    expect(res.body.data).toHaveProperty('expires_at');
  });

  it('pricing fields in response are all numbers, never null', async () => {
    const res = await request(app)
      .post('/api/v1/subscriptions/checkout/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plan_id:             checkoutPlanId,
        billing_cycle:       'monthly',
        payment_method_code: `test_ew_${TS}`,
      });

    expect(res.status).toBe(200);
    const p = res.body.data.pricing;
    expect(typeof p.base_price).toBe('number');
    expect(typeof p.promo_discount).toBe('number');
    expect(typeof p.fee_amount).toBe('number');
    expect(typeof p.total_amount).toBe('number');
    expect(typeof res.body.data.payment_method.fee_percent).toBe('number');
  });

  it('400 for unknown payment_method_code', async () => {
    const res = await request(app)
      .post('/api/v1/subscriptions/checkout/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plan_id:             checkoutPlanId,
        billing_cycle:       'monthly',
        payment_method_code: 'nonexistent_method',
      });
    expect(res.status).toBe(400);
  });

  it('400 PAYMENT_METHOD_NOT_AVAILABLE when PM is inactive', async () => {
    const res = await request(app)
      .post('/api/v1/subscriptions/checkout/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plan_id:             checkoutPlanId,
        billing_cycle:       'monthly',
        payment_method_code: `test_inactive_${TS}`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_METHOD_NOT_AVAILABLE');
  });

  it('400 PAYMENT_METHOD_NOT_CONFIGURED when PM is active but config incomplete', async () => {
    const res = await request(app)
      .post('/api/v1/subscriptions/checkout/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plan_id:             checkoutPlanId,
        billing_cycle:       'monthly',
        payment_method_code: `test_unconf_${TS}`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_METHOD_NOT_CONFIGURED');
  });
});

// ── Checkout: confirm ─────────────────────────────────────────────────────────

describe('POST /api/v1/subscriptions/checkout/confirm', () => {
  it('creates pending transaction + subscription, returns subscription_id', async () => {
    const res = await request(app)
      .post('/api/v1/subscriptions/checkout/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plan_id:             checkoutPlanId,
        billing_cycle:       'monthly',
        payment_method_code: `test_ew_${TS}`,
        payment_ref:         `REF-TEST-${TS}`,
        amount_paid:         99000,
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('subscription_id');
    expect(res.body.data).toHaveProperty('transaction_id');
    expect(res.body.data.status).toBe('pending_payment');

    checkoutSubId = res.body.data.subscription_id;
    checkoutTxId  = res.body.data.transaction_id;
  });

  it('409 ALREADY_SUBSCRIBED when pending subscription exists', async () => {
    const res = await request(app)
      .post('/api/v1/subscriptions/checkout/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plan_id:             checkoutPlanId,
        billing_cycle:       'monthly',
        payment_method_code: `test_ew_${TS}`,
        amount_paid:         99000,
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SUBSCRIBED');
  });
});

// ── Admin approve → subscription active ──────────────────────────────────────

describe('Admin approve → GET /subscriptions/me returns active plan', () => {
  beforeAll(async () => {
    // Simulate admin approval directly (admin UI tested separately)
    await pool.query(
      `UPDATE transactions SET status = 'completed' WHERE id = $1`,
      [checkoutTxId]
    );
    await pool.query(
      `UPDATE user_subscriptions
          SET status               = 'active',
              current_period_start = NOW(),
              current_period_end   = NOW() + INTERVAL '1 month'
        WHERE id = $1`,
      [checkoutSubId]
    );
  });

  it('GET /subscriptions/me shows active subscription after approval', async () => {
    const res = await request(app)
      .get('/api/v1/subscriptions/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.subscription).not.toBeNull();
    expect(res.body.data.subscription.status).toBe('active');
    expect(res.body.data.current_plan).not.toBeNull();
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/subscriptions/cancel', () => {
  it('sets cancelled_at and returns 204', async () => {
    const res = await request(app)
      .post('/api/v1/subscriptions/cancel')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);

    // Verify cancelled_at is set in DB
    const { rows } = await pool.query(
      `SELECT cancelled_at FROM user_subscriptions WHERE id = $1`,
      [checkoutSubId]
    );
    expect(rows[0].cancelled_at).not.toBeNull();
  });

  it('404 when no active subscription to cancel', async () => {
    const res = await request(app)
      .post('/api/v1/subscriptions/cancel')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ── Transactions list ─────────────────────────────────────────────────────────

describe('GET /api/v1/subscriptions/transactions', () => {
  it('returns own transactions with snake_case payment_method object', async () => {
    const res = await request(app)
      .get('/api/v1/subscriptions/transactions')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('items');
    expect(res.body.data).toHaveProperty('total');
    expect(res.body.data).toHaveProperty('page');
    expect(Array.isArray(res.body.data.items)).toBe(true);

    if (res.body.data.items.length > 0) {
      const tx = res.body.data.items[0];
      expect(tx).toHaveProperty('id');
      expect(tx).toHaveProperty('amount');
      expect(tx).toHaveProperty('status');
      expect(tx.payment_method).toHaveProperty('code');
      expect(tx.payment_method).toHaveProperty('display_name');
    }
  });

  it('filters by status=completed', async () => {
    const res = await request(app)
      .get('/api/v1/subscriptions/transactions?status=completed')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const tx of res.body.data.items) {
      expect(tx.status).toBe('completed');
    }
  });
});
