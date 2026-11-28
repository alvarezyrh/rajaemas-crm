import { BUSINESS_TZ, outletScopeSql, toNumber } from '../../shared/sql.js';

const HEADER = `
  t.transaction_id, t.customer_id, c.full_name AS customer_name, t.channel, t.side,
  t.branch_id, b.branch_code, t.description, t.weight_gram, t.amount, t.bonus_amount,
  t.invoice_no, t.transaction_type_id, tt.code AS type_code, tt.name AS type_name,
  t.cs_id, cs.full_name AS cs_name, t.qms_ticket_id, q.ticket_no, t.appraisal_id,
  t.recorded_by, t.occurred_at, t.created_at`;
const FROM = `
  FROM gold_transactions t
  JOIN customers c ON c.customer_id = t.customer_id
  LEFT JOIN branches b ON b.branch_id = t.branch_id
  LEFT JOIN transaction_types tt ON tt.type_id = t.transaction_type_id
  LEFT JOIN users cs ON cs.user_id = t.cs_id
  LEFT JOIN qms_tickets q ON q.ticket_id = t.qms_ticket_id`;

const toTransaction = (row) => ({
  id: row.transaction_id,
  customerId: row.customer_id,
  customerName: row.customer_name,
  channel: row.channel,
  side: row.side,
  branchId: row.branch_id,
  branchCode: row.branch_code,
  description: row.description,
  weightGram: toNumber(row.weight_gram),
  amount: toNumber(row.amount),
  bonusAmount: toNumber(row.bonus_amount),
  invoiceNo: row.invoice_no,
  transactionTypeId: row.transaction_type_id,
  typeCode: row.type_code,
  typeName: row.type_name,
  csId: row.cs_id,
  csName: row.cs_name,
  qmsTicketId: row.qms_ticket_id,
  ticketNo: row.ticket_no,
  appraisalId: row.appraisal_id,
  occurredAt: row.occurred_at,
  createdAt: row.created_at,
});

/** Adds `from`/`to` (inclusive day, outlet time zone) to the where clause. */
function periodClause(where, params, { from, to }, column = 't.occurred_at') {
  if (from) {
    params.push(from);
    where.push(`(${column} AT TIME ZONE '${BUSINESS_TZ}')::date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`(${column} AT TIME ZONE '${BUSINESS_TZ}')::date <= $${params.length}::date`);
  }
}

export function createTransactionRepository(db) {
  return Object.freeze({
    async insert(header) {
      const { rows } = await db.query(
        `INSERT INTO gold_transactions
           (customer_id, channel, side, branch_id, description, weight_gram, amount,
            transaction_type_id, cs_id, bonus_amount, qms_ticket_id, invoice_no,
            appraisal_id, recorded_by, occurred_at, integration_source_id,
            integration_external_key_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 COALESCE($15, now()), $16, $17)
         RETURNING transaction_id`,
        [
          header.customerId,
          header.channel ?? 'STORE',
          header.side,
          header.branchId ?? null,
          header.description ?? null,
          header.weightGram,
          header.amount,
          header.transactionTypeId ?? null,
          header.csId ?? null,
          header.bonusAmount ?? 0,
          header.qmsTicketId ?? null,
          header.invoiceNo ?? null,
          header.appraisalId ?? null,
          header.recordedBy ?? null,
          header.occurredAt ?? null,
          header.integrationSourceId ?? null,
          header.integrationKeyHash ?? null,
        ],
      );
      return rows[0].transaction_id;
    },

    async findByIntegrationKey(sourceId, keyHash) {
      const { rows } = await db.query(
        `SELECT transaction_id FROM gold_transactions
         WHERE integration_source_id = $1 AND integration_external_key_hash = $2`,
        [sourceId, keyHash],
      );
      return rows[0] ? { id: rows[0].transaction_id } : null;
    },

    async insertItems(transactionId, items) {
      // Insert all items in one statement, preserving their entered order.
      const values = [];
      const params = [];
      for (const [index, item] of items.entries()) {
        params.push(
          transactionId,
          index + 1,
          item.productId ?? null,
          item.description,
          item.weightGram,
          item.karat ?? null,
          item.unitPrice,
          item.amount,
        );
        const base = params.length - 7;
        values.push(
          `($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`,
        );
      }
      await db.query(
        `INSERT INTO transaction_items
           (transaction_id, line_no, product_id, description, weight_gram, karat, unit_price, amount)
         VALUES ${values.join(', ')}`,
        params,
      );
    },

    async itemsOf(transactionId) {
      const { rows } = await db.query(
        `SELECT ti.item_id, ti.line_no, ti.product_id, p.sku, p.name AS product_name,
                ti.description, ti.weight_gram, ti.karat, ti.unit_price, ti.amount
         FROM transaction_items ti
         LEFT JOIN products p ON p.product_id = ti.product_id
         WHERE ti.transaction_id = $1
         ORDER BY ti.line_no`,
        [transactionId],
      );
      return rows.map((row) => ({
        id: row.item_id,
        lineNo: row.line_no,
        productId: row.product_id,
        sku: row.sku,
        productName: row.product_name,
        description: row.description,
        weightGram: toNumber(row.weight_gram),
        karat: toNumber(row.karat),
        unitPrice: toNumber(row.unit_price),
        amount: toNumber(row.amount),
      }));
    },

    async findById(id, scope) {
      const params = [id];
      const where = outletScopeSql('t.branch_id', scope, params);
      const { rows } = await db.query(
        `SELECT ${HEADER} ${FROM} WHERE t.transaction_id = $1 AND ${where}`,
        params,
      );
      return rows[0] ? toTransaction(rows[0]) : null;
    },

    async list({ scope, from, to, side, typeId, csId, customerId, limit, offset }) {
      const params = [];
      const where = [outletScopeSql('t.branch_id', scope, params)];
      periodClause(where, params, { from, to });
      for (const [column, value] of [
        ['t.side', side],
        ['t.transaction_type_id', typeId],
        ['t.cs_id', csId],
        ['t.customer_id', customerId],
      ]) {
        if (value) {
          params.push(value);
          where.push(`${column} = $${params.length}`);
        }
      }
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT ${HEADER}, count(*) OVER () AS total_count ${FROM}
         WHERE ${where.join(' AND ')}
         ORDER BY t.occurred_at DESC, t.transaction_id
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return {
        items: rows.map(toTransaction),
        total: rows.length ? Number(rows[0].total_count) : 0,
      };
    },

    /** Next invoice number for an outlet on its own local day. */
    async nextInvoiceNo(branchId) {
      const { rows } = await db.query(
        `SELECT b.branch_code,
                to_char(now() AT TIME ZONE b.timezone, 'YYYYMMDD') AS day,
                (SELECT count(*)::int FROM gold_transactions t
                  WHERE t.branch_id = b.branch_id
                    AND (t.occurred_at AT TIME ZONE b.timezone)::date
                        = (now() AT TIME ZONE b.timezone)::date) AS used
         FROM branches b WHERE b.branch_id = $1`,
        [branchId],
      );
      const row = rows[0];
      if (!row) return null;
      return `INV-${row.branch_code}-${row.day}-${String(row.used + 1).padStart(4, '0')}`;
    },

    /** Transaction Summary: totals plus one grouping dimension. */
    async summary({ scope, from, to, groupBy = 'outlet' }) {
      const params = [];
      const where = [outletScopeSql('t.branch_id', scope, params)];
      periodClause(where, params, { from, to });

      const dimensions = {
        outlet: ['t.branch_id', 'b.branch_code AS code', 'b.name AS name'],
        type: ['t.transaction_type_id', 'tt.code AS code', 'tt.name AS name'],
        cs: ['t.cs_id', 'cs.full_name AS code', 'cs.full_name AS name'],
        day: [
          `(t.occurred_at AT TIME ZONE '${BUSINESS_TZ}')::date`,
          `to_char((t.occurred_at AT TIME ZONE '${BUSINESS_TZ}')::date, 'YYYY-MM-DD') AS code`,
          `to_char((t.occurred_at AT TIME ZONE '${BUSINESS_TZ}')::date, 'YYYY-MM-DD') AS name`,
        ],
      };
      const [keyColumn, codeExpr, nameExpr] = dimensions[groupBy] ?? dimensions.outlet;

      const { rows } = await db.query(
        `SELECT ${keyColumn} AS key, ${codeExpr}, ${nameExpr},
                count(*) AS transactions,
                count(*) FILTER (WHERE t.side = 'BUY')  AS buy_count,
                count(*) FILTER (WHERE t.side = 'SELL') AS sell_count,
                COALESCE(sum(t.amount) FILTER (WHERE t.side = 'BUY'), 0)  AS buy_amount,
                COALESCE(sum(t.amount) FILTER (WHERE t.side = 'SELL'), 0) AS sell_amount,
                COALESCE(sum(t.weight_gram), 0) AS grams,
                COALESCE(sum(t.bonus_amount), 0) AS bonus
         ${FROM} WHERE ${where.join(' AND ')}
         GROUP BY 1, 2, 3
         ORDER BY (COALESCE(sum(t.amount) FILTER (WHERE t.side = 'BUY'), 0)
                 + COALESCE(sum(t.amount) FILTER (WHERE t.side = 'SELL'), 0)) DESC`,
        params,
      );

      const { rows: totals } = await db.query(
        `SELECT count(*) AS transactions,
                COALESCE(sum(t.amount) FILTER (WHERE t.side = 'BUY'), 0)  AS buy_amount,
                COALESCE(sum(t.amount) FILTER (WHERE t.side = 'SELL'), 0) AS sell_amount,
                COALESCE(sum(t.weight_gram), 0) AS grams,
                COALESCE(sum(t.bonus_amount), 0) AS bonus
         ${FROM} WHERE ${where.join(' AND ')}`,
        params,
      );

      const t = totals[0];
      return {
        groupBy,
        totals: {
          transactions: toNumber(t.transactions),
          buyAmount: toNumber(t.buy_amount),
          sellAmount: toNumber(t.sell_amount),
          grams: toNumber(t.grams),
          bonus: toNumber(t.bonus),
        },
        rows: rows.map((row) => ({
          key: row.key,
          code: row.code ?? 'UNKNOWN',
          name: row.name ?? 'Tidak dikelompokkan',
          transactions: toNumber(row.transactions),
          buyCount: toNumber(row.buy_count),
          sellCount: toNumber(row.sell_count),
          buyAmount: toNumber(row.buy_amount),
          sellAmount: toNumber(row.sell_amount),
          grams: toNumber(row.grams),
          bonus: toNumber(row.bonus),
        })),
      };
    },

    /** Bonus Summary: incentive per staff member, with their service rating. */
    async bonusSummary({ scope, from, to }) {
      const params = [];
      const where = [outletScopeSql('t.branch_id', scope, params)];
      periodClause(where, params, { from, to });
      where.push('t.cs_id IS NOT NULL');

      const { rows } = await db.query(
        `SELECT t.cs_id, cs.full_name AS cs_name, b.branch_code,
                count(*) AS transactions,
                COALESCE(sum(t.amount), 0) AS amount,
                COALESCE(sum(t.bonus_amount), 0) AS bonus,
                (SELECT count(*) FROM cs_ratings r WHERE r.cs_id = t.cs_id) AS ratings,
                (SELECT round(avg(r.score)::numeric, 2) FROM cs_ratings r
                  WHERE r.cs_id = t.cs_id) AS avg_score
         ${FROM}
         WHERE ${where.join(' AND ')}
         GROUP BY t.cs_id, cs.full_name, b.branch_code
         ORDER BY bonus DESC`,
        params,
      );
      return rows.map((row) => ({
        csId: row.cs_id,
        csName: row.cs_name,
        branchCode: row.branch_code,
        transactions: toNumber(row.transactions),
        amount: toNumber(row.amount),
        bonus: toNumber(row.bonus),
        ratings: toNumber(row.ratings),
        avgScore: row.avg_score === null ? null : toNumber(row.avg_score),
      }));
    },
  });
}
