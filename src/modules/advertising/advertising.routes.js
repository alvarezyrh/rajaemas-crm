import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';

const idParams = v.object({ id: v.uuid({ required: true }) });

const listSchema = v.object({
  from: v.date(),
  to: v.date(),
  areaId: v.uuid(),
  referenceId: v.uuid(),
});

const createSchema = v.object({
  areaId: v.uuid({ required: true }),
  referenceId: v.uuid({ required: true }),
  periodMonth: v.date({ required: true }),
  spendAmount: v.number({ required: true, min: 0 }),
  notes: v.string({ max: 300 }),
});

const updateSchema = v.object({
  areaId: v.uuid(),
  referenceId: v.uuid(),
  periodMonth: v.date(),
  spendAmount: v.number({ min: 0 }),
  notes: v.string({ max: 300 }),
});

const summarySchema = v.object({
  from: v.date(),
  to: v.date(),
  groupBy: v.oneOf(['area', 'reference'], { default: 'reference' }),
});

export function registerAdvertisingRoutes(router, { advertising, guard }) {
  const read = [guard.authenticate, guard.authorize(P.BUDGET_READ)];
  const write = [guard.authenticate, guard.authorize(P.BUDGET_MANAGE)];

  router.get('/api/v1/advertising-budgets', ...read, async (ctx) => {
    ok(ctx, await advertising.list(actorOf(ctx), validate(listSchema, queryOf(ctx))));
  });

  router.post('/api/v1/advertising-budgets', ...write, async (ctx) => {
    created(ctx, await advertising.create(actorOf(ctx), validate(createSchema, ctx.body)));
  });

  router.patch('/api/v1/advertising-budgets/:id', ...write, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await advertising.update(actorOf(ctx), id, validate(updateSchema, ctx.body)));
  });

  // The advertising summary is marketing's own report, so budget access is enough;
  // operational summaries (bonus, queue, transactions) need report:executive.
  router.get(
    '/api/v1/advertising/summary',
    guard.authenticate,
    guard.authorize(P.BUDGET_READ),
    async (ctx) => {
      ok(ctx, await advertising.summary(actorOf(ctx), validate(summarySchema, queryOf(ctx))));
    },
  );
}
