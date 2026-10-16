import 'dotenv/config';
import pool from '../config/db';
(async () => {
  const r = await pool.query(`SELECT headword, published, left(coalesce(admin_note,''), 12) AS note FROM dictionary_entries WHERE lower(headword) = ANY($1::text[]) ORDER BY headword`, [['run','go','child','light','bank']]);
  console.log(JSON.stringify(r.rows));
  const u = await pool.query(`SELECT id, status FROM users WHERE email = 'lookup-acceptance@example.com'`);
  const e = await pool.query(`SELECT id FROM ebooks WHERE title = 'Lookup acceptance ebook'`);
  console.log(JSON.stringify({ user: u.rows, ebook: e.rows }));
  await pool.end();
})();
