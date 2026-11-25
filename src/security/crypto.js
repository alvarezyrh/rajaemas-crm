import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/* ------------------------------------------------------------------ */
/* Enkripsi PII — AES-256-GCM                                          */
/* Format: v1.<keyId>.<iv>.<authTag>.<ciphertext> (base64url)          */
/* `context` is the AAD, so a ciphertext cannot be moved to another   */
/* column (e.g. a NIK copied into the phone column).                  */
/* ------------------------------------------------------------------ */
const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const FORMAT_VERSION = 'v1';

export function createPiiCipher(key, { keyId = 'k1' } = {}) {
  if (key.length !== 32) throw new Error('The PII key must be 32 bytes');

  return Object.freeze({
    encrypt(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(CIPHER, key, iv);
      cipher.setAAD(Buffer.from(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return [
        FORMAT_VERSION,
        keyId,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },

    decrypt(envelope, context) {
      const [version, kid, iv, tag, ciphertext] = String(envelope).split('.');
      if (version !== FORMAT_VERSION || kid !== keyId || ciphertext === undefined) {
        throw new Error('Unrecognised PII ciphertext format');
      }
      const decipher = createDecipheriv(CIPHER, key, Buffer.from(iv, 'base64url'), {
        authTagLength: 16,
      });
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  });
}

/**
 * Blind index (HMAC-SHA256) for exact lookups on encrypted data (e.g. phone
 * numbers) without storing plaintext. `domain` separates the hash spaces.
 */
export function createBlindIndexer(key) {
  return (domain, value) => createHmac('sha256', key).update(`${domain}:${value}`).digest('hex');
}

export function hmacSha256Hex(secret, ...parts) {
  const hmac = createHmac('sha256', secret);
  for (const part of parts) hmac.update(part);
  return hmac.digest('hex');
}

/** Constant-time string comparison (crypto.timingSafeEqual). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ------------------------------------------------------------------ */
/* Staff credential hashing — scrypt                                   */
/* Format: scrypt$N$r$p$<salt>$<hash>                                  */
/* ------------------------------------------------------------------ */
const SCRYPT = Object.freeze({ N: 16_384, r: 8, p: 1, keyLength: 64, maxmem: 64 * 1024 * 1024 });

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keyLength, maxmem } = SCRYPT;
  const hash = await scryptAsync(password.normalize('NFKC'), salt, keyLength, { N, r, p, maxmem });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const [algorithm, N, r, p, salt, hash] = String(stored).split('$');
  if (algorithm !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(
    password.normalize('NFKC'),
    Buffer.from(salt, 'base64url'),
    expected.length,
    {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    },
  );
  return timingSafeEqual(actual, expected);
}
