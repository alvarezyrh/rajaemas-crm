import { Errors } from '../../core/errors.js';
import { pageMeta } from '../../core/http/response.js';
import { bonusFor } from '../../shared/bonus.js';
import { dataScopeOf, resolveScopedBranchId } from '../../shared/scope.js';
import { ReadModelEvents } from '../../infra/readModel.js';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Store transactions: a header on `gold_transactions` plus a basket of
 * `transaction_items`. The basket is the source of truth — the header's weight
 * and amount are the sum of its items, and the staff incentive is derived from
 * the transaction type's side, never supplied by the client.
 */
export function createTransactionService({ uow, customers, bonusRules, bus }) {
  async function priceItems(items) {
    return items.map((item) => {
      const weight = Number(item.weightGram);
      const unitPrice = Number(item.unitPrice);
      if (!(weight > 0))
        throw Errors.validation([{ field: 'items.weightGram', message: 'must be greater than 0' }]);
      if (!(unitPrice >= 0))
        throw Errors.validation([{ field: 'items.unitPrice', message: 'must not be negative' }]);
      return { ...item, weightGram: weight, unitPrice, amount: round2(weight * unitPrice) };
    });
  }

  return Object.freeze({
    async list(actor, query) {
      const { items, total } = await uow.repos.transactions.list({
        scope: dataScopeOf(actor),
        ...query,
        offset: (query.page - 1) * query.pageSize,
        limit: query.pageSize,
      });
      return { items, meta: pageMeta(query.page, query.pageSize, total) };
    },

    async get(actor, id) {
      const scope = dataScopeOf(actor);
      const transaction = await uow.repos.transactions.findById(id, scope);
      if (!transaction) throw Errors.notFound('Transaction');
      return { ...transaction, items: await uow.repos.transactions.itemsOf(id) };
    },

    async record(actor, input, integration = null) {
      if (integration) {
        const existing = await uow.repos.transactions.findByIntegrationKey(
          integration.sourceId,
          integration.keyHash,
        );
        if (existing) return { transaction: existing, created: false };
      }

      // The customer must be inside the caller's scope before anything is written.
      await customers.requireVisible(actor, input.customerId);
      const type = await uow.repos.transactionTypes.findById(input.transactionTypeId);
      if (!type || !type.isActive)
        throw Errors.validation([
          { field: 'transactionTypeId', message: 'is not an active transaction type' },
        ]);

      const items = await priceItems(input.items);
      if (items.length === 0)
        throw Errors.validation([{ field: 'items', message: 'must contain at least one line' }]);
      for (const item of items) {
        if (!item.productId) continue;
        const product = await uow.repos.products.findById(item.productId);
        if (!product || !product.isActive)
          throw Errors.validation([
            {
              field: 'items.productId',
              message: `is not an active product (${item.sku ?? item.productId})`,
            },
          ]);
      }

      const amount = round2(items.reduce((sum, item) => sum + item.amount, 0));
      // Grams are stored with 3 decimals (numeric(10,3)).
      const weightGram =
        Math.round(items.reduce((sum, item) => sum + item.weightGram, 0) * 1000) / 1000;
      // The side comes from master data, so a client cannot turn a buyback into a sale.
      const bonusAmount = bonusFor({ amount, side: type.side, rules: bonusRules });

      try {
        const transaction = await uow.run(async (repos) => {
          const branchId = await resolveScopedBranchId(repos.branches, actor, input.branchId);

          let csId = input.csId ?? null;
          if (!csId) {
            // Fall back to the officer serving the queue, then to the primary CS of the outlet.
            if (input.qmsTicketId) {
              const ticket = await repos.qms.findTicketById(input.qmsTicketId, {
                branchId,
                areaId: null,
              });
              if (!ticket)
                throw Errors.validation([
                  { field: 'qmsTicketId', message: 'is not a ticket of this outlet' },
                ]);
              csId = ticket.csId;
            }
            if (!csId) {
              const assignments = await repos.csAssignments.list({
                branchId,
                activeOn: new Date().toISOString().slice(0, 10),
              });
              csId = assignments.find((a) => a.isPrimary)?.userId ?? null;
            }
          }

          let invoiceNo = input.invoiceNo ?? null;
          if (!invoiceNo) {
            invoiceNo = await repos.transactions.nextInvoiceNo(branchId);
            if (!invoiceNo) throw Errors.notFound('Outlet');
          }

          const qmsTicketId = input.qmsTicketId ?? null;
          const transactionId = await repos.transactions.insert({
            customerId: input.customerId,
            channel: 'STORE',
            side: type.side,
            branchId,
            description: input.description ?? type.name,
            weightGram,
            amount,
            transactionTypeId: type.id,
            csId,
            bonusAmount,
            qmsTicketId,
            invoiceNo,
            recordedBy: actor.id,
            occurredAt: input.occurredAt ?? null,
            integrationSourceId: integration?.sourceId,
            integrationKeyHash: integration?.keyHash,
          });
          await repos.transactions.insertItems(transactionId, items);

          // A store transaction also means the customer belongs to the STORE cluster.
          await repos.segments.touchChannel({ customerId: input.customerId, channel: 'STORE' });

          await repos.audit.append({
            actor,
            action: 'TRANSACTION_RECORDED',
            entityType: 'transaction',
            entityId: transactionId,
            diff: {
              invoiceNo,
              branchId,
              side: type.side,
              typeCode: type.code,
              items: items.length,
              weightGram,
              amount,
              bonusAmount,
              csId,
            },
          });

          const scope = dataScopeOf(actor);
          return {
            ...(await repos.transactions.findById(transactionId, scope)),
            items: await repos.transactions.itemsOf(transactionId),
          };
        });
        bus?.publish(ReadModelEvents.TRANSACTION_RECORDED, { transactionId: transaction.id });
        return integration ? { transaction, created: true } : transaction;
      } catch (err) {
        if (integration && err.constraint === 'gold_transactions_integration_external_uidx') {
          const existing = await uow.repos.transactions.findByIntegrationKey(
            integration.sourceId,
            integration.keyHash,
          );
          if (existing) return { transaction: existing, created: false };
        }
        if (err.code === '23505')
          throw Errors.conflict('That invoice number is already used at this outlet today');
        throw err;
      }
    },

    summary(actor, query) {
      return uow.repos.transactions.summary({ scope: dataScopeOf(actor), ...query });
    },

    /** Bonus Summary — staff incentive plus the service rating they earned. */
    async bonusSummary(actor, query) {
      const rows = await uow.repos.transactions.bonusSummary({
        scope: dataScopeOf(actor),
        ...query,
      });
      const totals = rows.reduce(
        (sum, row) => ({
          transactions: sum.transactions + row.transactions,
          amount: sum.amount + row.amount,
          bonus: sum.bonus + row.bonus,
        }),
        { transactions: 0, amount: 0, bonus: 0 },
      );
      return { rules: bonusRules, provisional: true, totals, rows };
    },
  });
}
