-- =====================================================================
-- 005_kyc_partner_api — KTP (identity) data on customers, and API clients
-- that let other company systems (APPS, STORE) pull customer data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Identity (KTP) data. NIK already exists (encrypted + blind index).
-- The street-level address is encrypted like NIK; city/province stay in
-- clear for regional reporting. Religion and marital status are not
-- stored on purpose (data minimisation).
-- ---------------------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN birth_place       varchar(80),
  ADD COLUMN birth_date        date CHECK (birth_date > DATE '1900-01-01'),
  ADD COLUMN gender            char(1) CHECK (gender IN ('M', 'F')),
  -- street, RT/RW, kelurahan, kecamatan (AES-256-GCM, context customers.address)
  ADD COLUMN address_encrypted text,
  ADD COLUMN city              varchar(80),
  ADD COLUMN province          varchar(80),
  ADD COLUMN postal_code       varchar(10),
  ADD COLUMN occupation        varchar(80),
  -- which system last supplied identity data (e.g. "API: Member App", "CSV import")
  ADD COLUMN kyc_source        varchar(80),
  ADD COLUMN kyc_updated_at    timestamptz;

-- incremental partner pulls: WHERE (updated_at, customer_id) > cursor
CREATE INDEX customers_updated_cursor_idx ON customers (updated_at, customer_id);
CREATE INDEX customers_city_idx ON customers (province, city);

-- partner-API syncs now also report customers whose empty fields were filled
ALTER TABLE integration_runs ADD COLUMN enriched integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------
-- api_clients — machine credentials for APPS / STORE (read access)
-- ---------------------------------------------------------------------
CREATE TABLE api_clients (
  client_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         varchar(80)  NOT NULL UNIQUE,
  -- shown in lists to tell keys apart; the full key is never stored
  key_prefix   varchar(24)  NOT NULL UNIQUE,
  -- SHA-256 of the full key (keys are 256-bit random, so a fast hash is enough)
  key_hash     char(64)     NOT NULL,
  scopes       text[]       NOT NULL
               CHECK (scopes <@ ARRAY['customers:read', 'customers:read:pii']::text[] AND cardinality(scopes) > 0),
  is_active    boolean      NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_by   uuid REFERENCES users (user_id),
  created_at   timestamptz  NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
