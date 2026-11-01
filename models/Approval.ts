import pool from '../config/db';
import { invalidatePendingCounts } from '../utils/pendingCounts';

const Approval = {
  async create({ requesterId, action, module, targetType = null, targetId = null, payload }: { requesterId: string; action: string; module: string; targetType?: string | null; targetId?: string | null; payload: any }) {
    const { rows } = await pool.query(
      `INSERT INTO approval_requests
         (requester_id, action, module, target_type, target_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [requesterId, action, module, targetType, targetId, JSON.stringify(payload)]
    );
    invalidatePendingCounts(); // the sidebar badge of the super admins
    return rows[0];
  },

  async findPending(module: string | null = null) {
    const params: any[] = [];
    let where = `WHERE ar.status = 'pending'`;
    if (module) {
      params.push(module);
      where += ` AND ar.module = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT ar.*,
              a.full_name AS requester_name,
              a.email     AS requester_email
       FROM approval_requests ar
       JOIN admin_accounts a ON a.id = ar.requester_id
       ${where}
       ORDER BY ar.created_at ASC`,
      params
    );
    return rows;
  },

  async findById(id: string) {
    const { rows } = await pool.query(
      `SELECT ar.*,
              a.full_name  AS requester_name,
              rv.full_name AS reviewer_name
       FROM approval_requests ar
       JOIN  admin_accounts a  ON a.id  = ar.requester_id
       LEFT JOIN admin_accounts rv ON rv.id = ar.reviewer_id
       WHERE ar.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async approve(id: string, reviewerId: string, reviewerNote: string | null = null) {
    const { rows } = await pool.query(
      `UPDATE approval_requests
       SET status = 'approved', reviewer_id = $2, reviewer_note = $3, reviewed_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, reviewerId, reviewerNote]
    );
    invalidatePendingCounts();
    return rows[0] || null;
  },

  async reject(id: string, reviewerId: string, reviewerNote: string | null = null) {
    const { rows } = await pool.query(
      `UPDATE approval_requests
       SET status = 'rejected', reviewer_id = $2, reviewer_note = $3, reviewed_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, reviewerId, reviewerNote]
    );
    invalidatePendingCounts();
    return rows[0] || null;
  },

  async countPending() {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM approval_requests WHERE status = 'pending'`
    );
    return rows[0].count;
  },
};

export = Approval;
