import { createHash, randomBytes } from 'node:crypto';
import { Errors } from '../../core/errors.js';
import { safeEqual } from '../../security/crypto.js';
import { maskPhone } from '../../shared/phone.js';
import { PII_CONTEXT } from '../customers/customer.service.js';

export const SCOPES = Object.freeze({
  READ: 'customers:read',
  READ_PII: 'customers:read:pii',
});

const KEY_FORMAT = /^rei_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Opaque cursor: base64url of the last row's (updated_at, id). */
export const encodeCursor = (row) =>
  Buffer.from(JSON.stringify({ u: row.cursorAt, i: row.id })).toString('base64url');

export function decodeCursor(raw) {
  try {
    const { u, i } = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const valid =
      typeof u === 'string' &&
      !Number.isNaN(Date.parse(u)) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i);
    return valid ? { updatedAt: u, id: i } : null;
  } catch {
    return null;
  }
}

/** New key: "rei_<12 hex prefix>_<256-bit secret>". Only its SHA-256 is stored. */
export function generateApiKey() {
  const prefix = randomBytes(6).toString('hex');
  const key = `rei_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: sha256(key) };
}

/**
 * Partner API — lets other company systems (APPS, STORE) pull customer data.
 * Two scopes: `customers:read` (profile, cluster, loyalty, city/province) and
 * `customers:read:pii` (adds phone, NIK, email, birth data, street address).
 */
export function createPartnerService({ uow, pii, blindIndex }) {
  const repo = uow.repos.apiClients;

  /** Customer as seen by a partner system; identity data only with the PII scope. */
  function present(customer, withPii) {
    const base = {
      id: customer.id,
      fullName: customer.fullName,
      phoneMasked: maskPhone(customer.phoneLast4),
      tier: customer.tierCode,
      loyaltyPoints: customer.loyaltyPoints,
      clusters: customer.channels,
      homeBranchCode: customer.homeBranchCode,
      preferredChannel: customer.preferredChannel,
      marketingConsent: customer.marketingConsent,
      gender: customer.gender,
      city: customer.city,
      province: customer.province,
      occupation: customer.occupation,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
    if (!withPii) return base;
    const { encrypted } = customer;
    return {
      ...base,
      phone: pii.decrypt(encrypted.phone, PII_CONTEXT.phone),
      nik: encrypted.nik ? pii.decrypt(encrypted.nik, PII_CONTEXT.nik) : null,
      email: customer.email,
      birthPlace: customer.birthPlace,
      birthDate: customer.birthDate,
      addressLine: encrypted.address ? pii.decrypt(encrypted.address, PII_CONTEXT.address) : null,
      postalCode: customer.postalCode,
    };
  }

  const audit = (client, endpoint, count) =>
    uow.repos.audit.append({
      actor: { id: null, requestId: `api-client:${client.id}`, ip: null },
      action: 'PARTNER_API_READ',
      entityType: 'api_client',
      entityId: client.id,
      diff: { client: client.name, endpoint, count, pii: client.scopes.includes(SCOPES.READ_PII) },
    });

  return Object.freeze({
    /* ---------------- credentials (head office, via the API page) ---------------- */
    list: () => repo.list(),

    /** @returns {{ client, apiKey }} — the key is shown once and never stored. */
    async create(actor, { name, scopes }) {
      const { key, prefix, hash } = generateApiKey();
      try {
        const client = await uow.run(async ({ apiClients, audit: log }) => {
          const created = await apiClients.insert({
            name,
            keyPrefix: prefix,
            keyHash: hash,
            scopes,
            createdBy: actor.id,
          });
          await log.append({
            actor,
            action: 'API_CLIENT_CREATED',
            entityType: 'api_client',
            entityId: created.id,
            diff: { name, scopes },
          });
          return created;
        });
        return { client, apiKey: key };
      } catch (err) {
        if (err.code === '23505')
          throw Errors.conflict('An API client with this name already exists');
        throw err;
      }
    },

    async revoke(actor, id) {
      return uow.run(async ({ apiClients, audit: log }) => {
        const client = await apiClients.revoke(id);
        if (!client) throw Errors.notFound('Active API client');
        await log.append({
          actor,
          action: 'API_CLIENT_REVOKED',
          entityType: 'api_client',
          entityId: id,
          diff: { name: client.name },
        });
        return client;
      });
    },

    /* ---------------- partner requests ---------------- */
    /** Resolves a presented key to an active client, or throws 401. Constant-time compare. */
    async authenticate(rawKey) {
      const match = KEY_FORMAT.exec(rawKey ?? '');
      const client = match ? await repo.findActiveByPrefix(match[1]) : null;
      if (!client || !safeEqual(client.keyHash, sha256(rawKey))) {
        throw Errors.unauthorized('Invalid or revoked API key');
      }
      await repo.touchUsed(client.id);
      const { keyHash: _hash, ...safe } = client;
      return Object.freeze(safe);
    },

    async listCustomers(client, { updatedSince, cursor, limit }) {
      const after = cursor ? decodeCursor(cursor) : null;
      if (cursor && !after)
        throw Errors.validation([{ field: 'cursor', message: 'is not a valid cursor' }]);

      const withPii = client.scopes.includes(SCOPES.READ_PII);
      // One extra row tells us whether another page exists.
      const rows = await uow.repos.customers.changedSince({
        after,
        updatedSince,
        limit: limit + 1,
        withPii,
      });
      const page = rows.slice(0, limit);
      await audit(client, 'customers.list', page.length);
      return {
        items: page.map((c) => present(c, withPii)),
        nextCursor: rows.length > limit ? encodeCursor(page.at(-1)) : null,
      };
    },

    async getCustomer(client, id) {
      const withPii = client.scopes.includes(SCOPES.READ_PII);
      const customer = await uow.repos.customers.findForPartner(id, { withPii });
      if (!customer) throw Errors.notFound('Customer');
      await audit(client, 'customers.get', 1);
      return present(customer, withPii);
    },

    /** Exact lookup by phone or NIK (NIK needs the PII scope: it is itself identity data). */
    async lookup(client, { phone, nik }) {
      const withPii = client.scopes.includes(SCOPES.READ_PII);
      const phoneHash = phone ? blindIndex('phone', phone) : null;
      const nikHash = nik ? blindIndex('nik', nik) : null;
      if (nikHash && !withPii)
        throw Errors.forbidden('Looking up by NIK requires the customers:read:pii scope');
      const { customers } = uow.repos;
      const id = phoneHash
        ? await customers.findIdByPhoneHash(phoneHash)
        : await customers.findIdByNikHash(nikHash);
      if (!id) throw Errors.notFound('Customer');
      const customer = await customers.findForPartner(id, { withPii });
      await audit(client, phoneHash ? 'customers.lookup.phone' : 'customers.lookup.nik', 1);
      return present(customer, withPii);
    },
  });
}
