import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';

/** Runs after requireAuth. Catalogue writes are staff-only. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(ApiError.forbidden('That is only available to Deck staff'));
    return;
  }
  next();
}
