const TRANSACTION_RECORDED = 'reporting.transaction_recorded';
const BUYBACK_SETTLED = 'reporting.buyback_settled';
const CACHE_TTL_SEC = 48 * 60 * 60;
const CUSTOMER_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const dateKey = (date) => date.replaceAll('-', '');

export function createReadModel({ db, cache, bus, logger }) {
  async function cacheBranchDay(executor, branchId, businessDate, city, province) {
    const { rows: branchRows } = await executor.query(
      `SELECT * FROM daily_branch_summary
       WHERE branch_id = $1 AND business_date = $2`,
      [branchId, businessDate],
    );
    const { rows: hours } = await executor.query(
      `SELECT extract(hour FROM t.occurred_at AT TIME ZONE b.timezone)::int AS hour,
              count(*) AS transaction_count,
              COALESCE(sum(t.amount) FILTER (WHERE t.side = 'BUY'), 0) AS buy_amount,
              COALESCE(sum(t.amount) FILTER (WHERE t.side = 'SELL'), 0) AS sell_amount
       FROM gold_transactions t
       JOIN branches b ON b.branch_id = t.branch_id
       WHERE t.branch_id = $1
         AND (t.occurred_at AT TIME ZONE b.timezone)::date = $2
       GROUP BY 1
       ORDER BY 1`,
      [branchId, businessDate],
    );
    const keyDate = dateKey(businessDate);
    await cache.set(`omset:live:${branchId}:${keyDate}`, branchRows[0] ?? null, CACHE_TTL_SEC);
    const hourlyKey = `omset:hourly:${branchId}:${keyDate}`;
    await cache.del(hourlyKey);
    for (const hour of hours) {
      await cache.zAdd(
        hourlyKey,
        Number(hour.buy_amount) + Number(hour.sell_amount),
        String(hour.hour),
        CACHE_TTL_SEC,
      );
    }

    const { rows: cityRows } = await executor.query(
      `SELECT * FROM daily_city_summary
       WHERE city = $1 AND province = $2 AND business_date = $3`,
      [city, province, businessDate],
    );
    await cache.set(`omset:city:${city}:${keyDate}`, cityRows[0] ?? null, CACHE_TTL_SEC);
  }

  async function recordTransaction(transactionId) {
    const cacheInput = await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT t.transaction_id, t.branch_id, t.side, t.amount, t.bonus_amount,
                t.weight_gram,
                (t.occurred_at AT TIME ZONE b.timezone)::date::text AS business_date,
                COALESCE(NULLIF(b.city, ''), 'Unknown') AS city,
                COALESCE(NULLIF(b.province, ''), 'Unknown') AS province
         FROM gold_transactions t
         JOIN branches b ON b.branch_id = t.branch_id
         WHERE t.transaction_id = $1`,
        [transactionId],
      );
      const transaction = rows[0];
      if (!transaction) return null;

      const { rowCount } = await tx.query(
        `INSERT INTO reporting_processed_transactions (transaction_id)
         VALUES ($1) ON CONFLICT DO NOTHING`,
        [transaction.transaction_id],
      );
      if (rowCount > 0) {
        await tx.query(
          `INSERT INTO daily_branch_summary (
             branch_id, business_date, transaction_count, buy_count, sell_count,
             buy_amount, sell_amount, bonus_amount, weight_gram
           )
           VALUES (
             $1, $2, 1, CASE WHEN $3 = 'BUY' THEN 1 ELSE 0 END,
             CASE WHEN $3 = 'SELL' THEN 1 ELSE 0 END,
             CASE WHEN $3 = 'BUY' THEN $4::numeric ELSE 0::numeric END,
             CASE WHEN $3 = 'SELL' THEN $4::numeric ELSE 0::numeric END,
             $5::numeric, $6::numeric
           )
           ON CONFLICT (branch_id, business_date) DO UPDATE SET
             transaction_count = daily_branch_summary.transaction_count + 1,
             buy_count = daily_branch_summary.buy_count + EXCLUDED.buy_count,
             sell_count = daily_branch_summary.sell_count + EXCLUDED.sell_count,
             buy_amount = daily_branch_summary.buy_amount + EXCLUDED.buy_amount,
             sell_amount = daily_branch_summary.sell_amount + EXCLUDED.sell_amount,
             bonus_amount = daily_branch_summary.bonus_amount + EXCLUDED.bonus_amount,
             weight_gram = daily_branch_summary.weight_gram + EXCLUDED.weight_gram,
             updated_at = now()`,
          [
            transaction.branch_id,
            transaction.business_date,
            transaction.side,
            transaction.amount,
            transaction.bonus_amount,
            transaction.weight_gram,
          ],
        );

        await tx.query(
          `DELETE FROM daily_city_summary
           WHERE city = $1 AND province = $2 AND business_date = $3`,
          [transaction.city, transaction.province, transaction.business_date],
        );
        await tx.query(
          `INSERT INTO daily_city_summary (
             city, province, business_date, branch_count, transaction_count,
             buy_count, sell_count, buy_amount, sell_amount, bonus_amount, weight_gram
           )
           SELECT $1::varchar(80), $2::varchar(80), $3::date,
                  count(*), sum(s.transaction_count),
                  sum(s.buy_count), sum(s.sell_count), sum(s.buy_amount),
                  sum(s.sell_amount), sum(s.bonus_amount), sum(s.weight_gram)
           FROM daily_branch_summary s
           JOIN branches b ON b.branch_id = s.branch_id
           WHERE s.business_date = $3
             AND COALESCE(NULLIF(b.city, ''), 'Unknown')::varchar(80) = $1::varchar(80)
             AND COALESCE(NULLIF(b.province, ''), 'Unknown')::varchar(80) = $2::varchar(80)`,
          [transaction.city, transaction.province, transaction.business_date],
        );
      }

      return {
        branchId: transaction.branch_id,
        businessDate: transaction.business_date,
        city: transaction.city,
        province: transaction.province,
      };
    });
    if (cacheInput) {
      await cacheBranchDay(
        db,
        cacheInput.branchId,
        cacheInput.businessDate,
        cacheInput.city,
        cacheInput.province,
      );
    }
  }

  async function recordBuyback(appraisalId) {
    const { rows } = await db.query(
      'SELECT transaction_id FROM gold_transactions WHERE appraisal_id = $1',
      [appraisalId],
    );
    if (rows[0]) await recordTransaction(rows[0].transaction_id);
  }

  async function rebuild() {
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(418207631)');
      await tx.query(
        `TRUNCATE reporting_processed_transactions, daily_branch_summary, daily_city_summary`,
      );
      await tx.query(
        `INSERT INTO reporting_processed_transactions (transaction_id)
         SELECT transaction_id FROM gold_transactions WHERE branch_id IS NOT NULL`,
      );
      await tx.query(
        `INSERT INTO daily_branch_summary (
           branch_id, business_date, transaction_count, buy_count, sell_count,
           buy_amount, sell_amount, bonus_amount, weight_gram
         )
         SELECT t.branch_id, (t.occurred_at AT TIME ZONE b.timezone)::date,
                count(*), count(*) FILTER (WHERE t.side = 'BUY'),
                count(*) FILTER (WHERE t.side = 'SELL'),
                COALESCE(sum(t.amount) FILTER (WHERE t.side = 'BUY'), 0),
                COALESCE(sum(t.amount) FILTER (WHERE t.side = 'SELL'), 0),
                COALESCE(sum(t.bonus_amount), 0), COALESCE(sum(t.weight_gram), 0)
         FROM gold_transactions t
         JOIN branches b ON b.branch_id = t.branch_id
         GROUP BY t.branch_id, (t.occurred_at AT TIME ZONE b.timezone)::date`,
      );
      await tx.query(
        `INSERT INTO daily_city_summary (
           city, province, business_date, branch_count, transaction_count,
           buy_count, sell_count, buy_amount, sell_amount, bonus_amount, weight_gram
         )
         SELECT COALESCE(NULLIF(b.city, ''), 'Unknown'),
                COALESCE(NULLIF(b.province, ''), 'Unknown'), s.business_date,
                count(DISTINCT b.branch_id), sum(s.transaction_count),
                sum(s.buy_count), sum(s.sell_count), sum(s.buy_amount),
                sum(s.sell_amount), sum(s.bonus_amount), sum(s.weight_gram)
         FROM daily_branch_summary s
         JOIN branches b ON b.branch_id = s.branch_id
         GROUP BY 1, 2, s.business_date`,
      );
      await tx.query('REFRESH MATERIALIZED VIEW mv_customer_summary');
    });
    await hydrateCache();
  }

  async function reconcile() {
    let recovered = 0;
    for (;;) {
      const { rows } = await db.query(
        `SELECT t.transaction_id
         FROM gold_transactions t
         LEFT JOIN reporting_processed_transactions p
           ON p.transaction_id = t.transaction_id
         WHERE t.branch_id IS NOT NULL AND p.transaction_id IS NULL
         ORDER BY t.occurred_at
         LIMIT 500`,
      );
      if (rows.length === 0) return recovered;
      await Promise.all(rows.map((row) => recordTransaction(row.transaction_id)));
      recovered += rows.length;
    }
  }

  async function hydrateCache() {
    const { rows } = await db.query(
      `SELECT s.branch_id, s.business_date::text AS business_date,
              COALESCE(NULLIF(b.city, ''), 'Unknown') AS city,
              COALESCE(NULLIF(b.province, ''), 'Unknown') AS province
       FROM daily_branch_summary s
       JOIN branches b ON b.branch_id = s.branch_id
       WHERE s.business_date = (now() AT TIME ZONE b.timezone)::date`,
    );
    for (const row of rows) {
      await cacheBranchDay(db, row.branch_id, row.business_date, row.city, row.province);
    }
  }

  async function refreshCustomers() {
    const lockKey = 'reporting:customer-summary-refresh';
    if (!(await cache.setIfAbsent(lockKey, true, 270))) return;
    await db.query('REFRESH MATERIALIZED VIEW mv_customer_summary');
  }

  bus.subscribe(TRANSACTION_RECORDED, ({ transactionId }) => recordTransaction(transactionId));
  bus.subscribe(BUYBACK_SETTLED, ({ appraisalId }) => recordBuyback(appraisalId));

  const timer = setInterval(() => {
    refreshCustomers().catch((err) => logger.error('read_model.customer_refresh_failed', { err }));
  }, CUSTOMER_REFRESH_INTERVAL_MS);
  timer.unref();

  return Object.freeze({
    rebuild,
    reconcile,
    hydrateCache,
    stop: () => clearInterval(timer),
  });
}

export const ReadModelEvents = Object.freeze({
  TRANSACTION_RECORDED,
  BUYBACK_SETTLED,
});
