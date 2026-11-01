import { Router } from 'express';
import pool from '../../config/db';
import { apiError, apiSuccess } from '../../utils/apiResponse';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query.db === '1') {
    try {
      await pool.query('SELECT 1');
    } catch {
      return apiError(res, 503, 'DATABASE_UNAVAILABLE', 'Database is unavailable.');
    }
    return apiSuccess(res, { status: 'ok', db: 'ok' });
  }
  return apiSuccess(res, { status: 'ok' });
}));

export default router;
