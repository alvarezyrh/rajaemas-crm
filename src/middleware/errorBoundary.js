import { toAppError } from '../core/errors.js';
import { fail } from '../core/http/response.js';

/** Catches every downstream error and turns it into a safe error envelope. */
export function errorBoundary() {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      const appError = toAppError(err);
      if (appError.status >= 500) ctx.log.error('http.unhandled_error', { err });
      fail(ctx, appError);
    }
  };
}
