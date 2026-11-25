import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';

const idParams = v.object({ id: v.uuid({ required: true }) });
const summarySchema = v.object({
  activeDays: v.integer({ min: 1, max: 365, default: 30 }),
});
const storeTransactionSchema = v.object({
  side: v.oneOf(['BUY', 'SELL'], { required: true }),
  branchId: v.uuid(),
  description: v.string({ min: 3, max: 200 }),
  weightGram: v.number({ required: true, min: 0.001, max: 100_000 }),
  amount: v.number({ required: true, min: 0, max: 99_999_999_999 }),
});

export function registerSegmentRoutes(router, { segments, guard }) {
  const { authenticate, authorize, idempotency } = guard;

  router.get('/api/v1/segments/summary', authenticate, authorize(P.SEGMENT_READ), async (ctx) => {
    const query = validate(summarySchema, queryOf(ctx));
    ok(ctx, await segments.summary(actorOf(ctx), query));
  });

  router.get(
    '/api/v1/customers/:id/channels',
    authenticate,
    authorize(P.CUSTOMER_READ),
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      ok(ctx, await segments.channelsOf(actorOf(ctx), id));
    },
  );

  router.post(
    '/api/v1/customers/:id/transactions',
    authenticate,
    authorize(P.TRANSACTION_WRITE),
    idempotency,
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      const input = validate(storeTransactionSchema, ctx.body);
      created(ctx, await segments.recordStoreTransaction(actorOf(ctx), id, input));
    },
  );
}
