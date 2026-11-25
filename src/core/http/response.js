/**
 * Standardized envelope — every API response has the shape:
 *   { success, code, requestId, data?, meta?, error? }
 */
export function sendJson(ctx, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  ctx.response = { status, payload };
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  ctx.res.end(ctx.method === 'HEAD' ? undefined : body);
}

export function ok(ctx, data, { status = 200, code = 'OK', meta } = {}) {
  sendJson(ctx, status, { success: true, code, requestId: ctx.requestId, data, meta });
}

export function created(ctx, data) {
  ok(ctx, data, { status: 201, code: 'CREATED' });
}

export function fail(ctx, error) {
  if (ctx.res.headersSent) {
    ctx.res.destroy();
    return;
  }
  sendJson(ctx, error.status, {
    success: false,
    code: error.code,
    requestId: ctx.requestId,
    error: { message: error.message, details: error.details },
  });
}

export const pageMeta = (page, pageSize, total) => ({
  page,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
});
