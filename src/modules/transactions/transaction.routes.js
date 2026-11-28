import { Errors } from '../../core/errors.js';
import { actorOf, queryOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { describeBonusRules } from '../../shared/bonus.js';

export const MAX_ITEMS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const headSchema = v.object({
  customerId: v.uuid({ required: true }),
  transactionTypeId: v.uuid({ required: true }),
  branchId: v.uuid(),
  csId: v.uuid(),
  qmsTicketId: v.uuid(),
  invoiceNo: v.string({ max: 40, pattern: /^[A-Za-z0-9._-]{4,40}$/, message: 'invalid invoice number' }),
  description: v.string({ max: 200 }),
  occurredAt: v.datetime(),
});

const listSchema = v.object({
  from: v.date(),
  to: v.date(),
  side: v.oneOf(['BUY', 'SELL']),
  typeId: v.uuid(),
  csId: v.uuid(),
  customerId: v.uuid(),
  page: v.integer({ min: 1, max: 10_000, default: 1 }),
  pageSize: v.integer({ min: 1, max: 100, default: 20 }),
});

const summarySchema = v.object({
  from: v.date(),
  to: v.date(),
  groupBy: v.oneOf(['outlet', 'type', 'cs', 'day'], { default: 'outlet' }),
});

/**
 * The basket is outside the schema DSL (no array type), so it is checked here —
 * the same approach the CSV import uses. Line amounts are NOT accepted from the
 * client: the service derives them from weight × unit price.
 */
function parseItems(rawItems) {
  if (!Array.isArray(rawItems))
    throw Errors.validation([{ field: 'items', message: 'must be a list' }]);
  if (rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
    throw Errors.validation([
      { field: 'items', message: `must contain 1–${MAX_ITEMS} lines per transaction` },
    ]);
  }
  return rawItems.map((raw, i) => {
    const fail = (field, message) => {
      throw Errors.validation([{ field: `items[${i}].${field}`, message }]);
    };
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      fail('line', 'must be an object');

    const item = {};
    if (raw.productId !== undefined && raw.productId !== null && raw.productId !== '') {
      if (typeof raw.productId !== 'string' || !UUID.test(raw.productId))
        fail('productId', 'must be a UUID');
      item.productId = raw.productId.toLowerCase();
    }
    if (typeof raw.description !== 'string' || raw.description.trim() === '')
      fail('description', 'is required');
    if (raw.description.trim().length > 200) fail('description', 'must be at most 200 characters');
    item.description = raw.description.trim();

    const weight = Number(raw.weightGram);
    if (!Number.isFinite(weight) || weight <= 0) fail('weightGram', 'must be a positive number');
    item.weightGram = weight;

    const unitPrice = Number(raw.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0)
      fail('unitPrice', 'must be zero or a positive number');
    item.unitPrice = unitPrice;

    if (raw.karat !== undefined && raw.karat !== null && raw.karat !== '') {
      const karat = Number(raw.karat);
      if (!Number.isFinite(karat) || karat <= 0 || karat > 24)
        fail('karat', 'must be between 0 and 24');
      item.karat = karat;
    }
    return item;
  });
}

export function registerTransactionRoutes(router, { transactions, guard, bonusRules }) {
  const { authenticate, authorize, idempotency } = guard;
  const read = [authenticate, authorize(P.TRANSACTION_READ)];

  // Static segments win over /transactions/:id in the router, so these never clash.
  router.get('/api/v1/transactions/summary', authenticate, authorize(P.REPORT_EXECUTIVE), async (ctx) => {
    ok(ctx, await transactions.summary(actorOf(ctx), validate(summarySchema, queryOf(ctx))));
  });

  router.get('/api/v1/transactions', ...read, async (ctx) => {
    const { items, meta } = await transactions.list(actorOf(ctx), validate(listSchema, queryOf(ctx)));
    ok(ctx, items, { meta });
  });

  router.post(
    '/api/v1/transactions',
    authenticate,
    authorize(P.TRANSACTION_WRITE),
    idempotency,
    async (ctx) => {
      const { items: rawItems, ...head } = ctx.body ?? {};
      const input = validate(headSchema, head);
      input.items = parseItems(rawItems);
      created(ctx, await transactions.record(actorOf(ctx), input));
    },
  );

  router.get('/api/v1/transactions/:id', ...read, async (ctx) => {
    const { id } = validate(v.object({ id: v.uuid({ required: true }) }), ctx.params);
    ok(ctx, await transactions.get(actorOf(ctx), id));
  });

  // Bonus Summary carries the active rules so the UI can label them as provisional.
  router.get('/api/v1/bonus/summary', authenticate, authorize(P.REPORT_EXECUTIVE), async (ctx) => {
    const query = validate(v.object({ from: v.date(), to: v.date() }), queryOf(ctx));
    ok(ctx, await transactions.bonusSummary(actorOf(ctx), query));
  });

  router.get('/api/v1/bonus/rules', ...read, async (ctx) => {
    ok(ctx, describeBonusRules(bonusRules));
  });
}
