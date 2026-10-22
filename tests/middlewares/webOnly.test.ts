import type { NextFunction, Request, Response } from 'express';
import { isApiPath, webOnly } from '../../middlewares/webOnly';

describe('isApiPath', () => {
  it.each(['/api', '/api/', '/api/v1/ebooks/1/lookup', '/API/v1/auth/login', '/Api/v1'])('%s is an API path', (path) => {
    expect(isApiPath({ path })).toBe(true);
  });

  it.each(['/', '/dashboard', '/auth/login', '/lookup/api/health', '/apiary', '/apis/v1', '/dictionary/api', '/x/api/v1'])('%s is not', (path) => {
    expect(isApiPath({ path })).toBe(false);
  });
});

describe('webOnly', () => {
  const run = (path: string) => {
    const handler = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const next = jest.fn();
    webOnly(handler)({ path } as Request, {} as Response, next);
    return { handler, next };
  };

  it('runs the handler for a web page', () => {
    const { handler, next } = run('/dashboard');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('skips the handler for /api/* and goes straight on', () => {
    const { handler, next } = run('/api/v1/ebooks/1/lookup');
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
