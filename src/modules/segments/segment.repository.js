import { toNumber } from '../../shared/sql.js';
import { customerBranchScope } from '../customers/customer.repository.js';

const toTransaction = (row) => ({
  id: row.transaction_id,
  customerId: row.customer_id,
  channel: row.channel,
  side: row.side,
  branchId: row.branch_id,
  branchCode: row.branch_code ?? null,
  description: row.description,
  weightGram: toNumber(row.weight_gram),
  amount: toNumber(row.amount),
  occurredAt: row.occurred_at,
});

/** Cluster storage: channel membership, cross-channel transactions and aggregates. */
export function createSegmentRepository(db) {
  return Object.freeze({
    /**
     * Links a customer to a channel. When already linked, only the last-active time
     * (and the account id, if it was empty) is updated. Times never move backwards.
     */
    async touchChannel({ customerId, channel, externalAccountId = null, at = new Date() }) {
      const { rows } = await db.query(
        `INSERT INTO customer_channels (customer_id, channel, external_account_id, first_seen_at, last_active_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (customer_id, channel) DO UPDATE SET
           external_account_id = COALESCE(customer_channels.external_account_id, EXCLUDED.external_account_id),
           first_seen_at  = LEAST(customer_channels.first_seen_at, EXCLUDED.first_seen_at),
           last_active_at = GREATEST(customer_channels.last_active_at, EXCLUDED.last_active_at)
         RETURNING (xmax = 0) AS inserted`,
        [customerId, channel, externalAccountId, at],
      );
      // Joining a new cluster changes what partner systems see: bump the customer's
      // updated_at so incremental pulls (updatedSince / cursor) pick it up.
      if (rows[0]?.inserted) {
        await db.query('UPDATE customers SET updated_at = now() WHERE customer_id = $1', [
          customerId,
        ]);
      }
    },

    async findCustomerIdByAccount(channel, externalAccountId) {
      const { rows } = await db.query(
        'SELECT customer_id FROM customer_channels WHERE channel = $1 AND external_account_id = $2',
        [channel, externalAccountId],
      );
      return rows[0]?.customer_id ?? null;
    },

    /** @returns {Promise<object|null>} null when external_ref/appraisal was already recorded (idempotent). */
    async insertTransaction(tx) {
      const { rows } = await db.query(
        `INSERT INTO gold_transactions
           (customer_id, channel, side, branch_id, description, weight_gram, amount,
            external_ref, appraisal_id, recorded_by, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()))
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          tx.customerId,
          tx.channel,
          tx.side,
          tx.branchId ?? null,
          tx.description ?? null,
          tx.weightGram,
          tx.amount,
          tx.externalRef ?? null,
          tx.appraisalId ?? null,
          tx.recordedBy ?? null,
          tx.occurredAt ?? null,
        ],
      );
      return rows[0] ? toTransaction(rows[0]) : null;
    },

    async channelsOf(customerId) {
      const { rows } = await db.query(
        `SELECT ch.channel, ch.first_seen_at, ch.last_active_at,
                count(t.transaction_id) AS transactions,
                COALESCE(sum(t.amount), 0) AS total_amount
         FROM customer_channels ch
         LEFT JOIN gold_transactions t
           ON t.customer_id = ch.customer_id AND t.channel = ch.channel
         WHERE ch.customer_id = $1
         GROUP BY ch.channel, ch.first_seen_at, ch.last_active_at
         ORDER BY ch.first_seen_at`,
        [customerId],
      );
      return rows.map((row) => ({
        channel: row.channel,
        firstSeenAt: row.first_seen_at,
        lastActiveAt: row.last_active_at,
        transactions: toNumber(row.transactions),
        totalAmount: toNumber(row.total_amount),
      }));
    },

    /**
     * Per-cluster aggregates + overlap counts, limited to the branch scope.
     * For branch staff the population is the customers their branch can see.
     */
    async summary({ branchId, activeDays }) {
      const params = [];
      const scope = customerBranchScope(branchId, params);
      params.push(activeDays);
      const activeParam = `$${params.length}`;

      const { rows: perSegment } = await db.query(
        `WITH visible AS (SELECT c.customer_id FROM customers c WHERE ${scope})
         SELECT ch.channel,
                count(*) AS customers,
                count(*) FILTER (WHERE ch.last_active_at >= now() - make_interval(days => ${activeParam}::int)) AS active,
                COALESCE(sum(t.tx_count), 0)   AS transactions,
                COALESCE(sum(t.buy_amount), 0) AS buy_amount,
                COALESCE(sum(t.sell_amount), 0) AS sell_amount,
                COALESCE(sum(t.grams), 0)      AS grams
         FROM customer_channels ch
         JOIN visible v ON v.customer_id = ch.customer_id
         LEFT JOIN LATERAL (
           SELECT count(*) AS tx_count,
                  sum(amount) FILTER (WHERE side = 'BUY')  AS buy_amount,
                  sum(amount) FILTER (WHERE side = 'SELL') AS sell_amount,
                  sum(weight_gram) AS grams
           FROM gold_transactions g
           WHERE g.customer_id = ch.customer_id AND g.channel = ch.channel
         ) t ON TRUE
         GROUP BY ch.channel`,
        params,
      );

      const overlapParams = [];
      const overlapScope = customerBranchScope(branchId, overlapParams);
      const { rows: overlap } = await db.query(
        `SELECT COALESCE(m.mask, 0) AS mask, count(*) AS customers
         FROM customers c
         LEFT JOIN (
           SELECT customer_id,
                  bit_or(CASE channel WHEN 'STORE' THEN 1 WHEN 'MOBILE_APP' THEN 2 ELSE 4 END) AS mask
           FROM customer_channels GROUP BY customer_id
         ) m ON m.customer_id = c.customer_id
         WHERE ${overlapScope}
         GROUP BY 1`,
        overlapParams,
      );

      return {
        segments: perSegment.map((row) => ({
          channel: row.channel,
          customers: toNumber(row.customers),
          activeCustomers: toNumber(row.active),
          transactions: toNumber(row.transactions),
          buyAmount: toNumber(row.buy_amount),
          sellAmount: toNumber(row.sell_amount),
          grams: toNumber(row.grams),
        })),
        countsByMask: Object.fromEntries(
          overlap.map((row) => [toNumber(row.mask), toNumber(row.customers)]),
        ),
      };
    },
  });
}
