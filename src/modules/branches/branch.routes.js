import { actorOf, queryOf } from '../../core/http/context.js';
import { ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';

const listSchema = v.object({ includeInactive: v.boolean() });
const idParams = v.object({ id: v.uuid({ required: true }) });
const updateSchema = v.object({
  name: v.string({ min: 2, max: 120 }),
  region: v.string({ max: 60 }),
  areaId: v.uuid(),
  googlePlaceId: v.string({ max: 120 }),
  address: v.string({ max: 200 }),
  city: v.string({ max: 80 }),
  province: v.string({ max: 80 }),
  timezone: v.string({ max: 32 }),
  isActive: v.boolean(),
});

export function registerBranchRoutes(router, { branches, guard }) {
  // Every signed-in role needs the outlet list (filters, forms), so this stays open.
  router.get('/api/v1/branches', guard.authenticate, async (ctx) => {
    const { includeInactive } = validate(listSchema, queryOf(ctx));
    ok(ctx, await branches.list(actorOf(ctx), { includeInactive: includeInactive ?? false }));
  });

  router.get('/api/v1/branches/:id', guard.authenticate, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await branches.get(actorOf(ctx), id));
  });

  router.patch(
    '/api/v1/branches/:id',
    guard.authenticate,
    guard.authorize(P.OUTLET_MANAGE),
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      ok(ctx, await branches.update(actorOf(ctx), id, validate(updateSchema, ctx.body)));
    },
  );
}
