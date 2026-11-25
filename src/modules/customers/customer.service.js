import { Errors } from '../../core/errors.js';
import { pageMeta } from '../../core/http/response.js';
import { normalizeKyc } from '../../shared/kyc.js';
import { maskPhone } from '../../shared/phone.js';
import { branchScopeOf } from '../../shared/scope.js';

export const PII_CONTEXT = Object.freeze({
  phone: 'customers.phone',
  nik: 'customers.nik',
  address: 'customers.address',
});

const PROFILE_KEYS = ['fullName', 'email', 'preferredChannel', 'marketingConsent', 'homeBranchId'];
const CLEAR_KYC_KEYS = [
  'birthPlace',
  'birthDate',
  'gender',
  'city',
  'province',
  'postalCode',
  'occupation',
];

/** Public shape: the phone is always masked and no ciphertext ever leaves. */
function present({ phoneLast4, ...customer }) {
  return { ...customer, phoneMasked: maskPhone(phoneLast4) };
}

/** Customer 360 Service — profiles, search, audited PII reveal, history. */
export function createCustomerService({ uow, pii, blindIndex }) {
  const { customers } = uow.repos;

  /** API-shaped input → repository record: hashes and encrypts NIK/address, keeps the rest. */
  function toRecord(input) {
    const record = {};
    for (const key of [...PROFILE_KEYS, ...CLEAR_KYC_KEYS])
      if (input[key] !== undefined) record[key] = input[key];
    if (input.nik !== undefined) {
      record.nikHash = blindIndex('nik', input.nik);
      record.nikEncrypted = pii.encrypt(input.nik, PII_CONTEXT.nik);
    }
    if (input.addressLine !== undefined)
      record.addressEncrypted = pii.encrypt(input.addressLine, PII_CONTEXT.address);
    return record;
  }

  const hasKyc = (input) =>
    Boolean(input.nik || input.addressLine || CLEAR_KYC_KEYS.some((key) => input[key]));

  /** Audit diffs name the identity fields that changed but never contain their values. */
  const auditFields = (input) => Object.keys(input).filter((key) => input[key] !== undefined);

  const duplicate = (err) => {
    if (err.code === '23505')
      throw Errors.conflict('This phone number or NIK is already registered');
    throw err;
  };

  async function requireVisible(actor, id) {
    const customer = await customers.findById(id, branchScopeOf(actor));
    if (!customer) throw Errors.notFound('Customer');
    return customer;
  }

  return Object.freeze({
    /**
     * Name search is limited to the branch scope. An exact phone lookup works
     * across branches so customers from another branch can still be served at
     * the counter (the data shown stays masked).
     */
    async search(actor, { phone, q, segment, page, pageSize }) {
      const { items, total } = await customers.search({
        phoneHash: phone ? blindIndex('phone', phone) : null,
        name: q,
        segment,
        branchId: phone ? null : branchScopeOf(actor),
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return { items: items.map(present), meta: pageMeta(page, pageSize, total) };
    },

    async getById(actor, id) {
      return present(await requireVisible(actor, id));
    },

    async register(actor, input) {
      const homeBranchId = actor.branchId ?? input.homeBranchId ?? null;

      try {
        return await uow.run(async ({ customers: repo, audit }) => {
          const created = await repo.insert({
            ...toRecord(input),
            homeBranchId,
            kycSource: hasKyc(input)
              ? (input.kycSource ?? `Staff: ${actor.name ?? 'staff'}`)
              : undefined,
            phoneHash: blindIndex('phone', input.phone),
            phoneEncrypted: pii.encrypt(input.phone, PII_CONTEXT.phone),
            phoneLast4: input.phone.slice(-4),
            createdBy: actor.id,
          });
          const result = present(created);
          await audit.append({
            actor,
            action: 'CUSTOMER_CREATED',
            entityType: 'customer',
            entityId: created.id,
            diff: { after: result, fields: auditFields(input) },
          });
          return result;
        });
      } catch (err) {
        return duplicate(err);
      }
    },

    /** Staff edit of a customer's profile / identity data (overwrites; audited without values). */
    async update(actor, id, input) {
      await requireVisible(actor, id);
      const changes = toRecord(actor.branchId ? { ...input, homeBranchId: undefined } : input);
      if (Object.keys(changes).length === 0) return present(await requireVisible(actor, id));
      try {
        await uow.run(async ({ customers: repo, audit }) => {
          const changed = await repo.update(id, {
            ...changes,
            kycSource: `Staff: ${actor.name ?? actor.id}`,
          });
          if (changed) {
            await audit.append({
              actor,
              action: 'CUSTOMER_UPDATED',
              entityType: 'customer',
              entityId: id,
              diff: { fields: auditFields(input) },
            });
          }
        });
      } catch (err) {
        duplicate(err);
      }
      return present(await requireVisible(actor, id));
    },

    /**
     * Fills empty profile/identity fields from another system (partner API, CSV).
     * Existing values are never overwritten; unusable values are skipped.
     * @returns {Promise<{ enriched: boolean, rejected: string[] }>}
     */
    async enrich(actor, id, raw, { source }) {
      const { values, rejected } = normalizeKyc(raw);
      if (raw.email) values.email = raw.email;
      if (Object.keys(values).length === 0) return { enriched: false, rejected };

      const attempt = (changes) =>
        uow.run(async ({ customers: repo, audit }) => {
          const changed = await repo.update(
            id,
            { ...toRecord(changes), kycSource: source },
            { onlyBlank: true },
          );
          if (changed) {
            await audit.append({
              actor,
              action: 'CUSTOMER_ENRICHED',
              entityType: 'customer',
              entityId: id,
              diff: { source, fields: Object.keys(changes) },
            });
          }
          return changed;
        });
      try {
        return { enriched: await attempt(values), rejected };
      } catch (err) {
        // The NIK already belongs to another customer: keep the rest of the data.
        if (err.code !== '23505' || !values.nik) throw err;
        const { nik: _nik, ...rest } = values;
        return {
          enriched: await attempt(rest),
          rejected: [...rejected, 'nik (belongs to another customer)'],
        };
      }
    },

    /** Reveals full PII — every reveal is written to audit_logs. */
    async revealPii(actor, id) {
      const encrypted = await customers.findEncryptedPii(id, branchScopeOf(actor));
      if (!encrypted) throw Errors.notFound('Customer');

      const revealed = {
        phone: pii.decrypt(encrypted.phone, PII_CONTEXT.phone),
        nik: encrypted.nik ? pii.decrypt(encrypted.nik, PII_CONTEXT.nik) : null,
        addressLine: encrypted.address ? pii.decrypt(encrypted.address, PII_CONTEXT.address) : null,
      };
      await uow.repos.audit.append({
        actor,
        action: 'CUSTOMER_PII_REVEALED',
        entityType: 'customer',
        entityId: id,
        diff: { fields: Object.keys(revealed).filter((key) => revealed[key]) },
      });
      return revealed;
    },

    async timeline(actor, id, { limit }) {
      await requireVisible(actor, id);
      return customers.timeline(id, limit);
    },

    requireVisible,
  });
}
