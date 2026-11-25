import { actorOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { SEGMENTS } from '../../shared/segments.js';
import { PATH_PATTERN } from './mapping.js';

const PATH = { pattern: PATH_PATTERN, message: 'use a dot path such as data.items' };
const field = (opts = {}) => v.string({ max: 120, ...PATH, ...opts });

const idParams = v.object({ id: v.uuid({ required: true }) });
const runParams = v.object({ runId: v.uuid({ required: true }) });
const sourceSchema = v.object({
  name: v.string({ required: true, min: 2, max: 80 }),
  endpointUrl: v.string({ required: true, max: 500 }),
  authHeader: v.string({
    max: 64,
    pattern: /^[A-Za-z0-9-]+$/,
    message: 'letters, digits and dashes only',
  }),
  authToken: v.string({ max: 2000 }),
  channel: v.oneOf(SEGMENTS),
  listPath: field(),
  fieldMap: v.object(
    {
      fullName: field({ required: true }),
      phone: field({ required: true }),
      email: field(),
      accountId: field(),
      // identity (KTP) data — optional
      nik: field(),
      birthPlace: field(),
      birthDate: field(),
      gender: field(),
      addressLine: field(),
      city: field(),
      province: field(),
      postalCode: field(),
      occupation: field(),
    },
    { required: true },
  ),
  pagination: v.oneOf(['none', 'page'], { default: 'none' }),
  pageSize: v.integer({ min: 1, max: 1000, default: 100 }),
  isActive: v.boolean({ default: true }),
});

export function registerIntegrationRoutes(router, { integrations, guard }) {
  const { authenticate, authorize } = guard;
  const manage = [authenticate, authorize(P.INTEGRATION_MANAGE)];

  router.get('/api/v1/integrations', ...manage, async (ctx) => {
    ok(ctx, await integrations.overview());
  });

  router.post('/api/v1/integrations', ...manage, async (ctx) => {
    created(ctx, await integrations.create(actorOf(ctx), validate(sourceSchema, ctx.body)));
  });

  router.put('/api/v1/integrations/:id', ...manage, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await integrations.update(actorOf(ctx), id, validate(sourceSchema, ctx.body)));
  });

  router.delete('/api/v1/integrations/:id', ...manage, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    await integrations.remove(actorOf(ctx), id);
    ok(ctx, { id, deleted: true });
  });

  router.post('/api/v1/integrations/:id/test', ...manage, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await integrations.test(id));
  });

  router.post('/api/v1/integrations/:id/sync', ...manage, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await integrations.startSync(actorOf(ctx), id), { status: 202, code: 'ACCEPTED' });
  });

  router.get('/api/v1/integrations/runs/:runId', ...manage, async (ctx) => {
    const { runId } = validate(runParams, ctx.params);
    ok(ctx, await integrations.run(runId));
  });
}
