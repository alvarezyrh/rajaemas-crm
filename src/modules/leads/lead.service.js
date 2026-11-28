import { Errors } from '../../core/errors.js';
import { pageMeta } from '../../core/http/response.js';
import { can, Permissions } from '../../security/rbac.js';
import { escapeLike } from '../../shared/sql.js';
import { maskPhone } from '../../shared/phone.js';
import { areaScopeOf, dataScopeOf, resolveScopedBranchId } from '../../shared/scope.js';

/** Lead funnel. `CONVERTED` is only reachable through `convert()`, `EXPIRED` only through a job. */
export const LEAD_TRANSITIONS = Object.freeze({
  NEW: ['CONTACTED', 'QUALIFIED', 'LOST'],
  CONTACTED: ['QUALIFIED', 'LOST'],
  QUALIFIED: ['LOST'],
  CONVERTED: [],
  LOST: [],
  EXPIRED: [],
});

/** Statuses a background job may expire (Phase F). */
export const EXPIRABLE = Object.freeze(new Set(['NEW', 'CONTACTED', 'QUALIFIED']));

const PHONE_CONTEXT = 'leads.phone';
const TERMINAL = new Set(['CONVERTED', 'LOST', 'EXPIRED']);

/**
 * Leads — the acquisition funnel in front of Customer 360.
 *
 * The phone number is encrypted with its own AAD context and blind-indexed with
 * the same `phone` domain as customers, so "is this number already a customer?"
 * is answerable without decrypting anything.
 */
export function createLeadService({ uow, pii, blindIndex, intake }) {
  const canReveal = (actor) => can(actor.role, Permissions.CUSTOMER_PII_REVEAL);

  /** Strips the ciphertext; the plain number only appears for roles that may reveal PII. */
  function present(lead, actor) {
    const { phoneEncrypted, phoneLast4, ...rest } = lead;
    const phoneMasked = maskPhone(phoneLast4);
    return canReveal(actor)
      ? { ...rest, phone: pii.decrypt(phoneEncrypted, PHONE_CONTEXT), phoneMasked }
      : { ...rest, phoneMasked };
  }

  async function requireVisible(actor, id) {
    const lead = await uow.repos.leads.findById(id, dataScopeOf(actor));
    if (!lead) throw Errors.notFound('Lead');
    return lead;
  }

  /** An outlet's area is derived, never trusted from the client. */
  async function resolvePlacement(actor, { branchId, areaId }) {
    const scopeArea = areaScopeOf(actor);
    if (branchId || actor.branchId) {
      const resolvedBranch = await resolveScopedBranchId(uow.repos.branches, actor, branchId);
      const outlet = await uow.repos.branches.findById(resolvedBranch);
      return { branchId: resolvedBranch, areaId: outlet?.areaId ?? null };
    }
    if (areaId) {
      if (scopeArea && scopeArea !== areaId) {
        throw Errors.forbidden('This record is outside your area scope');
      }
      const area = await uow.repos.areas.findById(areaId);
      if (!area || !area.isActive)
        throw Errors.validation([{ field: 'areaId', message: 'is not an active area' }]);
      return { branchId: null, areaId };
    }
    return { branchId: null, areaId: scopeArea };
  }

  async function checkReference(referenceId) {
    if (!referenceId) return;
    const reference = await uow.repos.references.findById(referenceId);
    if (!reference || !reference.isActive)
      throw Errors.validation([{ field: 'referenceId', message: 'is not an active channel' }]);
  }

  return Object.freeze({
    async search(actor, { status, referenceId, q, phone, page, pageSize }) {
      const { items, total } = await uow.repos.leads.search({
        scope: dataScopeOf(actor),
        status,
        referenceId,
        name: q ? escapeLike(q) : undefined,
        phoneHash: phone ? blindIndex('phone', phone) : undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return {
        items: items.map((lead) => present(lead, actor)),
        meta: pageMeta(page, pageSize, total),
      };
    },

    async get(actor, id) {
      return present(await requireVisible(actor, id), actor);
    },

    async create(actor, input) {
      await checkReference(input.referenceId);
      const phoneHash = blindIndex('phone', input.phone);

      // A lead is a prospect: a number that is already a customer, or already in
      // the funnel, is a data-entry mistake rather than a new lead.
      if (await uow.repos.customers.findIdByPhoneHash(phoneHash))
        throw Errors.conflict('This phone number is already a registered customer');
      if (await uow.repos.leads.findActiveIdByPhoneHash(phoneHash))
        throw Errors.conflict('There is already an open lead with this phone number');

      const { branchId, areaId } = await resolvePlacement(actor, input);

      try {
        return await uow.run(async ({ leads, audit }) => {
          const id = await leads.insert({
            fullName: input.fullName,
            phoneHash,
            phoneEncrypted: pii.encrypt(input.phone, PHONE_CONTEXT),
            phoneLast4: input.phone.slice(-4),
            email: input.email ?? null,
            referenceId: input.referenceId ?? null,
            areaId,
            branchId,
            notes: input.notes ?? null,
            ownerId: input.ownerId ?? actor.id,
            createdBy: actor.id,
          });
          await audit.append({
            actor,
            action: 'LEAD_CREATED',
            entityType: 'lead',
            entityId: id,
            // The audit trail records which fields were supplied, never their values.
            diff: {
              fields: Object.keys(input),
              referenceId: input.referenceId ?? null,
              areaId,
              branchId,
            },
          });
          return present(await leads.findById(id, dataScopeOf(actor)), actor);
        });
      } catch (err) {
        if (err.code === '23505')
          throw Errors.conflict('There is already an open lead with this phone number');
        throw err;
      }
    },

    /** Status change or field edit; terminal leads are read-only. */
    async update(actor, id, input) {
      const current = await requireVisible(actor, id);
      if (TERMINAL.has(current.status))
        throw Errors.conflict(`A ${current.status} lead can no longer be changed`);

      if (input.status && input.status !== current.status) {
        if (input.status === 'CONVERTED')
          throw Errors.conflict('Use the convert action to turn a lead into a customer');
        if (input.status === 'EXPIRED')
          throw Errors.conflict('Leads are expired automatically, not by hand');
        if (!LEAD_TRANSITIONS[current.status].includes(input.status))
          throw Errors.conflict(`Status cannot change from ${current.status} to ${input.status}`);
        if (input.status === 'LOST' && !(input.lostReason ?? current.lostReason))
          throw Errors.validation([
            { field: 'lostReason', message: 'is required when a lead is lost' },
          ]);
      }
      if (input.referenceId !== undefined) await checkReference(input.referenceId);

      const placement =
        input.branchId || input.areaId
          ? await resolvePlacement(actor, {
              branchId: input.branchId ?? current.branchId,
              areaId: input.areaId ?? current.areaId,
            })
          : null;

      const fields = {};
      for (const key of [
        'fullName',
        'email',
        'notes',
        'ownerId',
        'referenceId',
        'status',
        'lostReason',
      ])
        if (input[key] !== undefined) fields[key] = input[key];
      if (placement) Object.assign(fields, placement);
      if (fields.status === 'LOST' && !fields.lostReason) fields.lostReason = current.lostReason;

      const before = Object.fromEntries(Object.keys(fields).map((k) => [k, current[k]]));
      const updated = await uow.run(async ({ leads, audit }) => {
        const changed = await leads.update(id, fields);
        if (!changed) throw Errors.notFound('Lead');
        await audit.append({
          actor,
          action: fields.status ? 'LEAD_STATUS_CHANGED' : 'LEAD_UPDATED',
          entityType: 'lead',
          entityId: id,
          diff: { fields: Object.keys(fields), before, after: fields },
        });
        return leads.findById(id, dataScopeOf(actor));
      });
      return present(updated, actor);
    },

    /**
     * Turns a lead into a customer. Matching and profile creation go through the
     * shared intake path, so a lead whose number already belongs to a customer
     * simply links to that profile instead of creating a duplicate.
     *
     * Intake runs before the transaction (it manages its own); the transaction
     * then locks the lead, so two parallel conversions cannot both write.
     */
    async convert(actor, id) {
      const lead = await requireVisible(actor, id);
      if (lead.status === 'CONVERTED')
        return { customerId: lead.convertedCustomerId, alreadyConverted: true };
      if (TERMINAL.has(lead.status))
        throw Errors.conflict(`A ${lead.status} lead cannot be converted`);

      const phone = pii.decrypt(lead.phoneEncrypted, PHONE_CONTEXT);
      const at = new Date();
      const { status, customerId } = await intake.upsert(
        { fullName: lead.fullName, phone, email: lead.email, accountId: null },
        { actor, channel: null, at, source: 'Lead conversion' },
      );
      if (!customerId) throw Errors.conflict('The lead could not be linked to a customer profile');

      const result = await uow.run(async ({ leads, customers, audit }) => {
        const locked = await leads.findRawById(id, { forUpdate: true });
        if (locked.status === 'CONVERTED') {
          return { customerId: locked.converted_customer_id, alreadyConverted: true };
        }
        await customers.linkAcquisition(customerId, {
          leadId: id,
          referenceId: lead.referenceId,
        });
        await leads.markConverted(id, customerId, at);
        await audit.append({
          actor,
          action: 'LEAD_CONVERTED',
          entityType: 'lead',
          entityId: id,
          diff: { customerId, intakeStatus: status, before: { status: lead.status } },
        });
        return { customerId, alreadyConverted: false, intakeStatus: status };
      });
      return result;
    },

    /** Lead Summary — funnel totals per status, channel and area. */
    async summary(actor, { from, to }) {
      const summary = await uow.repos.leads.summary({
        scope: dataScopeOf(actor),
        from,
        to,
      });
      const { CONVERTED: converted, LOST: lost } = summary.byStatus;
      const decided = converted + lost;
      return {
        period: { from: from ?? null, to: to ?? null },
        ...summary,
        conversionRate: summary.total ? converted / summary.total : 0,
        // Conversion against leads that reached a decision, which is the fairer
        // read while a cohort is still young.
        decidedRate: decided ? converted / decided : 0,
        openLeads: summary.byStatus.NEW + summary.byStatus.CONTACTED + summary.byStatus.QUALIFIED,
      };
    },
  });
}
