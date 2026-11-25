import { BUSINESS_TZ } from '../../shared/sql.js';

const SELECT = `
  SELECT a.appointment_id, a.customer_id, c.full_name AS customer_name, a.branch_id, b.branch_code,
         a.service_type, a.scheduled_at, a.status, a.notes, a.created_at, a.updated_at
  FROM branch_appointments a
  JOIN customers c ON c.customer_id = a.customer_id
  JOIN branches b ON b.branch_id = a.branch_id`;

const toAppointment = (row) =>
  row && {
    id: row.appointment_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    branchId: row.branch_id,
    branchCode: row.branch_code,
    serviceType: row.service_type,
    scheduledAt: row.scheduled_at,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

export function createAppointmentRepository(db) {
  return Object.freeze({
    async listByDay({ date, branchId }) {
      const { rows } = await db.query(
        `${SELECT}
         WHERE ($1::uuid IS NULL OR a.branch_id = $1)
           AND a.scheduled_at >= ($2::date::timestamp AT TIME ZONE $3)
           AND a.scheduled_at <  (($2::date + 1)::timestamp AT TIME ZONE $3)
         ORDER BY a.scheduled_at`,
        [branchId, date, BUSINESS_TZ],
      );
      return rows.map(toAppointment);
    },

    async findById(id, { forUpdate = false } = {}) {
      const { rows } = await db.query(
        `${SELECT} WHERE a.appointment_id = $1 ${forUpdate ? 'FOR UPDATE OF a' : ''}`,
        [id],
      );
      return toAppointment(rows[0]) ?? null;
    },

    async countActiveInSlot({ branchId, from, to, excludeId = null }) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS total FROM branch_appointments
         WHERE branch_id = $1 AND scheduled_at >= $2 AND scheduled_at < $3
           AND status NOT IN ('CANCELLED', 'NO_SHOW')
           AND ($4::uuid IS NULL OR appointment_id <> $4)`,
        [branchId, from, to, excludeId],
      );
      return rows[0].total;
    },

    async insert({ customerId, branchId, serviceType, scheduledAt, notes, createdBy }) {
      const { rows } = await db.query(
        `INSERT INTO branch_appointments
           (customer_id, branch_id, service_type, scheduled_at, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING appointment_id`,
        [customerId, branchId, serviceType, scheduledAt, notes ?? null, createdBy],
      );
      return this.findById(rows[0].appointment_id);
    },

    async update(id, { status, scheduledAt }) {
      await db.query(
        `UPDATE branch_appointments
         SET status = $2, scheduled_at = COALESCE($3, scheduled_at)
         WHERE appointment_id = $1`,
        [id, status, scheduledAt ?? null],
      );
      return this.findById(id);
    },
  });
}
