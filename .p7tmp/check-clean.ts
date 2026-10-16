import 'dotenv/config';
import pool from '../config/db';
(async () => {
  const s = await pool.query(`SELECT schema_name FROM information_schema.schemata WHERE left(schema_name, 3) = 'lt_'`);
  console.log(JSON.stringify(s.rows));
  await pool.end();
})();
