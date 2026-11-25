import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { APPRAISAL_TRANSITIONS } from './appraisal.service.js';

const STATUSES = Object.keys(APPRAISAL_TRANSITIONS);

const idParams = v.object({ id: v.uuid({ required: true }) });
const listSchema = v.object({
  status: v.oneOf(STATUSES),
  page: v.integer({ min: 1, default: 1 }),
  pageSize: v.integer({ min: 1, max: 100, default: 20 }),
});
const createSchema = v.object({
  customerId: v.uuid({ required: true }),
  branchId: v.uuid(),
  itemDescription: v.string({ required: true, min: 3, max: 200 }),
  weightGram: v.number({ required: true, min: 0.001, max: 100_000 }),
  purityKarat: v.number({ required: true, min: 1, max: 24 }),
  offeredPrice: v.number({ required: true, min: 0, max: 99_999_999_999 }),
  notes: v.string({ max: 500 }),
});
const statusSchema = v.object({
  status: v.oneOf(STATUSES, { required: true }),
  finalPrice: v.number({ min: 0, max: 99_999_999_999 }),
});

export function registerAppraisalRoutes(router, { appraisals, guard }) {
  const { authenticate, authorize, idempotency } = guard;

  router.get('/api/v1/appraisals', authenticate, authorize(P.APPRAISAL_READ), async (ctx) => {
    const query = validate(listSchema, queryOf(ctx));
    ok(ctx, await appraisals.list(actorOf(ctx), query));
  });

  router.post(
    '/api/v1/appraisals',
    authenticate,
    authorize(P.APPRAISAL_WRITE),
    idempotency,
    async (ctx) => {
      const input = validate(createSchema, ctx.body);
      created(ctx, await appraisals.record(actorOf(ctx), input));
    },
  );

  router.patch(
    '/api/v1/appraisals/:id/status',
    authenticate,
    authorize(P.APPRAISAL_WRITE),
    idempotency,
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      const input = validate(statusSchema, ctx.body);
      ok(ctx, await appraisals.changeStatus(actorOf(ctx), id, input));
    },
  );
}
