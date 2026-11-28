import { BUSINESS_TZ, outletScopeSql } from '../../shared/sql.js';

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
    async listByDay({ date, scope }) {
      const params = [];
      const where = outletScopeSql('a.branch_id', scope, params);
      params.push(date, BUSINESS_TZ);
      const d = `$${params.length - 1}`;
      const tz = `$${params.length}`;
      const { rows } = await db.query(
        `${SELECT}
         WHERE ${where}
           AND a.scheduled_at >= (${d}::date::timestamp AT TIME ZONE ${tz})
           AND a.scheduled_at <  ((${d}::date + 1)::timestamp AT TIME ZONE ${tz})
         ORDER BY a.scheduled_at`,
        params,
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

    async insert({
      customerId,
      branchId,
      serviceType,
      scheduledAt,
      notes,
      createdBy,
      integrationSourceId,
      integrationKeyHash,
    }) {
      const { rows } = await db.query(
        `INSERT INTO branch_appointments
           (customer_id, branch_id, service_type, scheduled_at, notes, created_by,
            integration_source_id, integration_external_key_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING appointment_id`,
        [
          customerId,
          branchId,
          serviceType,
          scheduledAt,
          notes ?? null,
          createdBy,
          integrationSourceId ?? null,
          integrationKeyHash ?? null,
        ],
      );
      return this.findById(rows[0].appointment_id);
    },

    async findByIntegrationKey(sourceId, keyHash) {
      const { rows } = await db.query(
        `SELECT appointment_id FROM branch_appointments
         WHERE integration_source_id = $1 AND integration_external_key_hash = $2`,
        [sourceId, keyHash],
      );
      return rows[0] ? this.findById(rows[0].appointment_id) : null;
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
