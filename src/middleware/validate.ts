import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { ApiError } from '../utils/ApiError';

type Source = 'body' | 'query' | 'params';

/** Validates and replaces the given request section with the parsed result. */
export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req[source]);
      if (source === 'body') {
        req.body = parsed;
      } else {
        // req.query / req.params are getter-only in Express 5-style typings.
        Object.assign(req[source], parsed);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        }));
        next(ApiError.badRequest('Some fields need your attention', details));
        return;
      }
      next(error);
    }
  };
}
