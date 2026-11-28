import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P, roleMatrix } from '../../security/rbac.js';

const idParams = v.object({ id: v.uuid({ required: true }) });
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const codeField = (max = 32) =>
  v.string({
    required: true,
    max,
    pattern: CODE,
    message: 'use uppercase letters, digits, - or _',
  });
const listQuery = v.object({ includeInactive: v.boolean(), q: v.string({ max: 80 }) });

const CHANNEL_TYPES = [
  'DIGITAL_ADS',
  'SOCIAL',
  'SEARCH',
  'WALK_IN',
  'APP',
  'REFERRAL',
  'EVENT',
  'OTHER',
];

/**
 * Wires the four verbs every master-data entity shares:
 * GET list · GET one · POST create · PATCH update.
 * Reading needs `masterdata:read`; writing needs `masterdata:manage`.
 */
function registerEntity(router, guard, path, service, { createSchema, updateSchema, listSchema }) {
  const read = [guard.authenticate, guard.authorize(P.MASTERDATA_READ)];
  const write = [guard.authenticate, guard.authorize(P.MASTERDATA_MANAGE)];
  const query = listSchema ?? listQuery;

  router.get(`/api/v1/${path}`, ...read, async (ctx) => {
    ok(ctx, await service.list(validate(query, queryOf(ctx))));
  });
  router.post(`/api/v1/${path}`, ...write, async (ctx) => {
    created(ctx, await service.create(actorOf(ctx), validate(createSchema, ctx.body)));
  });
  router.patch(`/api/v1/${path}/:id`, ...write, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await service.update(actorOf(ctx), id, validate(updateSchema, ctx.body)));
  });
}

export function registerMasterdataRoutes(router, { masterdata, guard }) {
  registerEntity(router, guard, 'areas', masterdata.areas, {
    createSchema: v.object({
      code: codeField(16),
      name: v.string({ required: true, min: 2, max: 120 }),
      province: v.string({ required: true, max: 80 }),
      city: v.string({ max: 80 }),
      regionCode: v.string({ max: 16 }),
    }),
    updateSchema: v.object({
      name: v.string({ min: 2, max: 120 }),
      province: v.string({ max: 80 }),
      city: v.string({ max: 80 }),
      regionCode: v.string({ max: 16 }),
      isActive: v.boolean(),
    }),
  });

  registerEntity(router, guard, 'references', masterdata.references, {
    createSchema: v.object({
      code: codeField(),
      name: v.string({ required: true, min: 2, max: 120 }),
      channelType: v.oneOf(CHANNEL_TYPES, { required: true }),
    }),
    updateSchema: v.object({
      name: v.string({ min: 2, max: 120 }),
      channelType: v.oneOf(CHANNEL_TYPES),
      isActive: v.boolean(),
    }),
  });

  registerEntity(router, guard, 'product-categories', masterdata.productCategories, {
    createSchema: v.object({
      code: codeField(),
      name: v.string({ required: true, min: 2, max: 120 }),
    }),
    updateSchema: v.object({
      name: v.string({ min: 2, max: 120 }),
      isActive: v.boolean(),
    }),
  });

  registerEntity(router, guard, 'products', masterdata.products, {
    createSchema: v.object({
      sku: v.string({ required: true, max: 64, pattern: /^[A-Za-z0-9._-]{2,64}$/ }),
      name: v.string({ required: true, min: 2, max: 160 }),
      categoryId: v.uuid(),
      karat: v.number({ min: 0.1, max: 24 }),
      baseWeightGram: v.number({ min: 0.001 }),
      isBullion: v.boolean(),
    }),
    updateSchema: v.object({
      // The SKU is the stable reference used by transaction items: it never changes.
      name: v.string({ min: 2, max: 160 }),
      categoryId: v.uuid(),
      karat: v.number({ min: 0.1, max: 24 }),
      baseWeightGram: v.number({ min: 0.001 }),
      isBullion: v.boolean(),
      isActive: v.boolean(),
    }),
    listSchema: v.object({
      includeInactive: v.boolean(),
      q: v.string({ max: 80 }),
      categoryId: v.uuid(),
      bullion: v.boolean(),
    }),
  });

  registerEntity(router, guard, 'transaction-types', masterdata.transactionTypes, {
    createSchema: v.object({
      code: codeField(),
      name: v.string({ required: true, min: 2, max: 120 }),
      side: v.oneOf(['BUY', 'SELL'], { required: true }),
      isBullion: v.boolean(),
      requiresAppraisal: v.boolean(),
    }),
    updateSchema: v.object({
      name: v.string({ min: 2, max: 120 }),
      side: v.oneOf(['BUY', 'SELL']),
      isBullion: v.boolean(),
      requiresAppraisal: v.boolean(),
      isActive: v.boolean(),
    }),
  });

  /* CS assignments: an assignment is a period, so it is ended, not edited. */
  const staffingRead = [guard.authenticate, guard.authorize(P.MASTERDATA_READ)];
  const staffingWrite = [guard.authenticate, guard.authorize(P.STAFFING_MANAGE)];

  router.get('/api/v1/cs-assignments', ...staffingRead, async (ctx) => {
    const query = validate(
      v.object({ branchId: v.uuid(), userId: v.uuid(), activeOn: v.date() }),
      queryOf(ctx),
    );
    ok(ctx, await masterdata.csAssignments.list(query));
  });

  router.get('/api/v1/cs-assignments/staff', ...staffingWrite, async (ctx) => {
    ok(ctx, await masterdata.csAssignments.staffOptions(actorOf(ctx)));
  });

  router.post('/api/v1/cs-assignments', ...staffingWrite, async (ctx) => {
    const input = validate(
      v.object({
        userId: v.uuid({ required: true }),
        branchId: v.uuid({ required: true }),
        isPrimary: v.boolean(),
        validFrom: v.date({ required: true }),
        validTo: v.date(),
      }),
      ctx.body,
    );
    created(ctx, await masterdata.csAssignments.create(actorOf(ctx), input));
  });

  router.delete('/api/v1/cs-assignments/:id', ...staffingWrite, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await masterdata.csAssignments.remove(actorOf(ctx), id));
  });

  /* Roles: the matrix lives in code, this only exposes it (read-only). */
  router.get('/api/v1/roles', guard.authenticate, guard.authorize(P.ROLE_READ), async (ctx) => {
    ok(ctx, roleMatrix());
  });
}
