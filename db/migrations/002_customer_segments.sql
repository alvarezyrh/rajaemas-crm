-- =====================================================================
-- 002_customer_segments — Klaster nasabah berbasis kanal
--   STORE      : jual/beli emas di toko (gerai)
--   MOBILE_APP : pengguna aplikasi mobile (akun tertaut)
--   ECOMMERCE  : membeli emas di website e-commerce
-- Keanggotaan klaster diturunkan dari perilaku (akun & transaksi), bukan
-- label manual, dan satu nasabah boleh berada di beberapa klaster.
-- =====================================================================

-- ---------------------------------------------------------------------
-- customer_channels — keanggotaan nasabah per kanal (satu baris per kanal)
-- ---------------------------------------------------------------------
CREATE TABLE customer_channels (
  customer_id         uuid         NOT NULL REFERENCES customers (customer_id),
  channel             varchar(16)  NOT NULL
                      CHECK (channel IN ('STORE', 'MOBILE_APP', 'ECOMMERCE')),
  -- id akun di sistem sumber (aplikasi / toko online); NULL untuk toko fisik
  external_account_id varchar(128),
  first_seen_at       timestamptz  NOT NULL DEFAULT now(),
  last_active_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, channel),
  CONSTRAINT customer_channels_account_unique UNIQUE (channel, external_account_id),
  CONSTRAINT customer_channels_seen_order CHECK (last_active_at >= first_seen_at)
);
CREATE INDEX customer_channels_channel_idx ON customer_channels (channel, last_active_at DESC);

-- ---------------------------------------------------------------------
-- gold_transactions — transaksi jual/beli emas lintas kanal
--   side = sudut pandang nasabah: BUY (nasabah membeli), SELL (nasabah menjual)
-- ---------------------------------------------------------------------
CREATE TABLE gold_transactions (
  transaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid          NOT NULL REFERENCES customers (customer_id),
  channel        varchar(16)   NOT NULL
                 CHECK (channel IN ('STORE', 'MOBILE_APP', 'ECOMMERCE')),
  side           varchar(4)    NOT NULL CHECK (side IN ('BUY', 'SELL')),
  branch_id      uuid REFERENCES branches (branch_id),
  description    varchar(200),
  weight_gram    numeric(10,3) NOT NULL CHECK (weight_gram > 0),
  amount         numeric(16,2) NOT NULL CHECK (amount >= 0),
  -- "<kanal>:<id pesanan>" dari sistem sumber; menjamin idempotensi webhook
  external_ref   varchar(160) UNIQUE,
  -- buyback toko yang berasal dari taksiran (satu taksiran = satu transaksi)
  appraisal_id   uuid UNIQUE REFERENCES appraisal_records (appraisal_id),
  recorded_by    uuid REFERENCES users (user_id),
  occurred_at    timestamptz   NOT NULL DEFAULT now(),
  created_at     timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT gold_tx_store_needs_branch CHECK (channel <> 'STORE' OR branch_id IS NOT NULL),
  CONSTRAINT gold_tx_ecommerce_buy_only CHECK (channel <> 'ECOMMERCE' OR side = 'BUY')
);
CREATE INDEX gold_tx_customer_idx ON gold_transactions (customer_id, occurred_at DESC);
CREATE INDEX gold_tx_channel_idx  ON gold_transactions (channel, occurred_at DESC);
CREATE INDEX gold_tx_branch_idx   ON gold_transactions (branch_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- Backfill: buyback toko yang sudah selesai = nasabah menjual emas di toko
-- ---------------------------------------------------------------------
INSERT INTO gold_transactions
  (customer_id, channel, side, branch_id, description, weight_gram, amount,
   appraisal_id, recorded_by, occurred_at)
SELECT r.customer_id, 'STORE', 'SELL', r.branch_id, r.item_description, r.weight_gram,
       r.final_price, r.appraisal_id, r.appraiser_id, r.settled_at
FROM appraisal_records r
WHERE r.status = 'SETTLED';

INSERT INTO customer_channels (customer_id, channel, first_seen_at, last_active_at)
SELECT customer_id, 'STORE', min(occurred_at), max(occurred_at)
FROM gold_transactions
WHERE channel = 'STORE'
GROUP BY customer_id
ON CONFLICT (customer_id, channel) DO NOTHING;
