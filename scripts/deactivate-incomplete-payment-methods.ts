/**
 * One-time cleanup: deactivate payment methods that lack required config.
 * Run: npx tsx scripts/deactivate-incomplete-payment-methods.ts
 */
import 'dotenv/config';
import pool from '../config/db';
import { validatePaymentMethodConfig } from '../utils/paymentMethodValidator';

async function main(): Promise<void> {
  console.log('[cleanup] Checking payment methods…');

  const { rows } = await pool.query('SELECT * FROM payment_methods ORDER BY sort_order ASC');
  let deactivated = 0;

  for (const method of rows) {
    const validation = validatePaymentMethodConfig(method);
    if (method.is_active && !validation.is_valid) {
      await pool.query(
        `UPDATE payment_methods SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [method.id]
      );
      console.log(`  Deactivated ${method.code}: missing [${validation.missing_fields.join(', ')}]`);
      deactivated++;
    } else {
      const status = method.is_active ? 'active ✓' : 'inactive';
      console.log(`  ${method.code}: ${status}`);
    }
  }

  console.log(`\n[cleanup] Done. Deactivated ${deactivated} incomplete method(s).`);
  await pool.end();
}

main().catch(err => {
  console.error('[cleanup] Fatal:', err);
  process.exit(1);
});
