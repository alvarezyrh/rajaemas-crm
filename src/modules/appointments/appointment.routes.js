import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { APPOINTMENT_TRANSITIONS } from './appointment.service.js';

const SERVICE_TYPES = ['APPRAISAL', 'BUYBACK', 'CONSULTATION'];

const idParams = v.object({ id: v.uuid({ required: true }) });
const listSchema = v.object({ date: v.date({ required: true }), branchId: v.uuid() });
const createSchema = v.object({
  customerId: v.uuid({ required: true }),
  branchId: v.uuid(),
  serviceType: v.oneOf(SERVICE_TYPES, { required: true }),
  scheduledAt: v.datetime({ required: true, future: true }),
  notes: v.string({ max: 500 }),
});
const updateSchema = v.object({
  status: v.oneOf(Object.keys(APPOINTMENT_TRANSITIONS)),
  scheduledAt: v.datetime({ future: true }),
});

export function registerAppointmentRoutes(router, { appointments, guard }) {
  const { authenticate, authorize, idempotency } = guard;

  router.get('/api/v1/appointments', authenticate, authorize(P.APPOINTMENT_READ), async (ctx) => {
    const query = validate(listSchema, queryOf(ctx));
    ok(ctx, await appointments.listByDay(actorOf(ctx), query));
  });

  router.post(
    '/api/v1/appointments',
    authenticate,
    authorize(P.APPOINTMENT_WRITE),
    idempotency,
    async (ctx) => {
      const input = validate(createSchema, ctx.body);
      created(ctx, await appointments.create(actorOf(ctx), input));
    },
  );

  router.patch(
    '/api/v1/appointments/:id',
    authenticate,
    authorize(P.APPOINTMENT_WRITE),
    idempotency,
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      const input = validate(updateSchema, ctx.body);
      ok(ctx, await appointments.update(actorOf(ctx), id, input));
    },
  );
}
