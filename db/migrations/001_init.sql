-- =====================================================================
-- 001_init — Skema inti CRM RajaEmas.id
-- PostgreSQL 14+ (gen_random_uuid bawaan; pg_trgm untuk pencarian nama)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigger umum: perbarui updated_at otomatis
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- branches — direktori gerai
-- ---------------------------------------------------------------------
CREATE TABLE branches (
  branch_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_code  varchar(16)  NOT NULL UNIQUE,
  name         varchar(120) NOT NULL,
  region       varchar(60)  NOT NULL,
  is_active    boolean      NOT NULL DEFAULT true,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- users — staf internal (pusat, kepala cabang, penaksir, layanan pelanggan)
-- ---------------------------------------------------------------------
CREATE TABLE users (
  user_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         varchar(160) NOT NULL UNIQUE CHECK (email = lower(email)),
  full_name     varchar(120) NOT NULL,
  role          varchar(32)  NOT NULL
                CHECK (role IN ('HQ_STAFF', 'BRANCH_HEAD', 'APPRAISER', 'CUSTOMER_SERVICE')),
  branch_id     uuid REFERENCES branches (branch_id),
  password_hash text         NOT NULL,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT users_hq_without_branch CHECK (role <> 'HQ_STAFF' OR branch_id IS NULL),
  CONSTRAINT users_branch_roles_need_branch
    CHECK (role NOT IN ('BRANCH_HEAD', 'APPRAISER') OR branch_id IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- customers — master profil nasabah (PII terenkripsi + blind index)
-- ---------------------------------------------------------------------
CREATE TABLE customers (
  customer_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         varchar(120) NOT NULL,
  phone_hash        char(64)     NOT NULL UNIQUE,
  phone_encrypted   text         NOT NULL,
  phone_last4       char(4)      NOT NULL,
  nik_hash          char(64) UNIQUE,
  nik_encrypted     text,
  email             varchar(160),
  tier_code         varchar(16)  NOT NULL DEFAULT 'REGULER'
                    CHECK (tier_code IN ('REGULER', 'SILVER', 'GOLD', 'PLATINUM')),
  loyalty_points    integer      NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  preferred_channel varchar(16)  NOT NULL DEFAULT 'WHATSAPP'
                    CHECK (preferred_channel IN ('WHATSAPP', 'PHONE', 'EMAIL', 'VISIT')),
  marketing_consent boolean      NOT NULL DEFAULT false,
  home_branch_id    uuid REFERENCES branches (branch_id),
  created_by        uuid REFERENCES users (user_id),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT customers_nik_pair CHECK ((nik_hash IS NULL) = (nik_encrypted IS NULL))
);
CREATE INDEX customers_home_branch_idx ON customers (home_branch_id);
CREATE INDEX customers_created_at_idx  ON customers (created_at DESC);
CREATE INDEX customers_name_trgm_idx   ON customers USING gin (full_name gin_trgm_ops);
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- customer_interactions — jejak komunikasi omnichannel
-- ---------------------------------------------------------------------
CREATE TABLE customer_interactions (
  interaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid         NOT NULL REFERENCES customers (customer_id),
  branch_id      uuid REFERENCES branches (branch_id),
  channel        varchar(16)  NOT NULL CHECK (channel IN ('WHATSAPP', 'PHONE', 'EMAIL', 'VISIT')),
  direction      varchar(8)   NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  summary        varchar(500) NOT NULL,
  external_ref   varchar(128) UNIQUE,  -- id pesan penyedia; menjamin idempotensi webhook
  handled_by     uuid REFERENCES users (user_id),
  occurred_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX interactions_customer_idx ON customer_interactions (customer_id, occurred_at DESC);
CREATE INDEX interactions_branch_idx   ON customer_interactions (branch_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- appraisal_records — taksiran & transaksi buyback
-- ---------------------------------------------------------------------
CREATE TABLE appraisal_records (
  appraisal_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid          NOT NULL REFERENCES customers (customer_id),
  branch_id        uuid          NOT NULL REFERENCES branches (branch_id),
  appraiser_id     uuid          NOT NULL REFERENCES users (user_id),
  item_description varchar(200)  NOT NULL,
  weight_gram      numeric(10,3) NOT NULL CHECK (weight_gram > 0),
  purity_karat     numeric(4,2)  NOT NULL CHECK (purity_karat > 0 AND purity_karat <= 24),
  offered_price    numeric(16,2) NOT NULL CHECK (offered_price >= 0),
  final_price      numeric(16,2) CHECK (final_price >= 0),
  status           varchar(16)   NOT NULL DEFAULT 'OFFERED'
                   CHECK (status IN ('OFFERED', 'ACCEPTED', 'REJECTED', 'SETTLED')),
  notes            varchar(500),
  settled_at       timestamptz,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT appraisal_settled_fields
    CHECK (status <> 'SETTLED' OR (final_price IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX appraisals_customer_idx ON appraisal_records (customer_id, created_at DESC);
CREATE INDEX appraisals_branch_idx   ON appraisal_records (branch_id, status, created_at DESC);
CREATE TRIGGER appraisals_touch BEFORE UPDATE ON appraisal_records
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- branch_appointments — reservasi kunjungan gerai
-- ---------------------------------------------------------------------
CREATE TABLE branch_appointments (
  appointment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid        NOT NULL REFERENCES customers (customer_id),
  branch_id      uuid        NOT NULL REFERENCES branches (branch_id),
  service_type   varchar(16) NOT NULL CHECK (service_type IN ('APPRAISAL', 'BUYBACK', 'CONSULTATION')),
  scheduled_at   timestamptz NOT NULL,
  status         varchar(16) NOT NULL DEFAULT 'SCHEDULED'
                 CHECK (status IN ('SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  notes          varchar(500),
  created_by     uuid REFERENCES users (user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointments_branch_time_idx ON branch_appointments (branch_id, scheduled_at);
CREATE INDEX appointments_customer_idx    ON branch_appointments (customer_id, scheduled_at DESC);
CREATE TRIGGER appointments_touch BEFORE UPDATE ON branch_appointments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- audit_logs — jejak audit permanen (append-only, dijaga trigger)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  audit_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     uuid,          -- sengaja tanpa FK: jejak audit harus bertahan
  action       varchar(64)  NOT NULL,
  entity_type  varchar(48)  NOT NULL,
  entity_id    varchar(64),
  payload_diff jsonb        NOT NULL DEFAULT '{}'::jsonb,
  request_id   varchar(128),
  ip_address   varchar(64),
  created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_actor_idx  ON audit_logs (actor_id, created_at DESC);

CREATE FUNCTION audit_logs_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs bersifat append-only';
END $$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();
