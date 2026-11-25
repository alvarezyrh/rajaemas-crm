/**
 * Customer intake — the single path for customer records that arrive from
 * outside (partner API syncs, mobile-app and e-commerce webhooks).
 *
 * Match order: the channel's account id → phone number → NIK (both via blind
 * index) → otherwise a new profile is created. A matched customer is never
 * overwritten: identity data only fills fields that are still empty.
 */
export function createCustomerIntake({ uow, customers, blindIndex }) {
  return Object.freeze({
    /**
     * @param {{ fullName: string|null, phone: string|null, email: string|null,
     *           accountId: string|null, kyc?: object }} candidate  (kyc already normalised)
     * @param {{ actor: object, channel: string|null, at?: Date, source?: string }} options
     * @returns {Promise<{ status: 'created'|'matched'|'skipped', customerId?: string,
     *                     enriched?: boolean, reason?: string }>}
     */
    async upsert(candidate, { actor, channel, at = new Date(), source }) {
      const { segments, customers: customerRepo } = uow.repos;
      const kyc = candidate.kyc ?? {};
      const phoneHash = candidate.phone ? blindIndex('phone', candidate.phone) : null;

      let customerId = null;
      if (channel && candidate.accountId) {
        customerId = await segments.findCustomerIdByAccount(channel, candidate.accountId);
      }
      if (!customerId && phoneHash) customerId = await customerRepo.findIdByPhoneHash(phoneHash);
      if (!customerId && kyc.nik)
        customerId = await customerRepo.findIdByNikHash(blindIndex('nik', kyc.nik));

      let status = 'matched';
      let enriched = false;
      if (!customerId) {
        if (!candidate.phone)
          return { status: 'skipped', reason: 'unknown account and no phone number' };
        if (!candidate.fullName) return { status: 'skipped', reason: 'new customer has no name' };
        try {
          const created = await customers.register(actor, {
            fullName: candidate.fullName,
            phone: candidate.phone,
            email: candidate.email ?? undefined,
            preferredChannel: candidate.email ? 'EMAIL' : 'WHATSAPP',
            marketingConsent: false,
            ...kyc,
            kycSource: Object.keys(kyc).length ? source : undefined,
          });
          customerId = created.id;
          status = 'created';
        } catch (err) {
          customerId = await customerRepo.findIdByPhoneHash(phoneHash); // created concurrently
          if (!customerId) throw err;
        }
      } else if (Object.keys(kyc).length || candidate.email) {
        ({ enriched } = await customers.enrich(
          actor,
          customerId,
          { ...kyc, email: candidate.email ?? undefined },
          { source },
        ));
      }

      if (channel) {
        try {
          await segments.touchChannel({
            customerId,
            channel,
            externalAccountId: candidate.accountId,
            at,
          });
        } catch (err) {
          if (err.code !== '23505') throw err;
          // the account id already belongs to another customer: keep the cluster link without it
          await segments.touchChannel({ customerId, channel, at });
        }
      }
      return { status, customerId, enriched };
    },
  });
}
