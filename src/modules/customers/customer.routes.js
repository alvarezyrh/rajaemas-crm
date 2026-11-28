import { Errors } from '../../core/errors.js';
import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { CSV_BOM, csvLine } from '../../shared/csv.js';
import { BUSINESS_TZ } from '../../shared/sql.js';
import {
  createCustomerSchema,
  searchCustomerSchema,
  timelineQuerySchema,
  updateCustomerSchema,
} from './customer.schema.js';
import { MAX_IMPORT_ROWS } from './customer.transfer.js';

const idParams = v.object({ id: v.uuid({ required: true }) });
const exportSchema = v.object({
  phone: searchCustomerSchema.shape.phone,
  q: searchCustomerSchema.shape.q,
  segment: searchCustomerSchema.shape.segment,
});
const IMPORT_FIELDS = [
  'fullName',
  'phone',
  'email',
  'nik',
  'preferredChannel',
  'marketingConsent',
  'homeBranchCode',
  'birthPlace',
  'birthDate',
  'gender',
  'addressLine',
  'city',
  'province',
  'postalCode',
  'occupation',
];

/** Arrays are outside the schema DSL, so the import envelope is checked here. */
function parseImportBody(body) {
  const errors = [];
  if (!Array.isArray(body?.rows)) errors.push({ field: 'rows', message: 'must be a list' });
  else if (body.rows.length === 0 || body.rows.length > MAX_IMPORT_ROWS) {
    errors.push({ field: 'rows', message: `must contain 1–${MAX_IMPORT_ROWS} rows per request` });
  }
  if (errors.length) throw Errors.validation(errors);

  const rows = body.rows.map((raw, i) => {
    if (raw === null || typeof raw !== 'object' || !Number.isSafeInteger(raw.row)) {
      throw Errors.validation([
        { field: `rows[${i}]`, message: 'must be an object with a row number' },
      ]);
    }
    const row = { row: raw.row };
    for (const key of IMPORT_FIELDS) {
      const value = raw[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string' || value.length > 200) {
        throw Errors.validation([
          { field: `rows[${i}].${key}`, message: 'must be text up to 200 characters' },
        ]);
      }
      row[key] = value;
    }
    return row;
  });
  return { rows, dryRun: body.dryRun !== false };
}

export function registerCustomerRoutes(router, { customers, transfer, guard }) {
  const { authenticate, authorize } = guard;

  router.get('/api/v1/customers/export', authenticate, authorize(P.CUSTOMER_READ), async (ctx) => {
    const query = validate(exportSchema, queryOf(ctx));
    const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ })
      .format(new Date())
      .replaceAll('-', '');
    const rows = transfer.exportRows(actorOf(ctx), query);
    const header = (await rows.next()).value; // fail before headers are sent if the query is bad

    ctx.response = { status: 200 };
    ctx.res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="customers-${stamp}.csv"`,
      'cache-control': 'no-store',
    });
    ctx.res.write(CSV_BOM + csvLine(header));
    for await (const cells of rows) {
      if (!ctx.res.write(csvLine(cells)))
        await new Promise((resolve) => ctx.res.once('drain', resolve));
    }
    ctx.res.end();
  });

  router.post(
    '/api/v1/customers/import',
    authenticate,
    authorize(P.CUSTOMER_WRITE),
    async (ctx) => {
      const { rows, dryRun } = parseImportBody(ctx.body);
      ok(ctx, await transfer.importRows(actorOf(ctx), rows, { dryRun }));
    },
  );

  router.get('/api/v1/customers', authenticate, authorize(P.CUSTOMER_READ), async (ctx) => {
    const query = validate(searchCustomerSchema, queryOf(ctx));
    const { items, meta } = await customers.search(actorOf(ctx), query);
    ok(ctx, items, { meta });
  });

  router.post('/api/v1/customers', authenticate, authorize(P.CUSTOMER_WRITE), async (ctx) => {
    const input = validate(createCustomerSchema, ctx.body);
    created(ctx, await customers.register(actorOf(ctx), input));
  });

  router.get('/api/v1/customers/:id', authenticate, authorize(P.CUSTOMER_READ), async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await customers.getById(actorOf(ctx), id));
  });

  router.patch('/api/v1/customers/:id', authenticate, authorize(P.CUSTOMER_WRITE), async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await customers.update(actorOf(ctx), id, validate(updateCustomerSchema, ctx.body)));
  });

  router.get(
    '/api/v1/customers/:id/timeline',
    authenticate,
    authorize(P.CUSTOMER_READ),
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      const query = validate(timelineQuerySchema, queryOf(ctx));
      ok(ctx, await customers.timeline(actorOf(ctx), id, query));
    },
  );

  router.post(
    '/api/v1/customers/:id/pii/reveal',
    authenticate,
    authorize(P.CUSTOMER_PII_REVEAL),
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      ok(ctx, await customers.revealPii(actorOf(ctx), id));
    },
  );
}
