import { hmacSha256Hex, safeEqual } from '../../security/crypto.js';

const PREFIX = 'sha256=';

/**
 * Verifikasi tanda tangan webhook omnichannel.
 *   X-Timestamp : unix seconds (replay protection, 5-minute default tolerance)
 *   X-Signature : sha256=<hex HMAC-SHA256 of "<timestamp>.<rawBody>">
 * Perbandingan memakai crypto.timingSafeEqual.
 */
export function verifyWebhookSignature({
  secret,
  rawBody,
  signature,
  timestamp,
  toleranceSec = 300,
  now = Date.now(),
}) {
  if (typeof signature !== 'string' || !signature.startsWith(PREFIX)) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;

  const expected = hmacSha256Hex(secret, `${ts}.`, rawBody ?? Buffer.alloc(0));
  return safeEqual(expected, signature.slice(PREFIX.length));
}
