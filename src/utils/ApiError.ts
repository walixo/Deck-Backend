export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = 'Bad request', details?: unknown): ApiError {
    return new ApiError(400, message, details);
  }

  static unauthorized(message = 'You must be signed in to do that'): ApiError {
    return new ApiError(401, message);
  }

  static forbidden(message = 'You do not have permission to do that'): ApiError {
    return new ApiError(403, message);
  }

  static notFound(message = 'Not found'): ApiError {
    return new ApiError(404, message);
  }

  static conflict(message = 'Already exists'): ApiError {
    return new ApiError(409, message);
  }
}
