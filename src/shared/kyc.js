/**
 * Identity (KTP) field normalisation — pure functions shared by the API,
 * partner-API mapping and CSV import, so every source is cleaned the same way.
 * Each returns the canonical value, or undefined when the input is unusable.
 */

/** 16 digits; spaces/dots/dashes are ignored. Province code (first 2) must be 11–94. */
export function normalizeNik(raw) {
  const digits = String(raw ?? '').replace(/[\s.-]/g, '');
  if (!/^\d{16}$/.test(digits)) return undefined;
  const province = Number(digits.slice(0, 2));
  return province >= 11 && province <= 94 ? digits : undefined;
}

const GENDER = {
  M: 'M',
  MALE: 'M',
  L: 'M',
  'LAKI-LAKI': 'M',
  'LAKI LAKI': 'M',
  LAKI: 'M',
  PRIA: 'M',
  F: 'F',
  FEMALE: 'F',
  P: 'F',
  PEREMPUAN: 'F',
  WANITA: 'F',
  W: 'F',
};
/** M / F from English or Indonesian spellings (L/P, Laki-laki/Perempuan, Pria/Wanita). */
export const normalizeGender = (raw) =>
  GENDER[
    String(raw ?? '')
      .trim()
      .toUpperCase()
  ];

/**
 * YYYY-MM-DD from YYYY-MM-DD, DD-MM-YYYY or DD/MM/YYYY (the KTP order), optionally
 * with a time part. Rejects impossible dates, the future, and anything before 1900.
 */
export function normalizeBirthDate(raw, today = new Date()) {
  const s = String(raw ?? '')
    .trim()
    .slice(0, 10);
  let y, m, d;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) [, y, m, d] = match;
  else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [, d, m, y] = match;
  else return undefined;

  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return undefined;
  if (date > today || iso <= '1900-01-01') return undefined;
  return iso;
}

/** Indonesian postal codes are 5 digits (spreadsheets often drop nothing here, but trim anyway). */
export function normalizePostalCode(raw) {
  const s = String(raw ?? '').replace(/\s/g, '');
  return /^\d{5}$/.test(s) ? s : undefined;
}

/** Trimmed text with collapsed whitespace, or undefined when empty/too long. */
export function cleanText(raw, max) {
  if (raw === undefined || raw === null || typeof raw === 'object') return undefined;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  return s && s.length <= max ? s : undefined;
}

/** Field name → normaliser, used wherever identity data enters the system. */
export const KYC_FIELDS = Object.freeze({
  nik: normalizeNik,
  birthPlace: (v) => cleanText(v, 80),
  birthDate: (v) => normalizeBirthDate(v),
  gender: normalizeGender,
  addressLine: (v) => cleanText(v, 300),
  city: (v) => cleanText(v, 80),
  province: (v) => cleanText(v, 80),
  postalCode: normalizePostalCode,
  occupation: (v) => cleanText(v, 80),
});

/**
 * Normalises whichever identity fields are present. Unusable values are left
 * out and reported, so one bad field never blocks the rest of a record.
 * @returns {{ values: object, rejected: string[] }}
 */
export function normalizeKyc(input) {
  const values = {};
  const rejected = [];
  for (const [field, normalize] of Object.entries(KYC_FIELDS)) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = normalize(raw);
    if (value === undefined) rejected.push(field);
    else values[field] = value;
  }
  return { values, rejected };
}
