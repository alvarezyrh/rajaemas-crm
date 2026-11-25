import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { EMAIL_PATTERN } from '../../shared/email.js';
import { ROLES } from './user.service.js';

const idParams = v.object({ id: v.uuid({ required: true }) });
const listSchema = v.object({
  q: v.string({ max: 80 }),
  role: v.oneOf(ROLES),
  active: v.boolean(),
});
const createSchema = v.object({
  email: v.string({
    required: true,
    max: 160,
    pattern: EMAIL_PATTERN,
    message: 'invalid email address',
    transform: (s) => s.toLowerCase(),
  }),
  fullName: v.string({ required: true, min: 2, max: 120 }),
  role: v.oneOf(ROLES, { required: true }),
  branchId: v.uuid(),
});
const updateSchema = v.object({
  fullName: v.string({ required: true, min: 2, max: 120 }),
  role: v.oneOf(ROLES, { required: true }),
  branchId: v.uuid(),
  isActive: v.boolean({ required: true }),
});

export function registerUserRoutes(router, { users, guard }) {
  const manage = [guard.authenticate, guard.authorize(P.USER_MANAGE)];

  router.get('/api/v1/users', ...manage, async (ctx) => {
    ok(ctx, await users.list(validate(listSchema, queryOf(ctx))));
  });

  router.post('/api/v1/users', ...manage, async (ctx) => {
    created(ctx, await users.create(actorOf(ctx), validate(createSchema, ctx.body)));
  });

  router.patch('/api/v1/users/:id', ...manage, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await users.update(actorOf(ctx), id, validate(updateSchema, ctx.body)));
  });

  router.post('/api/v1/users/:id/reset-password', ...manage, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await users.resetPassword(actorOf(ctx), id));
  });
}
