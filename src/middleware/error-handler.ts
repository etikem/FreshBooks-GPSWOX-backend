import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const e = err as Error & { status?: number; code?: string };
  const status = typeof e.status === 'number' ? e.status : 500;
  if (status >= 500) {
    logger.error(
      { err: e.message, stack: e.stack, path: req.path },
      'unhandled.error',
    );
  } else {
    logger.warn({ err: e.message, path: req.path }, 'request.error');
  }
  res.status(status).json({
    error: status >= 500 ? 'internal error' : e.message,
  });
}
