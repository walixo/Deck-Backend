import type { NextFunction, Request, Response } from 'express';
import { User, type IUser } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { verifyToken } from '../utils/jwt';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

async function loadUser(token: string): Promise<IUser | null> {
  try {
    const payload = verifyToken(token);
    return await User.findById(payload.sub);
  } catch {
    return null;
  }
}

/** Rejects the request when no valid token is present. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) return next(ApiError.unauthorized());

  const user = await loadUser(token);
  if (!user) return next(ApiError.unauthorized('Your session has expired. Please sign in again.'));

  req.user = user;
  return next();
}

/** Attaches req.user when a valid token is present, but never blocks the request. */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);
  if (token) {
    const user = await loadUser(token);
    if (user) req.user = user;
  }
  return next();
}
