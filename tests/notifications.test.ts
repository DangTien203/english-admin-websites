import request from 'supertest';
import app from '../app';
import pool from '../config/db';
import { registerUser } from './helpers/auth';
import { createNotification } from '../services/notificationService';

const SUFFIX = `notif-${Date.now()}`;

let user: { userId: string; accessToken: string; email: string };
let otherUser: { userId: string; accessToken: string; email: string };

beforeAll(async () => {
  user = await registerUser(SUFFIX);
  otherUser = await registerUser(`${SUFFIX}-other`);
});

afterAll(async () => {
  // FK on transactions.user_id is ON DELETE RESTRICT, so we must clear children
  // before the users themselves. user_notifications/user_fcm_tokens cascade.
  const userIds = [user.userId, otherUser.userId];
  await pool.query(`DELETE FROM transactions WHERE user_id = ANY($1::uuid[])`, [userIds]);
  await pool.query(`DELETE FROM user_subscriptions WHERE user_id = ANY($1::uuid[])`, [userIds]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`test-${SUFFIX}%`]);
  // Test-only plans created inline in the approve/reject hook tests. We may
  // not be able to delete them if other concurrent tests still reference them
  // — best-effort, swallow the FK error.
  await pool
    .query(`DELETE FROM subscription_plans WHERE name LIKE 'Notif-Plan-%'`)
    .catch(() => {/* fk_violation: another test holds a reference */});
  await pool.end();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('Notifications API', () => {
  describe('GET /api/v1/notifications', () => {
    it('lists notifications for the current user only with pagination + unread_count', async () => {
      // Seed: 2 unread (one system-type, one not), 1 read.
      await createNotification({
        userId: user.userId,
        type: 'subscription_activated',
        title: 'Welcome!',
        message: 'Premium activated',
      });
      await createNotification({
        userId: user.userId,
        type: 'review_due',
        title: '5 cards due',
        linkUrl: '/leitner',
      });
      const readOne = await createNotification({
        userId: user.userId,
        type: 'system_update',
        title: 'Old read message',
      });
      await pool.query(`UPDATE user_notifications SET is_read = TRUE WHERE id = $1`, [
        readOne.id,
      ]);

      // Notification for OTHER user — must NOT appear in our user's list.
      await createNotification({
        userId: otherUser.userId,
        type: 'system_update',
        title: 'For someone else',
      });

      const res = await request(app)
        .get('/api/v1/notifications?page=1&limit=10')
        .set(auth(user.accessToken));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items.length).toBe(3);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.unread_count).toBe(2);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.limit).toBe(10);

      const item = res.body.data.items[0];
      // snake_case fields per contract
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('message');
      expect(item).toHaveProperty('link_url');
      expect(item).toHaveProperty('is_read');
      expect(item).toHaveProperty('created_at');
      // The for-other-user notification leaks through? It must not.
      const allTitles = res.body.data.items.map((i: any) => i.title);
      expect(allTitles).not.toContain('For someone else');
    });

    it('filter=unread returns only is_read=false items', async () => {
      const res = await request(app)
        .get('/api/v1/notifications?filter=unread')
        .set(auth(user.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.data.items.every((i: any) => i.is_read === false)).toBe(true);
      expect(res.body.data.items.length).toBe(2);
    });

    it('filter=system returns only system-class types', async () => {
      const res = await request(app)
        .get('/api/v1/notifications?filter=system')
        .set(auth(user.accessToken));
      expect(res.status).toBe(200);
      const types = res.body.data.items.map((i: any) => i.type);
      expect(
        types.every((t: string) =>
          [
            'system_update',
            'subscription_activated',
            'subscription_pending',
            'subscription_rejected',
          ].includes(t),
        ),
      ).toBe(true);
    });

    it('rejects unknown filter with VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/v1/notifications?filter=garbage')
        .set(auth(user.accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('without auth → 401 NO_TOKEN', async () => {
      const res = await request(app).get('/api/v1/notifications');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('NO_TOKEN');
    });
  });

  describe('GET /api/v1/notifications/unread-count', () => {
    it('returns the unread count for the current user', async () => {
      const res = await request(app)
        .get('/api/v1/notifications/unread-count')
        .set(auth(user.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(2);
    });
  });

  describe('POST /api/v1/notifications/:id/read', () => {
    it('marks a single notification as read; 404 when not owned', async () => {
      const n = await createNotification({
        userId: user.userId,
        type: 'review_due',
        title: 'Single mark test',
      });

      // Other user can't mark it as read.
      const forbidden = await request(app)
        .post(`/api/v1/notifications/${n.id}/read`)
        .set(auth(otherUser.accessToken));
      expect(forbidden.status).toBe(404);
      expect(forbidden.body.error.code).toBe('NOT_FOUND');

      // Owner can.
      const ok = await request(app)
        .post(`/api/v1/notifications/${n.id}/read`)
        .set(auth(user.accessToken));
      expect(ok.status).toBe(204);

      const { rows } = await pool.query(
        `SELECT is_read FROM user_notifications WHERE id = $1`,
        [n.id],
      );
      expect(rows[0].is_read).toBe(true);
    });
  });

  describe('POST /api/v1/notifications/read-all', () => {
    it('flips every unread row for the user → unread-count becomes 0', async () => {
      // Add a fresh unread before calling read-all.
      await createNotification({
        userId: user.userId,
        type: 'review_due',
        title: 'Will be marked',
      });

      const res = await request(app)
        .post('/api/v1/notifications/read-all')
        .set(auth(user.accessToken));
      expect(res.status).toBe(204);

      const count = await request(app)
        .get('/api/v1/notifications/unread-count')
        .set(auth(user.accessToken));
      expect(count.body.data.count).toBe(0);

      // Other user's unread is untouched.
      const otherCount = await request(app)
        .get('/api/v1/notifications/unread-count')
        .set(auth(otherUser.accessToken));
      expect(otherCount.body.data.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('DELETE /api/v1/notifications/:id', () => {
    it('removes the notification; 404 when not owned', async () => {
      const n = await createNotification({
        userId: user.userId,
        type: 'system_update',
        title: 'To delete',
      });

      const forbidden = await request(app)
        .delete(`/api/v1/notifications/${n.id}`)
        .set(auth(otherUser.accessToken));
      expect(forbidden.status).toBe(404);

      const ok = await request(app)
        .delete(`/api/v1/notifications/${n.id}`)
        .set(auth(user.accessToken));
      expect(ok.status).toBe(204);

      const { rows } = await pool.query(
        `SELECT id FROM user_notifications WHERE id = $1`,
        [n.id],
      );
      expect(rows.length).toBe(0);
    });
  });

  describe('POST /api/v1/notifications/fcm-token', () => {
    it('upserts the device token (insert then refresh)', async () => {
      const body = {
        token: 'fake-fcm-token-aaa',
        device_id: 'device-abc',
        platform: 'android' as const,
      };

      const first = await request(app)
        .post('/api/v1/notifications/fcm-token')
        .set(auth(user.accessToken))
        .send(body);
      expect(first.status).toBe(204);

      const refreshed = await request(app)
        .post('/api/v1/notifications/fcm-token')
        .set(auth(user.accessToken))
        .send({ ...body, token: 'fake-fcm-token-bbb' });
      expect(refreshed.status).toBe(204);

      const { rows } = await pool.query(
        `SELECT token, platform FROM user_fcm_tokens
          WHERE user_id = $1 AND device_id = $2`,
        [user.userId, body.device_id],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].token).toBe('fake-fcm-token-bbb');
      expect(rows[0].platform).toBe('android');
    });

    it('rejects invalid platform with VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/fcm-token')
        .set(auth(user.accessToken))
        .send({ token: 'x', device_id: 'd', platform: 'symbian' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Subscription approve/reject hooks', () => {
    it('approveTransaction inserts a subscription_activated notification', async () => {
      // Minimal fixtures: a plan + subscription + transaction for our user.
      const { rows: planRows } = await pool.query(
        `INSERT INTO subscription_plans (name, price_monthly, status, sort_order)
         VALUES ($1, 99000, 'active', 200)
         RETURNING id`,
        [`Notif-Plan-${Date.now()}`],
      );
      const planId = planRows[0].id;

      const { rows: subRows } = await pool.query(
        `INSERT INTO user_subscriptions
           (user_id, plan_id, billing_cycle, price_paid, status,
            current_period_start, current_period_end)
         VALUES ($1, $2, 'monthly', 99000, 'pending_payment',
                 NOW(), NOW() + INTERVAL '1 month')
         RETURNING id`,
        [user.userId, planId],
      );
      const subId = subRows[0].id;

      const { rows: txRows } = await pool.query(
        `INSERT INTO transactions
           (user_id, subscription_id, type, amount, payment_method,
            payment_ref, status)
         VALUES ($1, $2, 'new', 99000, 'momo', 'TEST-REF', 'pending')
         RETURNING id`,
        [user.userId, subId],
      );
      const txId = txRows[0].id;

      const Subscription = require('../models/Subscription').default ??
        require('../models/Subscription');
      await Subscription.approveTransaction(txId);

      // Notification creation is fire-and-forget post-commit; poll briefly so
      // the microtask queue has time to flush before asserting.
      let row: any = null;
      for (let i = 0; i < 20 && !row; i++) {
        const { rows } = await pool.query(
          `SELECT title, message, link_url FROM user_notifications
            WHERE user_id = $1 AND type = 'subscription_activated'
              AND link_url = '/subscription/me'
            ORDER BY created_at DESC LIMIT 1`,
          [user.userId],
        );
        row = rows[0] ?? null;
        if (!row) await new Promise((r) => setTimeout(r, 25));
      }
      expect(row).not.toBeNull();
      expect(row.title).toBe('Đăng ký thành công');
    });

    it('rejectTransaction inserts a subscription_rejected notification with reason', async () => {
      const { rows: planRows } = await pool.query(
        `INSERT INTO subscription_plans (name, price_monthly, status, sort_order)
         VALUES ($1, 49000, 'active', 201)
         RETURNING id`,
        [`Notif-Plan-Reject-${Date.now()}`],
      );
      const planId = planRows[0].id;

      const { rows: subRows } = await pool.query(
        `INSERT INTO user_subscriptions
           (user_id, plan_id, billing_cycle, price_paid, status,
            current_period_start, current_period_end)
         VALUES ($1, $2, 'monthly', 49000, 'pending_payment',
                 NOW(), NOW() + INTERVAL '1 month')
         RETURNING id`,
        [user.userId, planId],
      );
      const subId = subRows[0].id;

      const { rows: txRows } = await pool.query(
        `INSERT INTO transactions
           (user_id, subscription_id, type, amount, payment_method,
            payment_ref, status)
         VALUES ($1, $2, 'new', 49000, 'momo', 'TEST-REF-REJ', 'pending')
         RETURNING id`,
        [user.userId, subId],
      );
      const txId = txRows[0].id;

      const Subscription = require('../models/Subscription').default ??
        require('../models/Subscription');
      await Subscription.rejectTransaction(txId, 'Số tiền không khớp');

      let row: any = null;
      for (let i = 0; i < 20 && !row; i++) {
        const { rows } = await pool.query(
          `SELECT message FROM user_notifications
            WHERE user_id = $1 AND type = 'subscription_rejected'
            ORDER BY created_at DESC LIMIT 1`,
          [user.userId],
        );
        row = rows[0] ?? null;
        if (!row) await new Promise((r) => setTimeout(r, 25));
      }
      expect(row).not.toBeNull();
      expect(row.message).toContain('Số tiền không khớp');
    });
  });
});
