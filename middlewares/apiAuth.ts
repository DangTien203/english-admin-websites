import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { loadAuthUser } from '../utils/authUserCache';
import { apiError } from '../utils/apiResponse';

export interface ApiRequest extends Request {
  user?: {
    id: string;
    email: string;
    full_name: string;
    level: string;
    status: string;
    streak_current: number;
    streak_longest: number;
    avatar_url: string | null;
  };
}

interface JwtPayload {
  userId: string;
  email: string;
}

/**
 * optionalApiAuth — giống requireApiAuth nhưng:
 *  - Không có Bearer header → next() bình thường (guest).
 *  - Token invalid/expired/banned → next() bình thường (guest, không ném lỗi).
 *  - Token hợp lệ → req.user được set, y hệt requireApiAuth.
 * Dùng cho endpoints công khai nhưng muốn nhận context user nếu có (vd: log lookup).
 *
 * The user row comes from utils/authUserCache.ts: kept a few seconds instead of one database round trip per request.
 */
export const optionalApiAuth = async (
  req: ApiRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    const user = await loadAuthUser(decoded.userId);
    if (user && user.status !== 'banned') {
      req.user = user;
    }
  } catch {
    // Token lỗi trong guest-mode → nuốt; coi như guest.
  }
  next();
};

export const requireApiAuth = async (
  req: ApiRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      apiError(res, 401, 'NO_TOKEN', 'Không có token xác thực');
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    const user = await loadAuthUser(decoded.userId);

    if (!user) {
      apiError(res, 401, 'INVALID_TOKEN', 'User không tồn tại');
      return;
    }

    if (user.status === 'banned') {
      apiError(res, 403, 'ACCOUNT_BANNED', 'Tài khoản đã bị khóa');
      return;
    }

    req.user = user;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      apiError(res, 401, 'TOKEN_EXPIRED', 'Token đã hết hạn');
      return;
    }
    apiError(res, 401, 'INVALID_TOKEN', 'Token không hợp lệ');
  }
};
