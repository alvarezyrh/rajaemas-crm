import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto.js';

// Header pinned to HS256 — prevents "alg confusion" / alg=none attacks.
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Token akses bertanda tangan HMAC-SHA256 (kompatibel format JWT HS256). */
export function createTokenService({ secret, ttlSec, issuer = 'rajaemas-crm', clock = Date.now }) {
  const sign = (input) => createHmac('sha256', secret).update(input).digest('base64url');
  const nowSec = () => Math.floor(clock() / 1000);

  return Object.freeze({
    ttlSec,

    issue(claims) {
      const iat = nowSec();
      const body = `${HEADER}.${encode({ ...claims, iss: issuer, iat, exp: iat + ttlSec })}`;
      return `${body}.${sign(body)}`;
    },

    /** @returns {object | null} the claims when valid, otherwise null. */
    verify(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== HEADER) return null;
      if (!safeEqual(sign(`${parts[0]}.${parts[1]}`), parts[2])) return null;

      let claims;
      try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (claims.iss !== issuer || typeof claims.exp !== 'number' || claims.exp <= nowSec()) {
        return null;
      }
      return claims;
    },
  });
}
