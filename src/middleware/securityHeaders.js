const HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
});

export function securityHeaders({ hsts }) {
  return async (ctx, next) => {
    for (const [name, value] of Object.entries(HEADERS)) ctx.res.setHeader(name, value);
    if (hsts) ctx.res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    await next();
  };
}
