/**
 * Turning a partner API response into customer records (pure, no I/O).
 * A source describes where the list is (`listPath`) and where each field
 * lives inside a record (`fieldMap`), using dot paths such as "contact.phone".
 */
import { EMAIL_PATTERN } from '../../shared/email.js';
import { KYC_FIELDS, normalizeKyc } from '../../shared/kyc.js';
import { normalizeIndonesianPhone } from '../../shared/phone.js';

/** A dot path into a JSON record, e.g. "contact.phone". */
export const PATH_PATTERN = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;

/** The response does not have the shape the source configuration describes. */
export class ShapeError extends Error {}

/** Reads a dot path; never walks into prototypes. */
export function getPath(value, path) {
  if (!path) return value;
  let current = value;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key))
      return undefined;
    current = current[key];
  }
  return current;
}

/** @returns {unknown[]} the record list, or throws when the shape is wrong. */
export function extractList(payload, listPath) {
  const list = getPath(payload, listPath);
  if (!Array.isArray(list)) {
    throw new ShapeError(
      listPath ? `"${listPath}" in the response is not a list` : 'The response is not a list',
    );
  }
  return list;
}

const text = (value, max) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Maps one partner record to a customer candidate.
 * @returns {{ ok: true, value: object } | { ok: false, reason: string }}
 */
export function mapRecord(record, fieldMap) {
  if (record === null || typeof record !== 'object')
    return { ok: false, reason: 'record is not an object' };

  const fullName = text(getPath(record, fieldMap.fullName), 120);
  const rawPhone = text(getPath(record, fieldMap.phone), 40);
  const email = text(getPath(record, fieldMap.email), 160)?.toLowerCase() ?? null;
  const accountId = text(getPath(record, fieldMap.accountId), 128);

  const phone = rawPhone ? normalizeIndonesianPhone(rawPhone) : null;
  if (rawPhone && !phone) return { ok: false, reason: `invalid phone number "${rawPhone}"` };
  if (!phone && !accountId) return { ok: false, reason: 'no phone number or account id' };
  if (fullName !== null && fullName.length < 2) return { ok: false, reason: 'name is too short' };

  // Identity (KTP) fields are optional; a bad value drops that field, never the record.
  const rawKyc = {};
  for (const field of Object.keys(KYC_FIELDS)) {
    if (fieldMap[field]) rawKyc[field] = text(getPath(record, fieldMap[field]), 300);
  }
  const { values: kyc, rejected } = normalizeKyc(rawKyc);

  return {
    ok: true,
    value: {
      fullName,
      phone,
      email: email && EMAIL_PATTERN.test(email) ? email : null,
      accountId,
      kyc,
    },
    rejected,
  };
}
