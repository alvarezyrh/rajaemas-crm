import { Errors } from '../../core/errors.js';
import { assertOutletInScope, dataScopeOf, resolveScopedBranchId } from '../../shared/scope.js';

/** Appointment state machine: unlisted transitions are rejected. */
export const APPOINTMENT_TRANSITIONS = Object.freeze({
  SCHEDULED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
});
const RESCHEDULABLE = new Set(['SCHEDULED', 'CONFIRMED']);

/** Branch Appointment Service — visit slots with a per-slot capacity. */
export function createAppointmentService({ uow, slotMinutes, slotCapacity }) {
  const slotMs = slotMinutes * 60_000;

  async function ensureSlotAvailable(repo, branchId, scheduledAt, excludeId) {
    const from = new Date(Math.floor(scheduledAt.getTime() / slotMs) * slotMs);
    const to = new Date(from.getTime() + slotMs);
    const used = await repo.countActiveInSlot({ branchId, from, to, excludeId });
    if (used >= slotCapacity) throw Errors.conflict('That time slot is fully booked');
  }

  return Object.freeze({
    listByDay(actor, { date, branchId }) {
      const scope = dataScopeOf(actor);
      return uow.repos.appointments.listByDay({
        date,
        scope: { ...scope, branchId: scope.branchId ?? branchId ?? null },
      });
    },

    async create(actor, input, integration = null) {
      if (integration) {
        const existing = await uow.repos.appointments.findByIntegrationKey(
          integration.sourceId,
          integration.keyHash,
        );
        if (existing) return { appointment: existing, created: false };
      }

      try {
        const appointment = await uow.run(async ({ appointments, branches, audit }) => {
          const branchId = await resolveScopedBranchId(branches, actor, input.branchId);
          // Lock the branch row → parallel bookings at the same branch are serialised.
          if (!(await branches.lockActive(branchId))) {
            throw Errors.badRequest('Branch is inactive or not found');
          }
          await ensureSlotAvailable(appointments, branchId, input.scheduledAt);

          const created = await appointments.insert({
            ...input,
            branchId,
            createdBy: actor.id,
            integrationSourceId: integration?.sourceId,
            integrationKeyHash: integration?.keyHash,
          });
          await audit.append({
            actor,
            action: 'APPOINTMENT_CREATED',
            entityType: 'appointment',
            entityId: created.id,
            diff: { after: created },
          });
          return created;
        });
        return integration ? { appointment, created: true } : appointment;
      } catch (error) {
        if (integration && error.constraint === 'appointments_integration_external_uidx') {
          const existing = await uow.repos.appointments.findByIntegrationKey(
            integration.sourceId,
            integration.keyHash,
          );
          if (existing) return { appointment: existing, created: false };
        }
        throw error;
      }
    },

    /** Status change or reschedule (exactly one kind per request). */
    async update(actor, id, { status, scheduledAt }) {
      if (Boolean(status) === Boolean(scheduledAt)) {
        throw Errors.validation([
          { field: 'status|scheduledAt', message: 'provide exactly one of these' },
        ]);
      }

      return uow.run(async ({ appointments, branches, interactions, audit }) => {
        const current = await appointments.findById(id, { forUpdate: true });
        if (!current) throw Errors.notFound('Appointment');
        await assertOutletInScope(branches, actor, current.branchId);

        let next;
        if (scheduledAt) {
          if (!RESCHEDULABLE.has(current.status)) {
            throw Errors.conflict(
              `An appointment with status ${current.status} cannot be rescheduled`,
            );
          }
          await branches.lockActive(current.branchId);
          await ensureSlotAvailable(appointments, current.branchId, scheduledAt, id);
          next = await appointments.update(id, { status: 'SCHEDULED', scheduledAt });
        } else {
          if (!APPOINTMENT_TRANSITIONS[current.status].includes(status)) {
            throw Errors.conflict(`Status cannot change from ${current.status} to ${status}`);
          }
          next = await appointments.update(id, { status });
          if (status === 'COMPLETED') {
            await interactions.insert({
              customerId: current.customerId,
              branchId: current.branchId,
              channel: 'VISIT',
              direction: 'INBOUND',
              summary: `Branch visit completed (${current.serviceType})`,
              handledBy: actor.id,
            });
          }
        }

        await audit.append({
          actor,
          action: scheduledAt ? 'APPOINTMENT_RESCHEDULED' : 'APPOINTMENT_STATUS_CHANGED',
          entityType: 'appointment',
          entityId: id,
          diff: {
            before: { status: current.status, scheduledAt: current.scheduledAt },
            after: { status: next.status, scheduledAt: next.scheduledAt },
          },
        });
        return next;
      });
    },
  });
}
