/**
 * Errors the application knows about. The transport layer maps them to the
 * standard response envelope; anything else becomes a 500 and never leaks to the client.
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = Object.freeze({
  badRequest: (message = 'Invalid request', details) =>
    new AppError(400, 'BAD_REQUEST', message, details),
  unauthorized: (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have permission to perform this action') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (entity = 'Record') => new AppError(404, 'NOT_FOUND', `${entity} not found`),
  methodNotAllowed: (allowed) =>
    new AppError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { allowed }),
  conflict: (message = 'Data conflict') => new AppError(409, 'CONFLICT', message),
  passwordChangeRequired: () =>
    new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Please set a new password before continuing'),
  payloadTooLarge: () => new AppError(413, 'PAYLOAD_TOO_LARGE', 'Payload exceeds the size limit'),
  unsupportedMediaType: () =>
    new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'),
  validation: (details) =>
    new AppError(422, 'VALIDATION_FAILED', 'Input validation failed', details),
  tooManyRequests: () =>
    new AppError(429, 'RATE_LIMITED', 'Too many requests, please try again later'),
  internal: () => new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on the server'),
});

/** PostgreSQL error codes that are safe to turn into client errors. */
const PG_ERRORS = Object.freeze({
  23505: () => Errors.conflict('Duplicate data: this entry already exists'),
  23503: () => Errors.badRequest('Invalid data reference'),
  '22P02': () => Errors.badRequest('Invalid parameter format'),
});

export function toAppError(err) {
  if (err instanceof AppError) return err;
  const map = typeof err?.code === 'string' ? PG_ERRORS[err.code] : undefined;
  return map ? map() : Errors.internal();
}
