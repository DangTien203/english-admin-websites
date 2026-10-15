/**
 * expire-subscriptions.ts
 * Marks active subscriptions whose current_period_end has passed as 'expired'.
 * Run as a scheduled job (e.g. daily cron) or on-demand: tsx scripts/expire-subscriptions.ts
 */
import 'dotenv/config';
import pool from '../config/db';

async function expireSubscriptions(): Promise<void> {
  console.log('[expire-subscriptions] Starting…');

  const { rows } = await pool.query(
    `UPDATE user_subscriptions
        SET status     = 'expired',
            updated_at = NOW()
      WHERE status = 'active'
        AND current_period_end < NOW()
      RETURNING id, user_id, current_period_end`
  );

  if (rows.length === 0) {
    console.log('[expire-subscriptions] No subscriptions to expire.');
  } else {
    console.log(`[expire-subscriptions] Expired ${rows.length} subscription(s):`);
    for (const r of rows) {
      console.log(`  - ${r.id}  user=${r.user_id}  ended=${r.current_period_end}`);
    }
  }

  await pool.end();
  console.log('[expire-subscriptions] Done.');
}

expireSubscriptions().catch(err => {
  console.error('[expire-subscriptions] Fatal:', err);
  process.exit(1);
});
