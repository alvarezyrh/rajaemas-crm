import { Errors } from '../errors.js';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

async function readRaw(req, limitBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes) throw Errors.payloadTooLarge();

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Errors.payloadTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/**
 * Reads the body with a size limit (anti-DoS), keeps `ctx.rawBody`
 * (dibutuhkan verifikasi HMAC webhook) dan `ctx.body` hasil parse JSON.
 */
export function jsonBody({ limitBytes }) {
  return async (ctx, next) => {
    if (METHODS_WITH_BODY.has(ctx.method)) {
      const raw = await readRaw(ctx.req, limitBytes);
      ctx.rawBody = raw;
      ctx.body = {};

      if (raw.length > 0) {
        const type = (ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') throw Errors.unsupportedMediaType();
        try {
          ctx.body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw Errors.badRequest('Invalid JSON body');
        }
      }
    }
    await next();
  };
}
