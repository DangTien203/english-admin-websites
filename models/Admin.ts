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

  /**
   * A super admin edits ANOTHER admin account. One transaction: update, plus an audit_logs row naming who changed what (never the
   * password itself). Throws an Error whose `code` is
   *   NOT_FOUND         no such account
   *   EMAIL_TAKEN       the e-mail belongs to another account (compared case-insensitively)
   *   LAST_SUPER_ADMIN  the edit would leave no active super admin
   * The active super admins are locked (fixed order) before the check, so two super admins demoting each other at the same moment
   * cannot both succeed.
   */
  async updateByAdmin(
    id: string,
    edit: { fullName: string; email: string; role: string; status: string; passwordHash?: string | null },
    actor: { id: string; ip?: string | null }
  ) {
    const fail = (code: string) => Object.assign(new Error(code), { code });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: supers } = await client.query(
        `SELECT id FROM admin_accounts WHERE role = 'super_admin' AND status = 'active' ORDER BY id FOR UPDATE`
      );
      const { rows: found } = await client.query(
        `SELECT id, email, full_name, role, status FROM admin_accounts WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const before = found[0];
      if (!before) throw fail('NOT_FOUND');

      const supersAfter =
        supers.filter((r: { id: string }) => r.id !== id).length +
        (edit.role === 'super_admin' && edit.status === 'active' ? 1 : 0);
      if (supersAfter < 1) throw fail('LAST_SUPER_ADMIN');

      const { rows: clash } = await client.query(
        'SELECT 1 FROM admin_accounts WHERE LOWER(email) = LOWER($1) AND id <> $2',
        [edit.email, id]
      );
      if (clash.length > 0) throw fail('EMAIL_TAKEN');

      const params: unknown[] = [edit.fullName, edit.email, edit.role, edit.status, id];
      let passwordSql = '';
      if (edit.passwordHash) {
        params.push(edit.passwordHash);
        passwordSql = ', password_hash = $6';
      }
      let after;
      try {
        ({ rows: [after] } = await client.query(
          `UPDATE admin_accounts
              SET full_name = $1, email = $2, role = $3, status = $4, updated_at = NOW()${passwordSql}
            WHERE id = $5
        RETURNING id, email, full_name, role, status`,
          params
        ));
      } catch (err: any) {
        // Another request took the e-mail between the check above and the UPDATE: the unique index decides.
        if (err?.code === '23505') throw fail('EMAIL_TAKEN');
        throw err;
      }

      const changes: Record<string, { from: string; to: string }> = {};
      for (const field of ['full_name', 'email', 'role', 'status'] as const) {
        if (before[field] !== after[field]) changes[field] = { from: before[field], to: after[field] };
      }
      const passwordReset = Boolean(edit.passwordHash);

      if (Object.keys(changes).length > 0 || passwordReset) {
        await client.query(
          `INSERT INTO audit_logs (admin_id, action, module, target_type, target_id, target_label, details, ip_address)
           VALUES ($1, 'UPDATE', 'admins', 'admin_account', $2, $3, $4, $5)`,
          [actor.id, id, after.email, JSON.stringify({ changes, password_reset: passwordReset }), actor.ip ? actor.ip.slice(0, 45) : null]
        );
      }

      await client.query('COMMIT');
      return { before, after, changes, passwordReset };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  },

  async deleteAccount(id: string) {
    await pool.query(
      "UPDATE admin_accounts SET status = 'disabled' WHERE id = $1",
      [id]
    );
  },
};

export = Admin;
