/**
 * audit-plan-features.ts
 * Print every (plan, feature_key, feature_value) row, grouped by plan.
 * Run before AND after migration 27 to compare:
 *   tsx scripts/audit-plan-features.ts
 */
import 'dotenv/config';
import pool from '../config/db';

async function audit(): Promise<void> {
  const { rows } = await pool.query<{
    plan_name: string;
    sort_order: number;
    feature_key: string | null;
    feature_value: string | null;
  }>(`
    SELECT sp.name AS plan_name,
           sp.sort_order,
           pf.feature_key,
           pf.feature_value
      FROM subscription_plans sp
      LEFT JOIN plan_features pf ON pf.plan_id = sp.id
     ORDER BY sp.sort_order ASC, pf.feature_key ASC
  `);

  if (rows.length === 0) {
    console.log('(no plans found)');
    await pool.end();
    return;
  }

  // Group by plan_name
  const grouped: Record<string, Array<{ key: string; value: string }>> = {};
  const order: string[] = [];
  for (const r of rows) {
    if (!grouped[r.plan_name]) {
      grouped[r.plan_name] = [];
      order.push(r.plan_name);
    }
    if (r.feature_key) {
      grouped[r.plan_name].push({ key: r.feature_key, value: r.feature_value ?? '' });
    }
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  plan_features audit');
  console.log('═══════════════════════════════════════════════════════════');

  for (const planName of order) {
    const features = grouped[planName];
    console.log(`\n[${planName}] ${features.length} feature(s)`);
    if (features.length === 0) {
      console.log('  (none)');
      continue;
    }
    const keyWidth = Math.max(...features.map(f => f.key.length));
    for (const f of features) {
      console.log(`  ${f.key.padEnd(keyWidth)}  =  ${f.value}`);
    }
  }

  // Flag legacy keys
  const legacyKeys = ['ebook_max', 'ads', 'offline'];
  const legacyFound = rows.filter(r => r.feature_key && legacyKeys.includes(r.feature_key));
  if (legacyFound.length > 0) {
    console.log('\n⚠️  Legacy keys still present:');
    for (const r of legacyFound) {
      console.log(`   - ${r.plan_name}: ${r.feature_key} = ${r.feature_value}`);
    }
  } else {
    console.log('\n✅ No legacy keys (ebook_max, ads, offline) found.');
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  await pool.end();
}

audit().catch(err => {
  console.error('[audit-plan-features] Fatal:', err);
  process.exit(1);
});
