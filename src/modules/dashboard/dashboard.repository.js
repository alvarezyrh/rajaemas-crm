import { BUSINESS_TZ, outletScopeFilter, outletScopeSql, toNumber } from '../../shared/sql.js';

/**
 * Dashboard aggregates. The `scope` argument comes from `dataScopeOf(actor)`:
 * one outlet, one area, or (both null) every outlet.
 */
export function createDashboardRepository(db) {
  return Object.freeze({
    async summary(scope) {
      const params = [];
      const scopeFilter = outletScopeFilter(scope, params);
      const customersScope = scopeFilter('home_branch_id');
      const outletScope = scopeFilter('branch_id');
      params.push(BUSINESS_TZ);
      const tz = `$${params.length}`;

      const { rows } = await db.query(
        `SELECT
           (SELECT count(*) FROM customers
             WHERE ${customersScope}) AS customers,
           (SELECT count(*) FROM branch_appointments
             WHERE ${outletScope}
               AND status NOT IN ('CANCELLED', 'NO_SHOW')
               AND (scheduled_at AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date) AS appointments_today,
           (SELECT count(*) FROM appraisal_records
             WHERE ${outletScope}
               AND status IN ('OFFERED', 'ACCEPTED')) AS open_appraisals,
           (SELECT COALESCE(sum(final_price), 0) FROM appraisal_records
             WHERE ${outletScope} AND status = 'SETTLED'
               AND settled_at >= date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS buyback_month,
           (SELECT count(*) FROM customer_interactions
             WHERE ${outletScope}
               AND occurred_at >= now() - interval '7 days') AS interactions_7d`,
        params,
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

    async tierDistribution(scope) {
      const params = [];
      const where = outletScopeSql('home_branch_id', scope, params);
      const { rows } = await db.query(
        `SELECT tier_code, count(*) AS total FROM customers
         WHERE ${where}
         GROUP BY tier_code`,
        params,
      );
      return Object.fromEntries(rows.map((row) => [row.tier_code, toNumber(row.total)]));
    },

    async upcomingAppointments(scope, limit) {
      const params = [];
      const where = outletScopeSql('a.branch_id', scope, params);
      params.push(limit);
      const { rows } = await db.query(
        `SELECT a.appointment_id, a.scheduled_at, a.service_type, a.status,
                c.customer_id, c.full_name, b.branch_code
         FROM branch_appointments a
         JOIN customers c ON c.customer_id = a.customer_id
         JOIN branches b ON b.branch_id = a.branch_id
         WHERE ${where}
           AND a.scheduled_at >= now()
           AND a.status IN ('SCHEDULED', 'CONFIRMED')
         ORDER BY a.scheduled_at
         LIMIT $${params.length}`,
        params,
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
