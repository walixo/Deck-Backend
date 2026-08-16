import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { MulterError } from 'multer';
import { env } from '../config/env';
import { MAX_FILE_BYTES, MAX_FILES_PER_REQUEST } from '../config/uploads';
import { ApiError } from '../utils/ApiError';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
}

interface ErrorBody {
  message: string;
  details?: unknown;
  stack?: string;
}

// Express identifies error middleware by its four-parameter signature.
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let statusCode = 500;
  const body: ErrorBody = { message: 'Something went wrong on our end' };

  if (error instanceof ApiError) {
    statusCode = error.statusCode;
    body.message = error.message;
    if (error.details) body.details = error.details;
  } else if (error instanceof mongoose.Error.ValidationError) {
    statusCode = 400;
    body.message = 'Some fields need your attention';
    body.details = Object.values(error.errors).map((err) => ({
      field: err.path,
      message: err.message,
    }));
  } else if (error instanceof MulterError) {
    // Multer's own messages are terse ("File too large"); say what the limit is.
    statusCode = 400;
    body.message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `Each image must be under ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB`
        : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE'
          ? `You can upload at most ${MAX_FILES_PER_REQUEST} images at a time`
          : `Upload failed: ${error.message}`;
  } else if (error instanceof mongoose.Error.CastError) {
    statusCode = 400;
    body.message = `Invalid value for "${error.path}"`;
  } else if (isDuplicateKeyError(error)) {
    statusCode = 409;
    const field = Object.keys(error.keyPattern ?? {})[0] ?? 'value';
    body.message = `That ${field} is already taken`;
  } else if (error instanceof Error) {
    body.message = env.isProduction ? body.message : error.message;
    if (!env.isProduction) body.stack = error.stack;
  }

  if (statusCode >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', error);
  }

  res.status(statusCode).json({ success: false, error: body });
}

function isDuplicateKeyError(
  error: unknown,
): error is { code: number; keyPattern?: Record<string, unknown> } {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}
