import { outletScopeSql, toNumber } from '../../shared/sql.js';

function addPeriod(where, params, column, { from, to }) {
  if (from) {
    params.push(from);
    where.push(`${column} >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`${column} <= $${params.length}::date`);
  }
}

function totalsOf(rows, keys) {
  return Object.fromEntries(
    keys.map((key) => [key, rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)]),
  );
}

export function createReportsRepository(db) {
  return Object.freeze({
    async dailySales({ scope, from, to, groupBy }) {
      const params = [];
      const where = [outletScopeSql('s.branch_id', scope, params)];
      addPeriod(where, params, 's.business_date', { from, to });
      const dimensions = {
        city: {
          key: `COALESCE(NULLIF(b.city, ''), 'Unknown')`,
          code: `COALESCE(NULLIF(b.city, ''), 'Unknown')`,
          name: `COALESCE(NULLIF(b.city, ''), 'Unknown')`,
          extra: `COALESCE(NULLIF(b.province, ''), 'Unknown')`,
        },
        province: {
          key: `COALESCE(NULLIF(b.province, ''), 'Unknown')`,
          code: `COALESCE(NULLIF(b.province, ''), 'Unknown')`,
          name: `COALESCE(NULLIF(b.province, ''), 'Unknown')`,
          extra: 'NULL::text',
        },
      };
      const dimension = dimensions[groupBy];
      const { rows } = await db.query(
        `SELECT ${dimension.key} AS key, ${dimension.code} AS code,
                ${dimension.name} AS name, ${dimension.extra} AS extra,
                sum(s.transaction_count) AS transactions,
                sum(s.buy_count) AS buy_count,
                sum(s.sell_count) AS sell_count,
                sum(s.buy_amount) AS buy_amount,
                sum(s.sell_amount) AS sell_amount,
                sum(s.bonus_amount) AS bonus,
                sum(s.weight_gram) AS grams
         FROM daily_branch_summary s
         JOIN branches b ON b.branch_id = s.branch_id
         WHERE ${where.join(' AND ')}
         GROUP BY 1, 2, 3, 4
         ORDER BY sum(s.buy_amount + s.sell_amount) DESC`,
        params,
      );
      const resultRows = rows.map((row) => ({
        key: row.key,
        code: row.code,
        name: row.name,
        ...(row.extra ? { province: row.extra } : {}),
        transactions: toNumber(row.transactions),
        buyCount: toNumber(row.buy_count),
        sellCount: toNumber(row.sell_count),
        buyAmount: toNumber(row.buy_amount),
        sellAmount: toNumber(row.sell_amount),
        bonus: toNumber(row.bonus),
        grams: toNumber(row.grams),
      }));
      return {
        totals: totalsOf(resultRows, [
          'transactions',
          'buyCount',
          'sellCount',
          'buyAmount',
          'sellAmount',
          'bonus',
          'grams',
        ]),
        rows: resultRows,
      };
    },

    async transactionSummary({ scope, from, to, groupBy }) {
      const params = [];
      const where = [outletScopeSql('t.branch_id', scope, params)];
      const localDate = `(t.occurred_at AT TIME ZONE COALESCE(b.timezone, 'Asia/Jakarta'))::date`;
      addPeriod(where, params, localDate, { from, to });
      const dimensions = {
        branch: {
          key: 't.branch_id',
          code: `COALESCE(b.branch_code, 'ONLINE')`,
          name: `COALESCE(b.name, 'Online')`,
          extra: 'NULL::text',
        },
        area: {
          key: 'b.area_id',
          code: `COALESCE(ar.area_code, 'UNKNOWN')`,
          name: `COALESCE(ar.name, 'Unknown area')`,
          extra: 'NULL::text',
        },
        city: {
          key: `concat_ws('|', COALESCE(NULLIF(b.city, ''), 'Unknown'), COALESCE(NULLIF(b.province, ''), 'Unknown'))`,
          code: `COALESCE(NULLIF(b.city, ''), 'Unknown')`,
          name: `COALESCE(NULLIF(b.city, ''), 'Unknown')`,
          extra: `COALESCE(NULLIF(b.province, ''), 'Unknown')`,
        },
        reference: {
          key: 'c.acquisition_reference_id',
          code: `COALESCE(r.code, 'UNKNOWN')`,
          name: `COALESCE(r.name, 'Unknown reference')`,
          extra: 'NULL::text',
        },
      };
      const dimension = dimensions[groupBy];
      const fromSql = `FROM gold_transactions t
         LEFT JOIN branches b ON b.branch_id = t.branch_id
         JOIN customers c ON c.customer_id = t.customer_id
         LEFT JOIN areas ar ON ar.area_id = b.area_id
         LEFT JOIN acquisition_references r ON r.reference_id = c.acquisition_reference_id`;
      const { rows } = await db.query(
        `SELECT ${dimension.key} AS key, ${dimension.code} AS code,
                ${dimension.name} AS name, ${dimension.extra} AS extra,
                count(*) AS transactions,
                count(*) FILTER (WHERE t.side = 'BUY') AS buy_count,
                count(*) FILTER (WHERE t.side = 'SELL') AS sell_count,
                COALESCE(sum(t.amount) FILTER (WHERE t.side = 'BUY'), 0) AS buy_amount,
                COALESCE(sum(t.amount) FILTER (WHERE t.side = 'SELL'), 0) AS sell_amount,
                COALESCE(sum(t.bonus_amount), 0) AS bonus,
                COALESCE(sum(t.weight_gram), 0) AS grams
         ${fromSql}
         WHERE ${where.join(' AND ')}
         GROUP BY 1, 2, 3, 4
         ORDER BY sum(t.amount) DESC`,
        params,
      );
      const resultRows = rows.map((row) => ({
        key: row.key,
        code: row.code,
        name: row.name,
        ...(row.extra ? { province: row.extra } : {}),
        transactions: toNumber(row.transactions),
        buyCount: toNumber(row.buy_count),
        sellCount: toNumber(row.sell_count),
        buyAmount: toNumber(row.buy_amount),
        sellAmount: toNumber(row.sell_amount),
        bonus: toNumber(row.bonus),
        grams: toNumber(row.grams),
      }));
      return {
        totals: totalsOf(resultRows, [
          'transactions',
          'buyCount',
          'sellCount',
          'buyAmount',
          'sellAmount',
          'bonus',
          'grams',
        ]),
        rows: resultRows,
      };
    },

    async customerSummary({ scope, from, to, groupBy }) {
      const params = [];
      const where = [outletScopeSql('m.branch_id', scope, params)];
      addPeriod(where, params, 'm.business_date', { from, to });
      const dimensions = {
        tier: { key: 'm.tier_code', code: 'm.tier_code', name: 'm.tier_code', extra: 'NULL::text' },
        branch: {
          key: 'm.branch_id',
          code: `COALESCE(b.branch_code, 'UNASSIGNED')`,
          name: `COALESCE(b.name, 'Unassigned')`,
          extra: 'NULL::text',
        },
        area: {
          key: 'm.area_id',
          code: `COALESCE(ar.area_code, 'UNKNOWN')`,
          name: `COALESCE(ar.name, 'Unknown area')`,
          extra: 'NULL::text',
        },
        city: {
          key: `concat_ws('|', m.city, m.province)`,
          code: 'm.city',
          name: 'm.city',
          extra: 'm.province',
        },
        reference: {
          key: 'm.acquisition_reference_id',
          code: `COALESCE(r.code, 'UNKNOWN')`,
          name: `COALESCE(r.name, 'Unknown reference')`,
          extra: 'NULL::text',
        },
      };
      const dimension = dimensions[groupBy];
      const { rows } = await db.query(
        `SELECT ${dimension.key} AS key, ${dimension.code} AS code,
                ${dimension.name} AS name, ${dimension.extra} AS extra,
                sum(m.customer_count) AS customers,
                sum(m.marketing_opt_in_count) AS marketing_opt_ins
         FROM mv_customer_summary m
         LEFT JOIN branches b ON b.branch_id = m.branch_id
         LEFT JOIN areas ar ON ar.area_id = m.area_id
         LEFT JOIN acquisition_references r ON r.reference_id = m.acquisition_reference_id
         WHERE ${where.join(' AND ')}
         GROUP BY 1, 2, 3, 4
         ORDER BY sum(m.customer_count) DESC`,
        params,
      );
      const resultRows = rows.map((row) => ({
        key: row.key,
        code: row.code,
        name: row.name,
        ...(row.extra ? { province: row.extra } : {}),
        customers: toNumber(row.customers),
        marketingOptIns: toNumber(row.marketing_opt_ins),
      }));
      return {
        totals: totalsOf(resultRows, ['customers', 'marketingOptIns']),
        rows: resultRows,
      };
    },

    async appDemographics({ scope, from, to }) {
      const params = [];
      const where = ['m.has_mobile_app = true', outletScopeSql('m.branch_id', scope, params)];
      addPeriod(where, params, 'm.business_date', { from, to });
      const filter = where.join(' AND ');
      const { rows: totalsRows } = await db.query(
        `SELECT sum(m.customer_count) AS customers,
                sum(m.customer_count) FILTER (WHERE m.gender = 'F') AS female,
                sum(m.customer_count) FILTER (WHERE m.gender = 'M') AS male,
                sum(m.customer_count) FILTER (WHERE m.gender = 'U') AS unknown_gender
         FROM mv_customer_summary m
         WHERE ${filter}`,
        params,
      );
      const { rows } = await db.query(
        `SELECT m.age_band, m.gender, sum(m.customer_count) AS customers
         FROM mv_customer_summary m
         WHERE ${filter}
         GROUP BY m.age_band, m.gender
         HAVING sum(m.customer_count) >= 5
         ORDER BY m.age_band, m.gender`,
        params,
      );
      const totals = totalsRows[0];
      return {
        totals: {
          customers: toNumber(totals.customers) ?? 0,
          female: toNumber(totals.female) ?? 0,
          male: toNumber(totals.male) ?? 0,
          unknownGender: toNumber(totals.unknown_gender) ?? 0,
        },
        rows: rows.map((row) => ({
          ageBand: row.age_band,
          gender: row.gender,
          customers: toNumber(row.customers),
        })),
        suppressedGroups: true,
      };
    },

    async lmreiSummary({ scope, from, to }) {
      const params = [];
      const where = [outletScopeSql('a.branch_id', scope, params)];
      const localDate = `(COALESCE(a.settled_at, a.created_at) AT TIME ZONE b.timezone)::date`;
      addPeriod(where, params, localDate, { from, to });
      const { rows } = await db.query(
        `SELECT a.branch_id, b.branch_code, b.name AS branch_name,
                count(*) AS appraisals,
                count(*) FILTER (WHERE a.status = 'OFFERED') AS offered,
                count(*) FILTER (WHERE a.status = 'ACCEPTED') AS accepted,
                count(*) FILTER (WHERE a.status = 'REJECTED') AS rejected,
                count(*) FILTER (WHERE a.status = 'SETTLED') AS settled,
                COALESCE(sum(a.weight_gram) FILTER (WHERE a.status = 'SETTLED'), 0) AS grams,
                COALESCE(sum(a.final_price) FILTER (WHERE a.status = 'SETTLED'), 0) AS settled_amount
         FROM appraisal_records a
         JOIN branches b ON b.branch_id = a.branch_id
         WHERE ${where.join(' AND ')}
         GROUP BY a.branch_id, b.branch_code, b.name
         ORDER BY settled_amount DESC`,
        params,
      );
      const resultRows = rows.map((row) => ({
        branchId: row.branch_id,
        branchCode: row.branch_code,
        branchName: row.branch_name,
        appraisals: toNumber(row.appraisals),
        offered: toNumber(row.offered),
        accepted: toNumber(row.accepted),
        rejected: toNumber(row.rejected),
        settled: toNumber(row.settled),
        grams: toNumber(row.grams),
        settledAmount: toNumber(row.settled_amount),
      }));
      return {
        totals: totalsOf(resultRows, [
          'appraisals',
          'offered',
          'accepted',
          'rejected',
          'settled',
          'grams',
          'settledAmount',
        ]),
        rows: resultRows,
      };
    },
  });
}
