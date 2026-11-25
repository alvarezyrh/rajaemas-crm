/** Password rules for staff accounts (pure, no I/O). */
import { randomInt } from 'node:crypto';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** @returns {string|null} why the password is not acceptable, or null when it is. */
export function passwordProblem(password, { email = '', fullName = '' } = {}) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN)
    return `must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `must be at most ${PASSWORD_MAX} characters`;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password))
    return 'must contain both letters and numbers';
  const lower = password.toLowerCase();
  const localPart = email.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 3 && lower.includes(localPart))
    return 'must not contain your email name';
  const nameParts = fullName
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length >= 4);
  if (nameParts.some((part) => lower.includes(part))) return 'must not contain your name';
  return null;
}

// No look-alike characters (0/O, 1/l/I) so a temporary password can be read out or typed easily.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** Random temporary password, e.g. "Hk7m-Qz3p-Tw9e" (always has letters and digits). */
export function temporaryPassword() {
  for (;;) {
    const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const pw = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
    if (passwordProblem(pw) === null) return pw;
  }
}
