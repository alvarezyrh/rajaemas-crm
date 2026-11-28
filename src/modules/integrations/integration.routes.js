import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { SEGMENTS } from '../../shared/segments.js';
import { PATH_PATTERN } from './mapping.js';
import { INTEGRATION_TARGETS } from './targets.js';

const PATH = { pattern: PATH_PATTERN, message: 'use a dot path such as data.items' };
const field = (opts = {}) => v.string({ max: 120, ...PATH, ...opts });

const idParams = v.object({ id: v.uuid({ required: true }) });
const runParams = v.object({ runId: v.uuid({ required: true }) });
const datasetQuery = v.object({
  page: v.integer({ min: 1, max: 10_000, default: 1 }),
  pageSize: v.integer({ min: 1, max: 100, default: 20 }),
});
const sourceSchema = v.object({
  name: v.string({ required: true, min: 2, max: 80 }),
  endpointUrl: v.string({ required: true, max: 500 }),
  targetType: v.oneOf(INTEGRATION_TARGETS, { default: 'CUSTOMER' }),
  datasetName: v.string({ max: 80 }),
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
      fullName: field(),
      email: field(),
      phone: field(),
      accountId: field(),
      nik: field(),
      birthPlace: field(),
      birthDate: field(),
      gender: field(),
      addressLine: field(),
      city: field(),
      province: field(),
      postalCode: field(),
      occupation: field(),
      sku: field(),
      name: field(),
      categoryCode: field(),
      karat: field(),
      baseWeightGram: field(),
      isBullion: field(),
      referenceCode: field(),
      branchCode: field(),
      areaCode: field(),
      notes: field(),
      externalId: field(),
      customerAccountId: field(),
      customerPhone: field(),
      serviceType: field(),
      scheduledAt: field(),
      transactionTypeCode: field(),
      invoiceNo: field(),
      description: field(),
      occurredAt: field(),
      items: field(),
      itemDescription: field(),
      itemWeightGram: field(),
      itemUnitPrice: field(),
      itemKarat: field(),
      itemProductSku: field(),
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

  router.get('/api/v1/integrations/:id/records', ...manage, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(
      ctx,
      await integrations.datasetRecords(actorOf(ctx), id, validate(datasetQuery, queryOf(ctx))),
    );
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
