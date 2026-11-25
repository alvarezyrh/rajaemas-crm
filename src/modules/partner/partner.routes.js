import { Errors } from '../../core/errors.js';
import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { normalizeNik } from '../../shared/kyc.js';
import { normalizeIndonesianPhone } from '../../shared/phone.js';
import { SCOPES } from './partner.service.js';

const idParams = v.object({ id: v.uuid({ required: true }) });
const createClientSchema = v.object({
  name: v.string({ required: true, min: 2, max: 80 }),
  includePii: v.boolean({ default: false }),
});
const listSchema = v.object({
  updatedSince: v.datetime(),
  cursor: v.string({ max: 200 }),
  limit: v.integer({ min: 1, max: 500, default: 100 }),
});
const lookupSchema = v.object({
  phone: v.string({
    max: 20,
    transform: normalizeIndonesianPhone,
    message: 'invalid Indonesian phone number',
  }),
  nik: v.string({ max: 30, transform: normalizeNik, message: 'NIK must be 16 digits' }),
});

/** `Authorization: Bearer rei_…` or `X-API-Key: rei_…` → ctx.state.client. */
function partnerAuth(partner, scope) {
  return async (ctx, next) => {
    const header = ctx.req.headers.authorization;
    const key =
      (typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice(7).trim()
        : null) ?? ctx.req.headers['x-api-key'];
    if (!key) throw Errors.unauthorized('API key required');
    ctx.state.client = await partner.authenticate(String(key));
    if (!ctx.state.client.scopes.includes(scope))
      throw Errors.forbidden(`This key lacks the ${scope} scope`);
    await next();
  };
}

export function registerPartnerRoutes(router, { partner, guard }) {
  /* ---------- API keys for other systems (head office, API page) ---------- */
  const manage = [guard.authenticate, guard.authorize(P.INTEGRATION_MANAGE)];

  router.get('/api/v1/api-clients', ...manage, async (ctx) => {
    ok(ctx, await partner.list());
  });

  router.post('/api/v1/api-clients', ...manage, async (ctx) => {
    const { name, includePii } = validate(createClientSchema, ctx.body);
    const scopes = includePii ? [SCOPES.READ, SCOPES.READ_PII] : [SCOPES.READ];
    created(ctx, await partner.create(actorOf(ctx), { name, scopes }));
  });

  router.post('/api/v1/api-clients/:id/revoke', ...manage, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await partner.revoke(actorOf(ctx), id));
  });

  /* ---------- Partner API: APPS / STORE pull customer data ---------- */
  const read = partnerAuth(partner, SCOPES.READ);

  // Static "lookup" is matched before ":id" by the router.
  router.get('/api/partner/v1/customers/lookup', read, async (ctx) => {
    const { phone, nik } = validate(lookupSchema, queryOf(ctx));
    if (Boolean(phone) === Boolean(nik)) {
      throw Errors.validation([{ field: 'phone|nik', message: 'provide exactly one of these' }]);
    }
    ok(ctx, await partner.lookup(ctx.state.client, { phone, nik }));
  });

  router.get('/api/partner/v1/customers', read, async (ctx) => {
    const query = validate(listSchema, queryOf(ctx));
    const { items, nextCursor } = await partner.listCustomers(ctx.state.client, query);
    ok(ctx, items, { meta: { count: items.length, nextCursor } });
  });

  router.get('/api/partner/v1/customers/:id', read, async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await partner.getCustomer(ctx.state.client, id));
  });
}
