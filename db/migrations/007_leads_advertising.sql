-- =====================================================================
-- 007_leads_advertising — Akuisisi: prospek (leads) dan anggaran iklan
--   leads              : prospek dari kanal mana pun, sebelum jadi nasabah
--   advertising_budgets: alokasi biaya akuisisi per area × kanal × bulan
--   customers          : ditautkan balik ke lead & kanal akuisisinya
-- Nomor telepon lead diperlakukan seperti PII nasabah: terenkripsi
-- (AES-256-GCM) + blind index HMAC dengan domain 'phone' yang sama, sehingga
-- "nomor ini sudah jadi nasabah?" bisa dijawab tanpa membuka plaintext.
-- =====================================================================

-- ---------------------------------------------------------------------
-- leads — dibuat tanpa FK ke customers dulu (rujukan melingkar)
-- ---------------------------------------------------------------------
CREATE TABLE leads (
  lead_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       varchar(120) NOT NULL,
  phone_hash      char(64)     NOT NULL,
  phone_encrypted text         NOT NULL,
  phone_last4     char(4)      NOT NULL,
  email           varchar(160),
  reference_id    uuid REFERENCES acquisition_references (reference_id),
  area_id         uuid REFERENCES areas (area_id),
  branch_id       uuid REFERENCES branches (branch_id),
  status          varchar(16)  NOT NULL DEFAULT 'NEW'
                  CHECK (status IN ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST', 'EXPIRED')),
  notes           varchar(500),
  owner_id        uuid REFERENCES users (user_id),
  lost_reason     varchar(120),
  converted_customer_id uuid,
  converted_at    timestamptz,
  created_by      uuid REFERENCES users (user_id),
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  -- A lead that is converted or lost keeps its customer link and reason.
  CONSTRAINT leads_converted_fields
    CHECK (status <> 'CONVERTED' OR (converted_customer_id IS NOT NULL AND converted_at IS NOT NULL)),
  CONSTRAINT leads_lost_needs_reason CHECK (status <> 'LOST' OR lost_reason IS NOT NULL)
);

-- Satu prospek aktif per nomor; nomor yang sudah LOST boleh didekati lagi.
CREATE UNIQUE INDEX leads_active_phone_uidx ON leads (phone_hash)
  WHERE status NOT IN ('CONVERTED', 'LOST', 'EXPIRED');
CREATE INDEX leads_branch_idx    ON leads (branch_id, created_at DESC);
CREATE INDEX leads_area_idx      ON leads (area_id, created_at DESC);
CREATE INDEX leads_status_idx    ON leads (status, created_at DESC);
CREATE INDEX leads_reference_idx ON leads (reference_id, created_at DESC);
CREATE TRIGGER leads_touch BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- advertising_budgets — biaya akuisisi per area × kanal × bulan
-- ---------------------------------------------------------------------
CREATE TABLE advertising_budgets (
  budget_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id      uuid NOT NULL REFERENCES areas (area_id),
  reference_id uuid NOT NULL REFERENCES acquisition_references (reference_id),
  -- always the first day of the month, so a period is unambiguous
  period_month date NOT NULL CHECK (date_trunc('month', period_month) = period_month),
  spend_amount numeric(16,2) NOT NULL CHECK (spend_amount >= 0),
  notes        varchar(300),
  created_by   uuid REFERENCES users (user_id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (area_id, reference_id, period_month)
);
CREATE INDEX budgets_period_idx ON advertising_budgets (period_month DESC);
CREATE TRIGGER budgets_touch BEFORE UPDATE ON advertising_budgets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- Tautan balik: nasabah tahu dari lead & kanal mana ia datang
-- ---------------------------------------------------------------------
ALTER TABLE leads ADD CONSTRAINT leads_converted_customer_fk
  FOREIGN KEY (converted_customer_id) REFERENCES customers (customer_id);

ALTER TABLE customers
  ADD COLUMN lead_id                  uuid REFERENCES leads (lead_id),
  ADD COLUMN acquisition_reference_id uuid REFERENCES acquisition_references (reference_id);
CREATE INDEX customers_lead_idx ON customers (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX customers_acquisition_idx ON customers (acquisition_reference_id)
  WHERE acquisition_reference_id IS NOT NULL;
