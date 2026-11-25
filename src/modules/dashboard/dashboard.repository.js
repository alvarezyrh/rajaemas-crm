import { BUSINESS_TZ, toNumber } from '../../shared/sql.js';

/** Dashboard aggregates. `branchId` null = every branch. */
export function createDashboardRepository(db) {
  return Object.freeze({
    async summary(branchId) {
      const { rows } = await db.query(
        `SELECT
           (SELECT count(*) FROM customers
             WHERE $1::uuid IS NULL OR home_branch_id = $1) AS customers,
           (SELECT count(*) FROM branch_appointments
             WHERE ($1::uuid IS NULL OR branch_id = $1)
               AND status NOT IN ('CANCELLED', 'NO_SHOW')
               AND (scheduled_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date) AS appointments_today,
           (SELECT count(*) FROM appraisal_records
             WHERE ($1::uuid IS NULL OR branch_id = $1)
               AND status IN ('OFFERED', 'ACCEPTED')) AS open_appraisals,
           (SELECT COALESCE(sum(final_price), 0) FROM appraisal_records
             WHERE ($1::uuid IS NULL OR branch_id = $1) AND status = 'SETTLED'
               AND settled_at >= date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2) AS buyback_month,
           (SELECT count(*) FROM customer_interactions
             WHERE ($1::uuid IS NULL OR branch_id = $1)
               AND occurred_at >= now() - interval '7 days') AS interactions_7d`,
        [branchId, BUSINESS_TZ],
      );
      const r = rows[0];
      return {
        customers: toNumber(r.customers),
        appointmentsToday: toNumber(r.appointments_today),
        openAppraisals: toNumber(r.open_appraisals),
        buybackValueMonth: toNumber(r.buyback_month),
        interactions7d: toNumber(r.interactions_7d),
      };
    },

    async tierDistribution(branchId) {
      const { rows } = await db.query(
        `SELECT tier_code, count(*) AS total FROM customers
         WHERE $1::uuid IS NULL OR home_branch_id = $1
         GROUP BY tier_code`,
        [branchId],
      );
      return Object.fromEntries(rows.map((row) => [row.tier_code, toNumber(row.total)]));
    },

    async upcomingAppointments(branchId, limit) {
      const { rows } = await db.query(
        `SELECT a.appointment_id, a.scheduled_at, a.service_type, a.status,
                c.customer_id, c.full_name, b.branch_code
         FROM branch_appointments a
         JOIN customers c ON c.customer_id = a.customer_id
         JOIN branches b ON b.branch_id = a.branch_id
         WHERE ($1::uuid IS NULL OR a.branch_id = $1)
           AND a.scheduled_at >= now()
           AND a.status IN ('SCHEDULED', 'CONFIRMED')
         ORDER BY a.scheduled_at
         LIMIT $2`,
        [branchId, limit],
      );
      return rows.map((row) => ({
        id: row.appointment_id,
        scheduledAt: row.scheduled_at,
        serviceType: row.service_type,
        status: row.status,
        customerId: row.customer_id,
        customerName: row.full_name,
        branchCode: row.branch_code,
      }));
    },
  });
}
