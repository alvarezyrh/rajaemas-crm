import { outletScopeSql, toNumber } from '../../shared/sql.js';

const SELECT = `
  SELECT r.appraisal_id, r.customer_id, c.full_name AS customer_name, r.branch_id, b.branch_code,
         r.appraiser_id, u.full_name AS appraiser_name, r.item_description, r.weight_gram,
         r.purity_karat, r.offered_price, r.final_price, r.status, r.notes, r.settled_at,
         r.created_at, r.updated_at
  FROM appraisal_records r
  JOIN customers c ON c.customer_id = r.customer_id
  JOIN branches b ON b.branch_id = r.branch_id
  JOIN users u ON u.user_id = r.appraiser_id`;

const toAppraisal = (row) =>
  row && {
    id: row.appraisal_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    branchId: row.branch_id,
    branchCode: row.branch_code,
    appraiserId: row.appraiser_id,
    appraiserName: row.appraiser_name,
    itemDescription: row.item_description,
    weightGram: toNumber(row.weight_gram),
    purityKarat: toNumber(row.purity_karat),
    offeredPrice: toNumber(row.offered_price),
    finalPrice: toNumber(row.final_price),
    status: row.status,
    notes: row.notes,
    settledAt: row.settled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

export function createAppraisalRepository(db) {
  return Object.freeze({
    async list({ scope, status, limit, offset }) {
      const params = [];
      const where = [outletScopeSql('r.branch_id', scope, params)];
      if (status) {
        params.push(status);
        where.push(`r.status = $${params.length}`);
      }
      params.push(limit, offset);
      const { rows } = await db.query(
        `${SELECT}
         WHERE ${where.join(' AND ')}
         ORDER BY r.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return rows.map(toAppraisal);
    },

    async findById(id, { forUpdate = false } = {}) {
      const { rows } = await db.query(
        `${SELECT} WHERE r.appraisal_id = $1 ${forUpdate ? 'FOR UPDATE OF r' : ''}`,
        [id],
      );
      return toAppraisal(rows[0]) ?? null;
    },

    async insert(record) {
      const { rows } = await db.query(
        `INSERT INTO appraisal_records
           (customer_id, branch_id, appraiser_id, item_description, weight_gram,
            purity_karat, offered_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING appraisal_id`,
        [
          record.customerId,
          record.branchId,
          record.appraiserId,
          record.itemDescription,
          record.weightGram,
          record.purityKarat,
          record.offeredPrice,
          record.notes ?? null,
        ],
      );
      return this.findById(rows[0].appraisal_id);
    },

    async updateStatus(id, { status, finalPrice }) {
      await db.query(
        `UPDATE appraisal_records
         SET status = $2::varchar,
             final_price = COALESCE($3::numeric, final_price),
             settled_at = CASE WHEN $2::varchar = 'SETTLED' THEN now() ELSE settled_at END
         WHERE appraisal_id = $1`,
        [id, status, finalPrice ?? null],
      );
      return this.findById(id);
    },
  });
}
