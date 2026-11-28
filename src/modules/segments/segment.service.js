import { dataScopeOf, resolveScopedBranchId } from '../../shared/scope.js';
import { overlapRegions, SEGMENTS } from '../../shared/segments.js';

/** Waits before re-trying an order whose account is not linked yet. */
const ORDER_RETRY_DELAYS_MS = Object.freeze([1000, 3000]);

/** System actor for changes that come from integrations rather than staff. */
const systemActor = (eventId) =>
  Object.freeze({
    id: null,
    role: 'SYSTEM',
    branchId: null,
    requestId: `commerce:${eventId}`,
    ip: null,
  });

/**
 * Called INSIDE the buyback settlement transaction: a settled buyback means
 * the customer sold gold in store → they join the STORE cluster.
 */
export async function recordSettledBuyback({ segments }, appraisal, finalPrice) {
  const at = new Date();
  await segments.insertTransaction({
    customerId: appraisal.customerId,
    channel: 'STORE',
    side: 'SELL',
    branchId: appraisal.branchId,
    description: appraisal.itemDescription,
    weightGram: appraisal.weightGram,
    amount: finalPrice,
    appraisalId: appraisal.id,
    recordedBy: appraisal.appraiserId,
    occurredAt: at,
  });
  await segments.touchChannel({ customerId: appraisal.customerId, channel: 'STORE', at });
}

/** Customer Segmentation Service — In-store / Mobile app / E-commerce clusters. */
export function createSegmentService({ uow, customers, intake, logger }) {
  const queues = new Map(); // "<source>:<accountId>" → tail of that account's event chain

  return Object.freeze({
    async summary(actor, { activeDays }) {
      const { segments, countsByMask } = await uow.repos.segments.summary({
        scope: dataScopeOf(actor),
        activeDays,
      });
      const totalCustomers = Object.values(countsByMask).reduce((sum, n) => sum + n, 0);
      const byChannel = Object.fromEntries(segments.map((s) => [s.channel, s]));

      return {
        activeDays,
        totalCustomers,
        segments: SEGMENTS.map((channel) => {
          const s = byChannel[channel] ?? {
            channel,
            customers: 0,
            activeCustomers: 0,
            transactions: 0,
            buyAmount: 0,
            sellAmount: 0,
            grams: 0,
          };
          return { ...s, share: totalCustomers ? s.customers / totalCustomers : 0 };
        }),
        overlap: overlapRegions(countsByMask),
      };
    },

    async channelsOf(actor, customerId) {
      await customers.requireVisible(actor, customerId);
      return uow.repos.segments.channelsOf(customerId);
    },

    /** In-store gold buy/sell transaction recorded by branch staff. */
    async recordStoreTransaction(actor, customerId, input) {
      await customers.requireVisible(actor, customerId);

      return uow.run(async ({ segments, branches, audit }) => {
        const branchId = await resolveScopedBranchId(branches, actor, input.branchId);
        const transaction = await segments.insertTransaction({
          customerId,
          channel: 'STORE',
          side: input.side,
          branchId,
          description: input.description ?? null,
          weightGram: input.weightGram,
          amount: input.amount,
          recordedBy: actor.id,
        });
        await segments.touchChannel({ customerId, channel: 'STORE', at: transaction.occurredAt });
        await audit.append({
          actor,
          action: 'GOLD_TRANSACTION_RECORDED',
          entityType: 'customer',
          entityId: customerId,
          diff: { after: transaction },
        });
        return transaction;
      });
    },

    /**
     * Handles events from the mobile app and e-commerce website (async, idempotent).
     * Matching: channel account id → phone number (blind index) → new profile.
     */
    ingestCommerceEvent(event) {
      return inAccountOrder(`${event.source}:${event.accountId}`, () => ingest(event));
    },
  });

  /**
   * Events of one account are handled one after another: an app usually sends
   * "account.registered" and the first "order.completed" back to back, and the
   * order must not be looked up before the account link exists.
   */
  function inAccountOrder(key, task) {
    const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.set(key, run);
    run
      .finally(() => {
        if (queues.get(key) === run) queues.delete(key);
      })
      .catch(() => {});
    return run;
  }

  async function ingest(event, attempt = 0) {
    const actor = systemActor(event.eventId);
    const channel = event.source;
    const at = event.occurredAt ?? new Date();
    const { status, customerId, reason } = await intake.upsert(
      {
        fullName: event.fullName ?? null,
        phone: event.phone ?? null,
        email: event.email ?? null,
        accountId: event.accountId,
      },
      { actor, channel, at },
    );
    if (status === 'skipped') {
      // The registration may still be in flight on another worker: retry orders briefly.
      if (event.type === 'order.completed' && attempt < ORDER_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, ORDER_RETRY_DELAYS_MS[attempt]));
        return ingest(event, attempt + 1);
      }
      logger.info('commerce.unknown_customer', { eventId: event.eventId, source: channel, reason });
      return;
    }
    if (event.type !== 'order.completed') return;

    await uow.run(async ({ segments, audit }) => {
      const transaction = await segments.insertTransaction({
        customerId,
        channel,
        side: event.side,
        description: event.description ?? null,
        weightGram: event.weightGram,
        amount: event.amount,
        externalRef: `${channel}:${event.orderId}`,
        occurredAt: at,
      });
      if (!transaction) return; // order already recorded
      await audit.append({
        actor,
        action: 'GOLD_TRANSACTION_RECORDED',
        entityType: 'customer',
        entityId: customerId,
        diff: { after: transaction },
      });
    });
  }
}
