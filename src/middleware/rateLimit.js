import { Errors } from '../core/errors.js';

/**
 * Fixed-window rate limiter on the cache (with Redis it applies across instances).
 * @param {{ cache, name: string, limit: number, windowSec: number,
 *           keyOf?: (ctx) => string, skip?: (ctx) => boolean }} options
 */
export function rateLimit({ cache, name, limit, windowSec, keyOf = (ctx) => ctx.ip, skip }) {
  return async (ctx, next) => {
    if (skip?.(ctx)) return next();

    const nowSec = Math.floor(Date.now() / 1000);
    const window = Math.floor(nowSec / windowSec);
    const count = await cache.incr(`rl:${name}:${keyOf(ctx)}:${window}`, windowSec);

    ctx.res.setHeader('ratelimit-limit', limit);
    ctx.res.setHeader('ratelimit-remaining', Math.max(0, limit - count));

    if (count > limit) {
      ctx.res.setHeader('retry-after', (window + 1) * windowSec - nowSec);
      throw Errors.tooManyRequests();
    }
    await next();
  };
}
