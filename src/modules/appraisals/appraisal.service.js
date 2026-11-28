import { Errors } from '../../core/errors.js';
import { pointsForAmount, tierForPoints } from '../../shared/loyalty.js';
import { assertOutletInScope, dataScopeOf, resolveScopedBranchId } from '../../shared/scope.js';
import { can, Permissions } from '../../security/rbac.js';
import { recordSettledBuyback } from '../segments/segment.service.js';

export const APPRAISAL_TRANSITIONS = Object.freeze({
  OFFERED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['SETTLED', 'REJECTED'],
  REJECTED: [],
  SETTLED: [],
});

/** Appraisal & Transaction Service — appraisal, offer, and buyback settlement. */
export function createAppraisalService({ uow }) {
  return Object.freeze({
    list(actor, { status, page, pageSize }) {
      return uow.repos.appraisals.list({
        scope: dataScopeOf(actor),
        status,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
    },

    async record(actor, input) {
      return uow.run(async ({ appraisals, branches, customers, audit }) => {
        const branchId = await resolveScopedBranchId(branches, actor, input.branchId);
        if (!(await customers.findById(input.customerId))) throw Errors.notFound('Customer');

        const appraisal = await appraisals.insert({ ...input, branchId, appraiserId: actor.id });
        await audit.append({
          actor,
          action: 'APPRAISAL_RECORDED',
          entityType: 'appraisal',
          entityId: appraisal.id,
          diff: { after: appraisal },
        });
        return appraisal;
      });
    },

    /**
     * Atomic status change. On SETTLED the final price, loyalty points, tier
     * and audit trail are updated in one transaction (Unit of Work).
     */
    async changeStatus(actor, id, { status, finalPrice }) {
      if (status === 'SETTLED' && !can(actor.role, Permissions.APPRAISAL_APPROVE)) {
        throw Errors.forbidden('Settling a transaction requires branch head approval');
      }

      return uow.run(async (repos) => {
        const { appraisals, customers, audit } = repos;
        const current = await appraisals.findById(id, { forUpdate: true });
        if (!current) throw Errors.notFound('Appraisal');
        await assertOutletInScope(repos.branches, actor, current.branchId);
        if (!APPRAISAL_TRANSITIONS[current.status].includes(status)) {
          throw Errors.conflict(`Status cannot change from ${current.status} to ${status}`);
        }

        let loyalty;
        let settledPrice;
        if (status === 'SETTLED') {
          settledPrice = finalPrice ?? current.offeredPrice;
          const pointsAwarded = pointsForAmount(settledPrice);
          const balance = await customers.addLoyaltyPoints(current.customerId, pointsAwarded);
          const tierCode = tierForPoints(balance.loyaltyPoints);
          if (tierCode !== balance.tierCode)
            await customers.updateTier(current.customerId, tierCode);
          loyalty = { pointsAwarded, balance: balance.loyaltyPoints, tierCode };
        }

        const updated = await appraisals.updateStatus(id, { status, finalPrice: settledPrice });
        // A settled buyback = the customer sold gold in store → STORE cluster.
        if (status === 'SETTLED') await recordSettledBuyback(repos, current, settledPrice);
        await audit.append({
          actor,
          action: 'APPRAISAL_STATUS_CHANGED',
          entityType: 'appraisal',
          entityId: id,
          diff: {
            before: { status: current.status },
            after: { status, finalPrice: updated.finalPrice },
            loyalty,
          },
        });
        return { ...updated, loyalty };
      });
    },
  });
}
