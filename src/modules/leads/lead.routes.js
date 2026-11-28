import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { EMAIL_PATTERN } from '../../shared/email.js';
import { normalizeIndonesianPhone } from '../../shared/phone.js';
import { LEAD_TRANSITIONS } from './lead.service.js';

const idParams = v.object({ id: v.uuid({ required: true }) });

const phone = (opts = {}) =>
  v.string({
    ...opts,
    max: 20,
    transform: normalizeIndonesianPhone,
    message: 'invalid Indonesian phone number',
  });

const listSchema = v.object({
  status: v.oneOf(Object.keys(LEAD_TRANSITIONS)),
  referenceId: v.uuid(),
  q: v.string({ min: 2, max: 60 }),
  phone: phone(),
  page: v.integer({ min: 1, max: 10_000, default: 1 }),
  pageSize: v.integer({ min: 1, max: 100, default: 20 }),
});

const createSchema = v.object({
  fullName: v.string({ required: true, min: 2, max: 120 }),
  phone: phone({ required: true }),
  email: v.string({ max: 160, pattern: EMAIL_PATTERN, transform: (s) => s.toLowerCase() }),
  referenceId: v.uuid(),
  areaId: v.uuid(),
  branchId: v.uuid(),
  notes: v.string({ max: 500 }),
  ownerId: v.uuid(),
});

const updateSchema = v.object({
  fullName: v.string({ min: 2, max: 120 }),
  email: v.string({ max: 160, pattern: EMAIL_PATTERN, transform: (s) => s.toLowerCase() }),
  notes: v.string({ max: 500 }),
  ownerId: v.uuid(),
  referenceId: v.uuid(),
  areaId: v.uuid(),
  branchId: v.uuid(),
  // CONVERTED and EXPIRED are accepted by the schema so the service can reject
  // them with a clear 409 ("use the convert action") instead of a bare 422.
  status: v.oneOf(Object.keys(LEAD_TRANSITIONS)),
  lostReason: v.string({ max: 120 }),
});

const periodSchema = v.object({ from: v.date(), to: v.date() });

export function registerLeadRoutes(router, { leads, guard }) {
  const read = [guard.authenticate, guard.authorize(P.LEAD_READ)];
  const write = [guard.authenticate, guard.authorize(P.LEAD_WRITE)];

  // Registered before /leads/:id — the router prefers static segments anyway.
  router.get('/api/v1/leads/summary', ...read, async (ctx) => {
    ok(ctx, await leads.summary(actorOf(ctx), validate(periodSchema, queryOf(ctx))));
  });

  router.get('/api/v1/leads', ...read, async (ctx) => {
    const { items, meta } = await leads.search(actorOf(ctx), validate(listSchema, queryOf(ctx)));
    ok(ctx, items, { meta });
  });

  router.post('/api/v1/leads', ...write, async (ctx) => {
    created(ctx, await leads.create(actorOf(ctx), validate(createSchema, ctx.body)));
  });

  router.get('/api/v1/leads/:id', ...read, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await leads.get(actorOf(ctx), id));
  });

  router.patch('/api/v1/leads/:id', ...write, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await leads.update(actorOf(ctx), id, validate(updateSchema, ctx.body)));
  });

  router.post(
    '/api/v1/leads/:id/convert',
    guard.authenticate,
    guard.authorize(P.LEAD_CONVERT),
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      ok(ctx, await leads.convert(actorOf(ctx), id));
    },
  );
}
