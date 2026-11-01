import type { Request, Response } from 'express';
import pool from '../config/db';
import Admin from '../models/Admin';

const dashboardController = {
  async getDashboard(req: Request, res: Response) {
    try {
      // Thống kê nhanh — the four totals are one statement, read together with the admin list (it was four queries, then the list).
      const [{ rows: totals }, admins] = await Promise.all([
        pool.query(
          `SELECT (SELECT COUNT(*)::int FROM users)              AS users,
                  (SELECT COUNT(*)::int FROM admin_accounts)     AS admins,
                  (SELECT COUNT(*)::int FROM dictionary_entries) AS entries,
                  (SELECT COUNT(*)::int FROM lessons)            AS lessons`
        ),
        Admin.getAll(),
      ]);

      const stats = {
        users: totals[0].users,
        admins: totals[0].admins,
        entries: totals[0].entries,
        lessons: totals[0].lessons,
      };

      res.render('dashboard', {
        title: 'Dashboard',
        stats,
        admins,
      });
    } catch (err) {
      console.error('[Dashboard] Error:', err);
      req.flash('error', 'Không thể tải dữ liệu dashboard');
      res.render('dashboard', { title: 'Dashboard', stats: {}, admins: [] });
    }
  },
};

export = dashboardController;
