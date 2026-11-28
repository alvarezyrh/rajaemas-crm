import { Errors } from '../../core/errors.js';
import { can, Permissions } from '../../security/rbac.js';
import { dataScopeOf, resolveScopedBranchId } from '../../shared/scope.js';

/** Queue state machine: unlisted transitions are rejected. */
export const TICKET_TRANSITIONS = Object.freeze({
  WAITING: ['SERVING', 'CANCELLED'],
  SERVING: ['DONE', 'CANCELLED'],
  DONE: [],
  CANCELLED: [],
});

/**
 * Queue (QMS) and service ratings.
 *
 * Queue numbers restart per outlet per local day, so the outlet's own time zone
 * decides when "today" rolls over — a WITA outlet does not reset with Jakarta.
 */
export function createQmsService({ uow }) {
  async function requireTicket(actor, id) {
    const ticket = await uow.repos.qms.findTicketById(id, dataScopeOf(actor));
    if (!ticket) throw Errors.notFound('Queue ticket');
    return ticket;
  }

  return Object.freeze({
    list(actor, { status, todayOnly }) {
      return uow.repos.qms.listTickets({
        scope: dataScopeOf(actor),
        status,
        todayOnly: todayOnly ?? true,
      });
    },

    get: requireTicket,

    /** Takes a queue number. The outlet row is locked so numbers never collide. */
    async take(actor, input) {
      return uow.run(async ({ qms, branches, audit }) => {
        const branchId = await resolveScopedBranchId(branches, actor, input.branchId);
        if (!(await branches.lockActive(branchId))) {
          throw Errors.badRequest('Branch is inactive or not found');
        }
        const ticketNo = await qms.nextTicketNo(branchId);
        if (!ticketNo) throw Errors.notFound('Outlet');
        const id = await qms.insertTicket({
          branchId,
          ticketNo,
          customerId: input.customerId ?? null,
          // Whoever takes the number serves it, unless another officer is named.
          csId: input.csId ?? (can(actor.role, Permissions.QMS_WRITE) ? actor.id : null),
        });
        await audit.append({
          actor,
          action: 'QMS_TICKET_TAKEN',
          entityType: 'qms_ticket',
          entityId: id,
          diff: { ticketNo, branchId, customerId: input.customerId ?? null },
        });
        return qms.findTicketById(id, dataScopeOf(actor));
      });
    },

    async changeStatus(actor, id, { status, csId }) {
      return uow.run(async ({ qms, audit }) => {
        const current = await qms.lockTicket(id);
        if (!current) throw Errors.notFound('Queue ticket');
        const scope = dataScopeOf(actor);
        if (scope.branchId && current.branchId !== scope.branchId)
          throw Errors.notFound('Queue ticket');
        if (scope.areaId && current.branchId) {
          const outlet = await uow.repos.branches.findById(current.branchId);
          if (outlet?.areaId !== scope.areaId) throw Errors.notFound('Queue ticket');
        }
        if (!TICKET_TRANSITIONS[current.status].includes(status))
          throw Errors.conflict(`Status cannot change from ${current.status} to ${status}`);

        await qms.updateTicket(id, {
          status,
          csId,
          served: status === 'SERVING',
          closed: status === 'DONE' || status === 'CANCELLED',
        });
        await audit.append({
          actor,
          action: 'QMS_TICKET_STATUS_CHANGED',
          entityType: 'qms_ticket',
          entityId: id,
          diff: { before: { status: current.status }, after: { status } },
        });
        return qms.findTicketById(id, scope);
      });
    },

    /**
     * Records a service rating. The officer and outlet are taken from the thing
     * being rated, so a rating can never be attributed to the wrong person.
     */
    async rate(actor, input) {
      let csId = input.csId ?? null;
      let branchId = null;
      const transactionId = input.transactionId ?? null;
      const qmsTicketId = input.qmsTicketId ?? null;

      if (!transactionId && !qmsTicketId) {
        throw Errors.validation([
          { field: 'transactionId|qmsTicketId', message: 'provide one of these' },
        ]);
      }
      if (qmsTicketId) {
        const ticket = await requireTicket(actor, qmsTicketId);
        branchId = ticket.branchId;
        csId = csId ?? ticket.csId;
      }
      if (transactionId) {
        const transaction = await uow.repos.transactions.findById(
          transactionId,
          dataScopeOf(actor),
        );
        if (!transaction) throw Errors.notFound('Transaction');
        branchId = branchId ?? transaction.branchId;
        csId = csId ?? transaction.csId;
      }
      if (!csId)
        throw Errors.validation([
          { field: 'csId', message: 'could not be derived; name the officer explicitly' },
        ]);
      if (!branchId)
        throw Errors.validation([{ field: 'branchId', message: 'could not be derived' }]);

      try {
        return await uow.run(async ({ qms, audit }) => {
          const id = await qms.insertRating({
            transactionId,
            qmsTicketId,
            csId,
            branchId,
            score: input.score,
            comment: input.comment,
            ratedAt: input.ratedAt,
          });
          await audit.append({
            actor,
            action: 'CS_RATING_RECORDED',
            entityType: 'cs_rating',
            entityId: id,
            // The score is the point of the record; the free-text comment is not stored here.
            diff: { csId, branchId, score: input.score },
          });
          return { id, csId, branchId, score: input.score };
        });
      } catch (err) {
        if (err.code === '23505') throw Errors.conflict('This visit has already been rated');
        throw err;
      }
    },

    summary(actor, { from, to }) {
      return uow.repos.qms.ticketSummary({ scope: dataScopeOf(actor), from, to });
    },

    ratingSummary(actor, { from, to }) {
      return uow.repos.qms.ratingSummary({ scope: dataScopeOf(actor), from, to });
    },
  });
}
