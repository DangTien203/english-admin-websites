import pool from '../config/db';

const Admin = {
  /** Case-insensitive: accounts are stored in lower case, but "Name@Example.com" is the same address. */
  async findByEmail(email: string) {
    const { rows } = await pool.query(
      'SELECT * FROM admin_accounts WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    return rows[0] || null;
  },

  async findById(id: string) {
    const { rows } = await pool.query(
      'SELECT id, email, full_name, avatar_url, role, status, last_login_at, created_at FROM admin_accounts WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  async create({ email, passwordHash, fullName, role = 'content_editor' }: { email: string; passwordHash: string; fullName: string; role?: string }) {
    const { rows } = await pool.query(
      `INSERT INTO admin_accounts (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, role, created_at`,
      [email, passwordHash, fullName, role]
    );
    return rows[0];
  },

  async updateLastLogin(id: string) {
    await pool.query(
      'UPDATE admin_accounts SET last_login_at = NOW() WHERE id = $1',
      [id]
    );
  },

  async getAll() {
    const { rows } = await pool.query(
      `SELECT id, email, full_name, role, status, last_login_at, created_at
       FROM admin_accounts ORDER BY created_at DESC`
    );
    return rows;
  },

  async countByRole() {
    const { rows } = await pool.query(
      `SELECT role, COUNT(*)::int as count FROM admin_accounts GROUP BY role`
    );
    return rows;
  },

  async updateProfile(id: string, { fullName, avatarUrl }: { fullName: string; avatarUrl: string | null }) {
    await pool.query(
      'UPDATE admin_accounts SET full_name = $1, avatar_url = $2 WHERE id = $3',
      [fullName, avatarUrl, id]
    );
  },

  async updatePassword(id: string, newPasswordHash: string) {
    await pool.query(
      'UPDATE admin_accounts SET password_hash = $1 WHERE id = $2',
      [newPasswordHash, id]
    );
  },

  async deleteAccount(id: string) {
    await pool.query(
      "UPDATE admin_accounts SET status = 'disabled' WHERE id = $1",
      [id]
    );
  },
};

export = Admin;
