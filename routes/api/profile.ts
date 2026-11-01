import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import pool from '../../config/db';
import { ApiRequest } from '../../middlewares/apiAuth';
import { validateBody } from '../../middlewares/validateBody';
import { asyncHandler } from '../../utils/asyncHandler';
import { apiSuccess, apiError } from '../../utils/apiResponse';
import { uploadAvatar } from '../../middlewares/upload';
import { computeSubscriptionBadge } from '../../utils/subscriptionHelper';
import { invalidateAuthUser } from '../../utils/authUserCache';

const router = Router();

// VN phone: 09xxxxxxxx hoặc +849xxxxxxxx / +84xxxxxxxxx
const VN_PHONE = /^(\+84|0)\d{9,10}$/;

const updateProfileSchema = z.object({
  full_name: z.string().min(2).optional(),
  phone: z.string().regex(VN_PHONE).optional(),
  avatar_url: z.string().url().optional(),
  level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

// ══════════════════════════════════════
//  GET /api/v1/profile/me
// ══════════════════════════════════════
router.get(
  '/me',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;

    // One round trip for the row AND days_active (distinct days with activity in the last 30 days); the badge is read alongside.
    const [{ rows }, badge] = await Promise.all([
      pool.query(
        `SELECT id, email, full_name, phone, avatar_url, level, status,
                streak_current, streak_longest,
                last_active_at, last_login_at, created_at, updated_at,
                (SELECT COUNT(DISTINCT DATE(a.created_at AT TIME ZONE 'UTC'))::int
                   FROM user_activity_log a
                  WHERE a.user_id = users.id AND a.created_at >= NOW() - INTERVAL '30 days') AS days_active
         FROM users WHERE id = $1`,
        [userId]
      ),
      computeSubscriptionBadge(userId),
    ]);
    if (rows.length === 0) {
      return apiError(res, 404, 'USER_NOT_FOUND', 'User không tồn tại');
    }
    const user = rows[0];

    // TODO: bảng bookmarks chưa có — tạm trả 0.
    const total_words_saved = 0;

    return apiSuccess(res, {
      id:                 user.id,
      email:              user.email,
      full_name:          user.full_name  ?? null,
      phone:              user.phone      ?? null,
      avatar_url:         user.avatar_url ?? null,
      level:              user.level,
      status:             user.status,
      streak_current:     Number(user.streak_current ?? 0),
      streak_longest:     Number(user.streak_longest ?? 0),
      last_active_at:     user.last_active_at  ?? null,
      created_at:         user.created_at,
      subscription_badge: badge,
      total_words_saved,
      days_active: user.days_active ?? 0,
    });
  })
);

// ══════════════════════════════════════
//  PATCH /api/v1/profile/me
// ══════════════════════════════════════
router.patch(
  '/me',
  validateBody(updateProfileSchema, { rejectEmpty: true }),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const body = req.body as Record<string, unknown>;

    const fields: string[] = [];
    const values: unknown[] = [];
    let p = 1;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${p++}`);
      values.push(v);
    }
    values.push(userId);

    const { rows } = await pool.query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${p}
       RETURNING id, email, full_name, phone, avatar_url, level, status,
                 streak_current, streak_longest, last_active_at, created_at, updated_at`,
      values
    );
    invalidateAuthUser(userId); // name / level / avatar are part of req.user (utils/authUserCache.ts)

    return apiSuccess(res, rows[0], 'Profile đã được cập nhật');
  })
);

// ══════════════════════════════════════
//  POST /api/v1/profile/change-password
// ══════════════════════════════════════
router.post(
  '/change-password',
  validateBody(changePasswordSchema),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { currentPassword, newPassword } = req.body;

    if (currentPassword === newPassword) {
      return apiError(res, 400, 'SAME_PASSWORD', 'Mật khẩu mới phải khác mật khẩu hiện tại');
    }

    const { rows } = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );
    if (rows.length === 0) {
      return apiError(res, 404, 'USER_NOT_FOUND', 'User không tồn tại');
    }

    const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!match) {
      return apiError(res, 401, 'INVALID_CURRENT_PASSWORD', 'Mật khẩu hiện tại không đúng');
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, userId]
    );

    // Revoke mọi refresh token → ép re-login trên các device khác.
    await pool.query(
      `UPDATE user_refresh_tokens SET revoked = true
       WHERE user_id = $1 AND revoked = false`,
      [userId]
    );

    return apiSuccess(res, null, 'Password changed successfully');
  })
);

// ══════════════════════════════════════
//  POST /api/v1/profile/avatar
//  TODO: Migrate to S3/Cloudinary trong production scale.
// ══════════════════════════════════════
router.post(
  '/avatar',
  uploadAvatar.single('avatar'),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    if (!req.file) {
      return apiError(res, 400, 'NO_FILE', 'Vui lòng upload file avatar');
    }
    const userId = req.user!.id;
    const relativePath = `/uploads/avatars/${req.file.filename}`;

    const { rows: oldRows } = await pool.query(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId]
    );
    const oldPath = (oldRows[0]?.avatar_url as string | null) ?? null;

    await pool.query(
      'UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2',
      [relativePath, userId]
    );
    invalidateAuthUser(userId);

    // Xóa file cũ (best-effort) nếu khác file mới và nằm trong /uploads/avatars/
    if (oldPath && oldPath.startsWith('/uploads/avatars/') && oldPath !== relativePath) {
      const diskPath = path.join(process.cwd(), 'public', oldPath);
      fs.unlink(diskPath).catch(() => {
      });
    }

    const fullUrl = `${req.protocol}://${req.get('host')}${relativePath}`;
    return apiSuccess(res, { avatar_url: fullUrl }, 'Avatar đã cập nhật');
  })
);

// ══════════════════════════════════════
//  DELETE /api/v1/profile/avatar
// ══════════════════════════════════════
router.delete(
  '/avatar',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { rows } = await pool.query(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId]
    );
    const oldPath = (rows[0]?.avatar_url as string | null) ?? null;

    await pool.query(
      'UPDATE users SET avatar_url = NULL, updated_at = NOW() WHERE id = $1',
      [userId]
    );
    invalidateAuthUser(userId);

    if (oldPath && oldPath.startsWith('/uploads/avatars/')) {
      const diskPath = path.join(process.cwd(), 'public', oldPath);
      fs.unlink(diskPath).catch(() => {
        /* ignore */
      });
    }

    return apiSuccess(res, null, 'Avatar đã xóa');
  })
);

// ══════════════════════════════════════
//  GET /api/v1/profile/stats
// ══════════════════════════════════════
router.get(
  '/stats',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;

    // The four totals are one statement (they were four). "Words learned" = the words in Leitner box 4 or 5: it used to count
    // user_card_progress.leitner_box, a column that no longer exists, so this whole endpoint answered 500.
    // The streak is the one on req.user (the same columns, kept current by updateStreak).
    const [totalsR, dailyR] = await Promise.all([
      pool.query(
        `SELECT (SELECT COUNT(*)::int FROM reviews WHERE user_id = $1)                                   AS reviews_total,
                (SELECT COUNT(*) FILTER (WHERE correct = true)::int FROM reviews WHERE user_id = $1)      AS reviews_correct,
                (SELECT COALESCE(SUM(duration_sec), 0)::int FROM user_activity_log WHERE user_id = $1)   AS total_sec,
                (SELECT COUNT(*)::int FROM leitner_cards WHERE user_id = $1 AND box_number >= 4)         AS words`,
        [userId]
      ),
      pool.query(
        `WITH days AS (
           SELECT generate_series(
             (CURRENT_DATE - INTERVAL '29 days')::date,
             CURRENT_DATE::date,
             INTERVAL '1 day'
           )::date AS d
         ),
         reviews_daily AS (
           SELECT DATE(created_at AT TIME ZONE 'UTC') AS d, COUNT(*)::int AS cnt
           FROM reviews
           WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
           GROUP BY 1
         ),
         activity_daily AS (
           SELECT DATE(created_at AT TIME ZONE 'UTC') AS d,
                  COALESCE(SUM(duration_sec), 0)::int AS secs
           FROM user_activity_log
           WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
           GROUP BY 1
         )
         SELECT days.d AS date,
                COALESCE(r.cnt, 0)::int AS review_count,
                ROUND(COALESCE(a.secs, 0) / 60.0, 1)::float AS minutes_studied
         FROM days
         LEFT JOIN reviews_daily r ON r.d = days.d
         LEFT JOIN activity_daily a ON a.d = days.d
         ORDER BY days.d ASC`,
        [userId]
      ),
    ]);

    const totals = totalsR.rows[0];
    const total = totals?.reviews_total ?? 0;
    const correct = totals?.reviews_correct ?? 0;

    return apiSuccess(res, {
      streak_current: req.user!.streak_current ?? 0,
      streak_longest: req.user!.streak_longest ?? 0,
      total_reviews: total,
      correct_rate: total > 0 ? +(correct / total).toFixed(4) : 0,
      total_study_time_minutes: Math.round((totals?.total_sec ?? 0) / 60),
      total_words_learned: totals?.words ?? 0,
      last_30_days_activity: dailyR.rows.map((r: any) => ({
        date: r.date,
        review_count: r.review_count,
        minutes_studied: Number(r.minutes_studied) || 0,
      })),
    });
  })
);

export default router;
