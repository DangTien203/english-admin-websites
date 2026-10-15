import 'dotenv/config';
import pool from '../config/db';

async function main() {
  const { rows: plans } = await pool.query(
    `SELECT id, name, status, price_monthly FROM subscription_plans ORDER BY price_monthly ASC`
  );
  console.log('Plans:', plans);

  const { rows: features } = await pool.query(
    `SELECT sp.name AS plan, pf.feature_key, pf.feature_value
     FROM plan_features pf JOIN subscription_plans sp ON sp.id = pf.plan_id
     WHERE pf.feature_key IN ('flashcard_max_decks','retrieval_practice_daily')
     ORDER BY sp.price_monthly ASC, pf.feature_key`
  );
  console.log('Features:', features);

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
