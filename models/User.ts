import pool from '../config/db';
import { paginate } from '../helpers/pagination';
import { invalidateAuthUser } from '../utils/authUserCache';

const User = {
  async getAll({ search = '', status = '', level = '', page = 1, limit = 20 }: { search?: string; status?: string; level?: string; page?: number; limit?: number } = {}) {
    const conditions: string[] = [];
    const params: any[] = [];

    if (search) {
      params.push(`%${search}%`);
      params.push(`%${search}%`);
      conditions.push(`(u.full_name ILIKE $${params.length - 1} OR u.email ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`u.status = $${params.length}`);
    }
    if (level) {
      params.push(level);
      conditions.push(`u.level = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const n = params.length;

    const query = `
      SELECT u.id, u.email, u.full_name, u.phone, u.avatar_url, u.level, u.status,
             u.streak_current, u.streak_longest, u.last_active_at, u.last_login_at, u.created_at,
             COALESCE(UPPER(sp.name), 'FREE') AS subscription_tier
      FROM users u
      LEFT JOIN user_subscriptions us
        ON us.user_id = u.id
       AND us.status IN ('active', 'trial')
       AND us.current_period_end > NOW()
      LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
      ${where}
      ORDER BY u.created_at DESC
      LIMIT $${n + 1} OFFSET $${n + 2}
    `;
    const countQuery = `SELECT COUNT(*)::int AS count FROM users u ${where}`;

    return paginate(query, countQuery, params, params, page, limit);
  },

  async findById(id: string) {
    const { rows } = await pool.query(
      `SELECT id, email, full_name, phone, avatar_url, level, status,
              streak_current, streak_longest, last_active_at, last_login_at, created_at, updated_at
       FROM users WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async findByEmail(email: string) {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    return rows[0] || null;
  },

  async create({ email, passwordHash, fullName, phone = null, level = 'beginner' }: { email: string; passwordHash: string; fullName: string; phone?: string | null; level?: string }) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, phone, level)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, full_name, level, created_at`,
      [email, passwordHash, fullName, phone, level]
    );
    return rows[0];
  },

  async update(id: string, { fullName, phone, level, status }: { fullName: string; phone?: string | null; level: string; status: string }) {
    await pool.query(
      'UPDATE users SET full_name = $1, phone = $2, level = $3, status = $4 WHERE id = $5',
      [fullName, phone || null, level, status, id]
    );
    invalidateAuthUser(id); // req.user of the mobile API is cached for a few seconds (utils/authUserCache.ts)
  },

  async setStatus(id: string, status: string) {
    await pool.query(
      'UPDATE users SET status = $1 WHERE id = $2',
      [status, id]
    );
    invalidateAuthUser(id); // a ban must show on the user's very next request
  },

  async delete(id: string) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    invalidateAuthUser(id);
  },

  async countByStatus() {
    const { rows } = await pool.query(
      'SELECT status, COUNT(*)::int AS count FROM users GROUP BY status'
    );
    const result: Record<string, number> = { active: 0, inactive: 0, banned: 0 };
    rows.forEach((r: any) => { result[r.status] = r.count; });
    return result;
  },

  async count() {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    return rows[0].count;
  },
};

export = User;
