import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { TICKET_TRANSITIONS } from './qms.service.js';

const idParams = v.object({ id: v.uuid({ required: true }) });

const takeSchema = v.object({
  branchId: v.uuid(),
  customerId: v.uuid(),
  csId: v.uuid(),
});

const statusSchema = v.object({
  status: v.oneOf(Object.keys(TICKET_TRANSITIONS), { required: true }),
  csId: v.uuid(),
});

const listSchema = v.object({
  status: v.oneOf(Object.keys(TICKET_TRANSITIONS)),
  todayOnly: v.boolean(),
});

const periodSchema = v.object({ from: v.date(), to: v.date() });

const ratingSchema = v.object({
  transactionId: v.uuid(),
  qmsTicketId: v.uuid(),
  csId: v.uuid(),
  score: v.integer({ required: true, min: 1, max: 5 }),
  comment: v.string({ max: 500 }),
  ratedAt: v.datetime(),
});

export function registerQmsRoutes(router, { qms, guard }) {
  const { authenticate, authorize } = guard;
  const read = [authenticate, authorize(P.QMS_READ)];
  const write = [authenticate, authorize(P.QMS_WRITE)];

  router.get('/api/v1/qms/tickets', ...read, async (ctx) => {
    ok(ctx, await qms.list(actorOf(ctx), validate(listSchema, queryOf(ctx))));
  });

  router.post('/api/v1/qms/tickets', ...write, async (ctx) => {
    created(ctx, await qms.take(actorOf(ctx), validate(takeSchema, ctx.body)));
  });

  router.patch('/api/v1/qms/tickets/:id', ...write, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await qms.changeStatus(actorOf(ctx), id, validate(statusSchema, ctx.body)));
  });

  router.get('/api/v1/qms/summary', authenticate, authorize(P.REPORT_EXECUTIVE), async (ctx) => {
    ok(ctx, await qms.summary(actorOf(ctx), validate(periodSchema, queryOf(ctx))));
  });

  router.post('/api/v1/cs-ratings', authenticate, authorize(P.RATING_WRITE), async (ctx) => {
    created(ctx, await qms.rate(actorOf(ctx), validate(ratingSchema, ctx.body)));
  });

  router.get(
    '/api/v1/cs-ratings/summary',
    authenticate,
    authorize(P.REPORT_EXECUTIVE),
    async (ctx) => {
      ok(ctx, await qms.ratingSummary(actorOf(ctx), validate(periodSchema, queryOf(ctx))));
    },
  );
}
