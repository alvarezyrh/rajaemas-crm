-- =====================================================================
-- 010_reporting — daily OLAP projections and customer summary
-- =====================================================================

CREATE TABLE daily_branch_summary (
  branch_id          uuid          NOT NULL REFERENCES branches (branch_id),
  business_date      date          NOT NULL,
  transaction_count  bigint        NOT NULL DEFAULT 0,
  buy_count          bigint        NOT NULL DEFAULT 0,
  sell_count         bigint        NOT NULL DEFAULT 0,
  buy_amount         numeric(20,2) NOT NULL DEFAULT 0,
  sell_amount        numeric(20,2) NOT NULL DEFAULT 0,
  bonus_amount       numeric(20,2) NOT NULL DEFAULT 0,
  weight_gram        numeric(16,3) NOT NULL DEFAULT 0,
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, business_date)
);
CREATE INDEX daily_branch_summary_date_idx ON daily_branch_summary (business_date, branch_id);

CREATE TABLE daily_city_summary (
  city               varchar(80)   NOT NULL,
  province           varchar(80)   NOT NULL,
  business_date      date          NOT NULL,
  branch_count       bigint        NOT NULL DEFAULT 0,
  transaction_count  bigint        NOT NULL DEFAULT 0,
  buy_count          bigint        NOT NULL DEFAULT 0,
  sell_count         bigint        NOT NULL DEFAULT 0,
  buy_amount         numeric(20,2) NOT NULL DEFAULT 0,
  sell_amount        numeric(20,2) NOT NULL DEFAULT 0,
  bonus_amount       numeric(20,2) NOT NULL DEFAULT 0,
  weight_gram        numeric(16,3) NOT NULL DEFAULT 0,
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (city, province, business_date)
);
CREATE INDEX daily_city_summary_date_idx
  ON daily_city_summary (business_date, province, city);

CREATE TABLE reporting_processed_transactions (
  transaction_id uuid PRIMARY KEY REFERENCES gold_transactions (transaction_id) ON DELETE CASCADE,
  processed_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO reporting_processed_transactions (transaction_id)
SELECT transaction_id
FROM gold_transactions
WHERE branch_id IS NOT NULL;

INSERT INTO daily_branch_summary (
  branch_id, business_date, transaction_count, buy_count, sell_count,
  buy_amount, sell_amount, bonus_amount, weight_gram
)
SELECT
  t.branch_id,
  (t.occurred_at AT TIME ZONE b.timezone)::date,
  count(*),
  count(*) FILTER (WHERE t.side = 'BUY'),
  count(*) FILTER (WHERE t.side = 'SELL'),
  COALESCE(sum(t.amount) FILTER (WHERE t.side = 'BUY'), 0),
  COALESCE(sum(t.amount) FILTER (WHERE t.side = 'SELL'), 0),
  COALESCE(sum(t.bonus_amount), 0),
  COALESCE(sum(t.weight_gram), 0)
FROM gold_transactions t
JOIN branches b ON b.branch_id = t.branch_id
GROUP BY t.branch_id, (t.occurred_at AT TIME ZONE b.timezone)::date;

INSERT INTO daily_city_summary (
  city, province, business_date, branch_count, transaction_count,
  buy_count, sell_count, buy_amount, sell_amount, bonus_amount, weight_gram
)
SELECT
  COALESCE(NULLIF(b.city, ''), 'Unknown'),
  COALESCE(NULLIF(b.province, ''), 'Unknown'),
  s.business_date,
  count(DISTINCT b.branch_id),
  sum(s.transaction_count),
  sum(s.buy_count),
  sum(s.sell_count),
  sum(s.buy_amount),
  sum(s.sell_amount),
  sum(s.bonus_amount),
  sum(s.weight_gram)
FROM daily_branch_summary s
JOIN branches b ON b.branch_id = s.branch_id
GROUP BY 1, 2, s.business_date;

CREATE MATERIALIZED VIEW mv_customer_summary AS
WITH channel_flags AS (
  SELECT
    customer_id,
    bool_or(channel = 'MOBILE_APP') AS has_mobile_app,
    bit_or(CASE channel WHEN 'STORE' THEN 1 WHEN 'MOBILE_APP' THEN 2 ELSE 4 END) AS channel_mask
  FROM customer_channels
  GROUP BY customer_id
),
customer_dimensions AS (
  SELECT
    c.home_branch_id AS branch_id,
    b.area_id,
    COALESCE(NULLIF(c.city, ''), NULLIF(b.city, ''), 'Unknown') AS city,
    COALESCE(NULLIF(c.province, ''), NULLIF(b.province, ''), 'Unknown') AS province,
    (c.created_at AT TIME ZONE COALESCE(b.timezone, 'Asia/Jakarta'))::date AS business_date,
    c.tier_code,
    c.acquisition_reference_id,
    COALESCE(c.gender, 'U') AS gender,
    COALESCE(cf.has_mobile_app, false) AS has_mobile_app,
    COALESCE(cf.channel_mask, 0) AS channel_mask,
    CASE
      WHEN c.birth_date IS NULL
        OR c.birth_date > (now() AT TIME ZONE COALESCE(b.timezone, 'Asia/Jakarta'))::date
        THEN 'UNKNOWN'
      WHEN extract(year FROM age(
        (now() AT TIME ZONE COALESCE(b.timezone, 'Asia/Jakarta'))::date,
        c.birth_date
      )) < 18 THEN 'UNDER_18'
      WHEN extract(year FROM age(
        (now() AT TIME ZONE COALESCE(b.timezone, 'Asia/Jakarta'))::date,
        c.birth_date
      )) < 25 THEN '18_24'
      WHEN extract(year FROM age(
        (now() AT TIME ZONE COALESCE(b.timezone, 'Asia/Jakarta'))::date,
        c.birth_date
      )) < 35 THEN '25_34'
      WHEN extract(year FROM age(
        (now() AT TIME ZONE COALESCE(b.timezone, 'Asia/Jakarta'))::date,
        c.birth_date
      )) < 45 THEN '35_44'
      WHEN extract(year FROM age(
        (now() AT TIME ZONE COALESCE(b.timezone, 'Asia/Jakarta'))::date,
        c.birth_date
      )) < 55 THEN '45_54'
      ELSE '55_PLUS'
    END AS age_band,
    c.marketing_consent
  FROM customers c
  LEFT JOIN branches b ON b.branch_id = c.home_branch_id
  LEFT JOIN channel_flags cf ON cf.customer_id = c.customer_id
)
SELECT
  branch_id,
  area_id,
  city,
  province,
  business_date,
  tier_code,
  acquisition_reference_id,
  gender,
  age_band,
  has_mobile_app,
  channel_mask,
  count(*) AS customer_count,
  count(*) FILTER (WHERE marketing_consent) AS marketing_opt_in_count
FROM customer_dimensions
GROUP BY
  branch_id, area_id, city, province, business_date, tier_code, acquisition_reference_id,
  gender, age_band, has_mobile_app, channel_mask;

CREATE INDEX mv_customer_summary_date_idx
  ON mv_customer_summary (business_date, branch_id);
CREATE INDEX mv_customer_summary_location_idx
  ON mv_customer_summary (province, city, business_date);
CREATE INDEX mv_customer_summary_reference_idx
  ON mv_customer_summary (acquisition_reference_id, business_date);
