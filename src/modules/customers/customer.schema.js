import { v } from '../../core/validation.js';
import { EMAIL_PATTERN } from '../../shared/email.js';
import {
  normalizeBirthDate,
  normalizeGender,
  normalizeNik,
  normalizePostalCode,
} from '../../shared/kyc.js';
import { normalizeIndonesianPhone } from '../../shared/phone.js';
import { SEGMENT_FILTERS } from '../../shared/segments.js';

export const CHANNELS = Object.freeze(['WHATSAPP', 'PHONE', 'EMAIL', 'VISIT']);

const phone = (opts = {}) =>
  v.string({
    ...opts,
    max: 20,
    transform: normalizeIndonesianPhone,
    message: 'invalid Indonesian phone number',
  });

/** Identity (KTP) fields; all optional. Spellings are normalised (see shared/kyc.js). */
export const kycFields = Object.freeze({
  nik: v.string({
    max: 30,
    transform: normalizeNik,
    message: 'NIK must be 16 digits with a valid province code',
  }),
  birthPlace: v.string({ max: 80 }),
  birthDate: v.string({
    max: 30,
    transform: (s) => normalizeBirthDate(s),
    message: 'use YYYY-MM-DD or DD-MM-YYYY (not in the future)',
  }),
  gender: v.string({
    max: 20,
    transform: normalizeGender,
    message: 'use M or F (L/P also accepted)',
  }),
  addressLine: v.string({ max: 300 }),
  city: v.string({ max: 80 }),
  province: v.string({ max: 80 }),
  postalCode: v.string({ max: 10, transform: normalizePostalCode, message: 'must be 5 digits' }),
  occupation: v.string({ max: 80 }),
});

const email = v.string({ max: 160, pattern: EMAIL_PATTERN, transform: (s) => s.toLowerCase() });

export const createCustomerSchema = v.object({
  fullName: v.string({ required: true, min: 2, max: 120 }),
  phone: phone({ required: true }),
  email,
  preferredChannel: v.oneOf(CHANNELS, { default: 'WHATSAPP' }),
  marketingConsent: v.boolean({ default: false }),
  homeBranchId: v.uuid(),
  ...kycFields,
});

/** Profile edit by staff: every field optional; an empty field means "unchanged". */
export const updateCustomerSchema = v.object({
  fullName: v.string({ min: 2, max: 120 }),
  email,
  preferredChannel: v.oneOf(CHANNELS),
  marketingConsent: v.boolean(),
  homeBranchId: v.uuid(),
  ...kycFields,
});

export const searchCustomerSchema = v.object({
  phone: phone(),
  q: v.string({ min: 2, max: 60 }),
  segment: v.oneOf(SEGMENT_FILTERS),
  loyal: v.boolean(),
  page: v.integer({ min: 1, max: 10_000, default: 1 }),
  pageSize: v.integer({ min: 1, max: 100, default: 20 }),
});

export const timelineQuerySchema = v.object({
  limit: v.integer({ min: 1, max: 200, default: 50 }),
});
