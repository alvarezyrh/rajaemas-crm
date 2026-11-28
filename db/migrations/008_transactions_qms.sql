-- =====================================================================
-- 008_transactions_qms — Transaksi kaya: item per produk, petugas CS,
--   bonus staf, nomor antrean (QMS), dan penilaian layanan (CS Rating).
--
-- Urutan penting: qms_tickets dibuat lebih dulu karena gold_transactions
-- merujuk ke sana. Semua perubahan pada gold_transactions bersifat aditif —
-- transaksi lama tetap valid (kolom baru nullable atau ber-default).
-- =====================================================================

-- ---------------------------------------------------------------------
-- qms_tickets — nomor antrean gerai; sumber QMS Summary (waktu tunggu)
-- ---------------------------------------------------------------------
CREATE TABLE qms_tickets (
  ticket_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no   varchar(40) NOT NULL UNIQUE,
  branch_id   uuid NOT NULL REFERENCES branches (branch_id),
  customer_id uuid REFERENCES customers (customer_id),
  cs_id       uuid REFERENCES users (user_id),
  taken_at    timestamptz NOT NULL DEFAULT now(),
  served_at   timestamptz,
  closed_at   timestamptz,
  status      varchar(16) NOT NULL DEFAULT 'WAITING'
              CHECK (status IN ('WAITING', 'SERVING', 'DONE', 'CANCELLED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qms_served_needs_time CHECK (status NOT IN ('DONE') OR served_at IS NOT NULL)
);
CREATE INDEX qms_branch_day_idx ON qms_tickets (branch_id, taken_at DESC);
CREATE INDEX qms_status_idx     ON qms_tickets (branch_id, status);
CREATE TRIGGER qms_touch BEFORE UPDATE ON qms_tickets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- gold_transactions — header transaksi diperluas
-- ---------------------------------------------------------------------
ALTER TABLE gold_transactions
  ADD COLUMN transaction_type_id uuid REFERENCES transaction_types (type_id),
  ADD COLUMN cs_id               uuid REFERENCES users (user_id),
  ADD COLUMN bonus_amount        numeric(16,2) NOT NULL DEFAULT 0 CHECK (bonus_amount >= 0),
  ADD COLUMN qms_ticket_id       uuid REFERENCES qms_tickets (ticket_id),
  ADD COLUMN invoice_no          varchar(40);
CREATE INDEX gold_tx_type_idx ON gold_transactions (transaction_type_id, occurred_at DESC);
CREATE INDEX gold_tx_cs_idx   ON gold_transactions (cs_id, occurred_at DESC);
CREATE UNIQUE INDEX gold_tx_invoice_uidx ON gold_transactions (invoice_no)
  WHERE invoice_no IS NOT NULL;

-- ---------------------------------------------------------------------
-- transaction_items — rincian per produk; gold_transactions jadi header
-- ---------------------------------------------------------------------
CREATE TABLE transaction_items (
  item_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES gold_transactions (transaction_id) ON DELETE CASCADE,
  product_id     uuid REFERENCES products (product_id),
  description    varchar(200) NOT NULL,
  weight_gram    numeric(10,3) NOT NULL CHECK (weight_gram > 0),
  karat          numeric(4,2) CHECK (karat > 0 AND karat <= 24),
  unit_price     numeric(16,2) NOT NULL CHECK (unit_price >= 0),
  amount         numeric(16,2) NOT NULL CHECK (amount >= 0)
);
CREATE INDEX transaction_items_tx_idx      ON transaction_items (transaction_id);
CREATE INDEX transaction_items_product_idx ON transaction_items (product_id);

-- ---------------------------------------------------------------------
-- cs_ratings — penilaian layanan; sumber CS Rating Summary & Bonus Summary
-- ---------------------------------------------------------------------
CREATE TABLE cs_ratings (
  rating_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES gold_transactions (transaction_id),
  qms_ticket_id  uuid REFERENCES qms_tickets (ticket_id),
  cs_id          uuid NOT NULL REFERENCES users (user_id),
  branch_id      uuid NOT NULL REFERENCES branches (branch_id),
  score          smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment        varchar(500),
  rated_at       timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- One rating per counter visit: a ticket or a transaction, never both twice.
  CONSTRAINT cs_rating_once_per_ticket UNIQUE (qms_ticket_id),
  CONSTRAINT cs_rating_once_per_transaction UNIQUE (transaction_id),
  CONSTRAINT cs_rating_needs_source CHECK (qms_ticket_id IS NOT NULL OR transaction_id IS NOT NULL)
);
CREATE INDEX cs_ratings_cs_idx     ON cs_ratings (cs_id, rated_at DESC);
CREATE INDEX cs_ratings_branch_idx ON cs_ratings (branch_id, rated_at DESC);
