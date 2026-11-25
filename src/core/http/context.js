import { randomUUID } from 'node:crypto';

const REQUEST_ID = /^[\w.-]{8,128}$/;

function parseUrl(rawUrl) {
  try {
    return new URL(`http://localhost${rawUrl ?? '/'}`);
  } catch {
    return new URL('http://localhost/');
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Per-request context passed through every middleware and handler. */
export function createContext(req, res, { trustProxy, logger }) {
  const url = parseUrl(req.url);
  const incomingId = req.headers['x-request-id'];
  const requestId =
    typeof incomingId === 'string' && REQUEST_ID.test(incomingId) ? incomingId : randomUUID();
  res.setHeader('x-request-id', requestId);

  return {
    req,
    res,
    requestId,
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    ip: clientIp(req, trustProxy),
    params: {},
    state: {},
    body: undefined,
    rawBody: undefined,
    /** Last JSON response sent (used by idempotency and logging). */
    response: undefined,
    log: logger.child({ requestId }),
  };
}

/** The acting user, as passed to the service layer (no HTTP details). */
export function actorOf(ctx) {
  const { user } = ctx.state;
  return Object.freeze({
    id: user.id,
    role: user.role,
    branchId: user.branchId,
    name: user.name,
    sessionId: user.sessionId,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });
}

/** Query string → plain object, ready for validation. */
export const queryOf = (ctx) => Object.fromEntries(ctx.query);
