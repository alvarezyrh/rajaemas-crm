/**
 * CSV import & export for customers.
 *
 * Import: the browser parses the file and sends rows in batches; every row is
 * validated with the same schema as the "New Customer" form, so CSV can never
 * create data the UI could not. `dryRun` checks everything without saving.
 *
 * Export: streams the customers the user can see (same branch scope and
 * filters as the list). Full phone numbers are included only for users who
 * may reveal PII; otherwise the masked number is exported. NIK is never
 * exported. Every export is written to the audit log.
 */
import { AppError, Errors } from '../../core/errors.js';
import { validate } from '../../core/validation.js';
import { can, Permissions } from '../../security/rbac.js';
import { branchScopeOf } from '../../shared/scope.js';
import { createCustomerSchema } from './customer.schema.js';

export const MAX_IMPORT_ROWS = 500;
const EXPORT_BATCH = 500;
const PHONE_CONTEXT = 'customers.phone';
const ADDRESS_CONTEXT = 'customers.address';

const CHANNEL_ALIASES = { WA: 'WHATSAPP', TELEPON: 'PHONE', TEL: 'PHONE', KUNJUNGAN: 'VISIT' };
/**
 * +6281234567801 → 0812-3456-7801. Spreadsheets keep this as text (no number
 * conversion, no formula), and the importer accepts it as-is.
 */
export function phoneForSpreadsheet(e164) {
  const local = `0${e164.replace(/^\+62/, '')}`;
  return local.replace(/^(\d{4})(\d{4})(\d+)$/, '$1-$2-$3');
}

const YES = new Set(['1', 'true', 'yes', 'y', 'ya']);
const NO = new Set(['0', 'false', 'no', 'n', 'tidak']);

/** Spreadsheet-friendly values → the API's canonical values. */
function normalizeRow(raw) {
  const channel = raw.preferredChannel
    ?.trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  const consent = raw.marketingConsent?.trim().toLowerCase();
  return {
    fullName: raw.fullName,
    phone: raw.phone,
    email: raw.email,
    nik: raw.nik,
    birthPlace: raw.birthPlace,
    birthDate: raw.birthDate,
    gender: raw.gender,
    addressLine: raw.addressLine,
    city: raw.city,
    province: raw.province,
    postalCode: raw.postalCode,
    occupation: raw.occupation,
    preferredChannel: channel ? (CHANNEL_ALIASES[channel] ?? channel) : undefined,
    marketingConsent:
      consent === undefined || consent === ''
        ? undefined
        : YES.has(consent)
          ? true
          : NO.has(consent)
            ? false
            : consent,
  };
}

export function createCustomerTransfer({ uow, customers, pii, blindIndex }) {
  return Object.freeze({
    /**
     * @param {Array<{ row: number } & Record<string, string>>} rows
     * @returns per-row results + totals; status is created | ready (dry run) | exists | invalid
     */
    async importRows(actor, rows, { dryRun }) {
      const branches = await uow.repos.branches.listActive();
      const branchIdByCode = new Map(branches.map((b) => [b.code.toUpperCase(), b.id]));
      const seenPhones = new Set();
      const results = [];

      for (const raw of rows) {
        const result = { row: raw.row };
        results.push(result);

        let input;
        try {
          const normalized = normalizeRow(raw);
          const code = raw.homeBranchCode?.trim().toUpperCase();
          if (code && !actor.branchId) {
            if (!branchIdByCode.has(code)) {
              throw Errors.validation([
                { field: 'home_branch_code', message: `unknown branch "${raw.homeBranchCode}"` },
              ]);
            }
            normalized.homeBranchId = branchIdByCode.get(code);
          }
          input = validate(createCustomerSchema, normalized);
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          Object.assign(result, {
            status: 'invalid',
            errors: (err.details ?? []).map((d) => `${d.field}: ${d.message}`),
          });
          continue;
        }

        const phoneHash = blindIndex('phone', input.phone);
        if (seenPhones.has(phoneHash)) {
          Object.assign(result, {
            status: 'exists',
            errors: ['phone number repeated earlier in this file'],
          });
          continue;
        }
        seenPhones.add(phoneHash);

        const existingId = await uow.repos.customers.findIdByPhoneHash(phoneHash);
        if (existingId) {
          Object.assign(result, { status: 'exists', customerId: existingId });
          continue;
        }
        if (dryRun) {
          result.status = 'ready';
          continue;
        }
        try {
          const created = await customers.register(actor, { ...input, kycSource: 'CSV import' });
          Object.assign(result, { status: 'created', customerId: created.id });
        } catch (err) {
          if (err.status !== 409) throw err;
          Object.assign(result, { status: 'exists', errors: [err.message] });
        }
      }

      const totals = { created: 0, ready: 0, exists: 0, invalid: 0 };
      for (const r of results) totals[r.status] += 1;
      if (!dryRun && totals.created > 0) {
        await uow.repos.audit.append({
          actor,
          action: 'CUSTOMERS_IMPORTED',
          entityType: 'customer',
          diff: { source: 'csv', ...totals },
        });
      }
      return { dryRun, totals, results };
    },

    /** Async generator of export rows (header first). */
    async *exportRows(actor, { q, phone, segment }) {
      const includePhone = can(actor.role, Permissions.CUSTOMER_PII_REVEAL);
      const query = {
        phoneHash: phone ? blindIndex('phone', phone) : null,
        name: q,
        segment,
        branchId: phone ? null : branchScopeOf(actor),
        withEncryptedPhone: includePhone,
      };

      yield [
        'id',
        'full_name',
        'phone',
        'email',
        'tier',
        'loyalty_points',
        'home_branch_code',
        'preferred_channel',
        'marketing_consent',
        'clusters',
        'gender',
        'occupation',
        'city',
        'province',
        ...(includePhone ? ['birth_place', 'birth_date', 'address', 'postal_code'] : []),
        'registered_at',
      ];

      let exported = 0;
      for (let offset = 0; ; offset += EXPORT_BATCH) {
        const { items } = await uow.repos.customers.search({
          ...query,
          limit: EXPORT_BATCH,
          offset,
        });
        for (const c of items) {
          yield [
            c.id,
            c.fullName,
            includePhone
              ? phoneForSpreadsheet(pii.decrypt(c.phoneEncrypted, PHONE_CONTEXT))
              : `••••-••••-${c.phoneLast4}`,
            c.email,
            c.tierCode,
            c.loyaltyPoints,
            c.homeBranchCode,
            c.preferredChannel,
            c.marketingConsent ? 'yes' : 'no',
            c.channels.join('|'),
            c.gender,
            c.occupation,
            c.city,
            c.province,
            ...(includePhone
              ? [
                  c.birthPlace,
                  c.birthDate,
                  c.addressEncrypted ? pii.decrypt(c.addressEncrypted, ADDRESS_CONTEXT) : null,
                  c.postalCode,
                ]
              : []),
            c.createdAt,
          ];
        }
        exported += items.length;
        if (items.length < EXPORT_BATCH) break;
      }

      await uow.repos.audit.append({
        actor,
        action: 'CUSTOMERS_EXPORTED',
        entityType: 'customer',
        diff: {
          count: exported,
          fullPhoneNumbers: includePhone,
          filters: { q: q ?? null, segment: segment ?? null, byPhone: Boolean(phone) },
        },
      });
    },
  });
}
