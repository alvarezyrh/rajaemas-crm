import { toNumber } from '../../shared/sql.js';

const COLUMNS = `
  ab.budget_id, ab.area_id, ar.area_code, ar.name AS area_name,
  ab.reference_id, r.code AS reference_code, r.name AS reference_name, r.channel_type,
  ab.period_month::text AS period_month, ab.spend_amount, ab.notes, ab.created_at, ab.updated_at`;
const FROM = `
  FROM advertising_budgets ab
  JOIN areas ar ON ar.area_id = ab.area_id
  JOIN acquisition_references r ON r.reference_id = ab.reference_id`;

/**
 * Budgets live at area level. Outlet staff therefore see the budget of the area
 * their outlet belongs to, area managers their own area, head office everything.
 */
function budgetScope(scope, params) {
  if (scope?.branchId) {
    params.push(scope.branchId);
    return `(ab.area_id = (SELECT area_id FROM branches WHERE branch_id = $${params.length}))`;
  }
  if (scope?.areaId) {
    params.push(scope.areaId);
    return `(ab.area_id = $${params.length})`;
  }
  return 'TRUE';
}

const toBudget = (row) => ({
  id: row.budget_id,
  areaId: row.area_id,
  areaCode: row.area_code,
  areaName: row.area_name,
  referenceId: row.reference_id,
  referenceCode: row.reference_code,
  referenceName: row.reference_name,
  channelType: row.channel_type,
  periodMonth: row.period_month,
  spendAmount: toNumber(row.spend_amount),
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createAdvertisingRepository(db) {
  return Object.freeze({
    async list({ scope, from, to, areaId, referenceId }) {
      const params = [];
      const where = [budgetScope(scope, params)];
      if (from) {
        params.push(from);
        where.push(`ab.period_month >= date_trunc('month', $${params.length}::date)`);
      }
      if (to) {
        params.push(to);
        where.push(`ab.period_month <= date_trunc('month', $${params.length}::date)`);
      }
      if (areaId) {
        params.push(areaId);
        where.push(`ab.area_id = $${params.length}`);
      }
      if (referenceId) {
        params.push(referenceId);
        where.push(`ab.reference_id = $${params.length}`);
      }
      const { rows } = await db.query(
        `SELECT ${COLUMNS} ${FROM} WHERE ${where.join(' AND ')}
         ORDER BY ab.period_month DESC, ar.area_code, r.code`,
        params,
      );
      return rows.map(toBudget);
    },

    async findById(id, scope) {
      const params = [id];
      const where = budgetScope(scope, params);
      const { rows } = await db.query(
        `SELECT ${COLUMNS} ${FROM} WHERE ab.budget_id = $1 AND ${where}`,
        params,
      );
      return rows[0] ? toBudget(rows[0]) : null;
    },

    async insert({ areaId, referenceId, periodMonth, spendAmount, notes, createdBy }) {
      const { rows } = await db.query(
        `INSERT INTO advertising_budgets
           (area_id, reference_id, period_month, spend_amount, notes, created_by)
         VALUES ($1, $2, date_trunc('month', $3::date), $4, $5, $6)
         RETURNING budget_id`,
        [areaId, referenceId, periodMonth, spendAmount, notes ?? null, createdBy ?? null],
      );
      return rows[0].budget_id;
    },

    async update(id, fields) {
      const columns = {
        areaId: 'area_id',
        referenceId: 'reference_id',
        periodMonth: 'period_month',
        spendAmount: 'spend_amount',
        notes: 'notes',
      };
      const keys = Object.keys(fields).filter(
        (key) => fields[key] !== undefined && Object.hasOwn(columns, key),
      );
      if (keys.length === 0) return false;
      const params = [id];
      const set = keys.map((key) => {
        params.push(fields[key]);
        const p = `$${params.length}`;
        return key === 'periodMonth'
          ? `period_month = date_trunc('month', ${p}::date)`
          : `${columns[key]} = ${p}`;
      });
      const { rowCount } = await db.query(
        `UPDATE advertising_budgets SET ${set.join(', ')} WHERE budget_id = $1`,
        params,
      );
      return rowCount === 1;
    },

    /** Spend per (area, channel) inside the window — the join key for the summary. */
    async spendByAreaReference({ scope, from, to }) {
      const params = [];
      const where = [budgetScope(scope, params)];
      if (from) {
        params.push(from);
        where.push(`ab.period_month >= date_trunc('month', $${params.length}::date)`);
      }
      if (to) {
        params.push(to);
        where.push(`ab.period_month <= date_trunc('month', $${params.length}::date)`);
      }
      const { rows } = await db.query(
        `SELECT ab.area_id, ab.reference_id, sum(ab.spend_amount) AS spend
         ${FROM} WHERE ${where.join(' AND ')}
         GROUP BY 1, 2`,
        params,
      );
      return rows.map((r) => ({
        areaId: r.area_id,
        referenceId: r.reference_id,
        spend: toNumber(r.spend),
      }));
    },
  });
}
