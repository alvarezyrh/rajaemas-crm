import { createHash } from 'node:crypto';
import { Errors } from '../core/errors.js';
import { sendJson } from '../core/http/response.js';

const KEY_PATTERN = /^[\w-]{16,128}$/;
const DAY_SEC = 24 * 60 * 60;

/**
 * Requires an `Idempotency-Key` header on transactional mutations.
 * - Retry with the same key and payload → the original response is replayed.
 * - Same key with a different payload → 422.
 * - Parallel requests with the same key → 409 while the first one runs.
 * Only successful responses are stored; errors release the key so the client can retry.
 */
export function idempotency({ cache, ttlSec = DAY_SEC }) {
  return async (ctx, next) => {
    const key = ctx.req.headers['idempotency-key'];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw Errors.badRequest(
        'The Idempotency-Key header is required (16–128 alphanumeric characters)',
      );
    }

    const fingerprint = createHash('sha256')
      .update(`${ctx.method} ${ctx.path}\n`)
      .update(ctx.rawBody ?? Buffer.alloc(0))
      .digest('hex');
    const cacheKey = `idem:${ctx.state.user?.id ?? 'anon'}:${key}`;

    const acquired = await cache.setIfAbsent(
      cacheKey,
      { state: 'processing', fingerprint },
      ttlSec,
    );
    if (!acquired) {
      const record = await cache.get(cacheKey);
      if (record?.fingerprint !== fingerprint) {
        throw Errors.validation([
          { field: 'Idempotency-Key', message: 'already used for a different payload' },
        ]);
      }
      if (record.state === 'processing') {
        throw Errors.conflict('A request with this Idempotency-Key is already being processed');
      }
      return sendJson(ctx, record.status, record.payload, { 'idempotent-replayed': 'true' });
    }

    try {
      await next();
    } catch (err) {
      await cache.del(cacheKey);
      throw err;
    }

    if (ctx.response && ctx.response.status < 400) {
      await cache.set(cacheKey, { state: 'done', fingerprint, ...ctx.response }, ttlSec);
    } else {
      await cache.del(cacheKey);
    }
  };
}
