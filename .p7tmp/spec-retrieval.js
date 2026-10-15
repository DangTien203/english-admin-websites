module.exports = [{ file: 'tests/retrieval.test.ts', edits: [
  [`       (user_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
     VALUES ($1, $2, 'active', 'monthly', NOW(), NOW() + INTERVAL '1 month')`,
   `       (user_id, plan_id, status, billing_cycle, price_paid, current_period_start, current_period_end)
     VALUES ($1, $2, 'active', 'monthly', 0, NOW(), NOW() + INTERVAL '1 month')`],
]}];
