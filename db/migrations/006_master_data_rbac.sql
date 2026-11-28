-- =====================================================================
-- 006_master_data_rbac — Fondasi "Master Data & Access Control"
--   areas                 : induk wilayah (provinsi/kota) dari outlet
--   branches (outlets)    : diperluas dengan area, alamat, Google Place, zona waktu
--   acquisition_references: kanal asal lead (Instagram, Google Ads, Walk-in, …)
--   product_categories    : kategori katalog
--   products              : katalog emas/perhiasan, termasuk bullion LM REI
--   transaction_types     : jenis transaksi reguler vs buyback LM REI
--   cs_assignments        : penugasan Customer Service per outlet
--   users                 : 3 peran baru + lingkup area
-- Semua perubahan bersifat aditif: tidak ada rename, tidak ada data yang hilang.
-- =====================================================================

-- ---------------------------------------------------------------------
-- areas — wilayah yang membawahi beberapa outlet
-- ---------------------------------------------------------------------
CREATE TABLE areas (
  area_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_code   varchar(16)  NOT NULL UNIQUE,
  name        varchar(120) NOT NULL,
  province    varchar(80)  NOT NULL,
  city        varchar(80),
  region_code varchar(16),
  is_active   boolean      NOT NULL DEFAULT true,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX areas_province_idx ON areas (province);
CREATE TRIGGER areas_touch BEFORE UPDATE ON areas
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- branches = outlet pada dokumen arsitektur (nama tabel dipertahankan)
-- ---------------------------------------------------------------------
ALTER TABLE branches
  ADD COLUMN area_id         uuid REFERENCES areas (area_id),
  -- dipakai syncer Google Reviews; unik agar satu outlet tidak ganda
  ADD COLUMN google_place_id varchar(120),
  ADD COLUMN address         varchar(200),
  ADD COLUMN city            varchar(80),
  ADD COLUMN province        varchar(80),
  -- WIB/WITA/WIT per outlet (roadmap: zona waktu per cabang)
  ADD COLUMN timezone        varchar(32) NOT NULL DEFAULT 'Asia/Jakarta',
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX branches_google_place_uidx
  ON branches (google_place_id) WHERE google_place_id IS NOT NULL;
CREATE INDEX branches_area_idx ON branches (area_id);
CREATE TRIGGER branches_touch BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- acquisition_references — kanal akuisisi lead
-- ---------------------------------------------------------------------
CREATE TABLE acquisition_references (
  reference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         varchar(32)  NOT NULL UNIQUE,
  name         varchar(120) NOT NULL,
  channel_type varchar(24)  NOT NULL DEFAULT 'OTHER'
               CHECK (channel_type IN
                 ('DIGITAL_ADS', 'SOCIAL', 'SEARCH', 'WALK_IN', 'APP', 'REFERRAL', 'EVENT', 'OTHER')),
  is_active    boolean      NOT NULL DEFAULT true,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE TRIGGER references_touch BEFORE UPDATE ON acquisition_references
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- Katalog: category_of_products → products
-- ---------------------------------------------------------------------
CREATE TABLE product_categories (
  category_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        varchar(32)  NOT NULL UNIQUE,
  name        varchar(120) NOT NULL,
  is_active   boolean      NOT NULL DEFAULT true,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE TRIGGER product_categories_touch BEFORE UPDATE ON product_categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE products (
  product_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id      uuid REFERENCES product_categories (category_id),
  sku              varchar(64)  NOT NULL UNIQUE,
  name             varchar(160) NOT NULL,
  karat            numeric(4,2) CHECK (karat > 0 AND karat <= 24),
  base_weight_gram numeric(10,3) CHECK (base_weight_gram > 0),
  -- true = Logam Mulia (LM REI); dipakai Dashboard LM REI & buyback
  is_bullion       boolean      NOT NULL DEFAULT false,
  is_active        boolean      NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users (user_id),
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_active_idx   ON products (is_active, sku);
CREATE TRIGGER products_touch BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- transaction_types — reguler vs skema khusus LM REI Buyback
-- ---------------------------------------------------------------------
CREATE TABLE transaction_types (
  type_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               varchar(32)  NOT NULL UNIQUE,
  name               varchar(120) NOT NULL,
  side               varchar(4)   NOT NULL CHECK (side IN ('BUY', 'SELL')),
  is_bullion         boolean      NOT NULL DEFAULT false,
  requires_appraisal boolean      NOT NULL DEFAULT false,
  is_active          boolean      NOT NULL DEFAULT true,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now()
);
CREATE TRIGGER transaction_types_touch BEFORE UPDATE ON transaction_types
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- cs_assignments — penugasan CS per outlet (sumber CS Rating & Bonus Summary)
-- ---------------------------------------------------------------------
CREATE TABLE cs_assignments (
  assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (user_id),
  branch_id     uuid NOT NULL REFERENCES branches (branch_id),
  is_primary    boolean NOT NULL DEFAULT false,
  valid_from    date    NOT NULL DEFAULT current_date,
  valid_to      date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cs_assignments_window CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (user_id, branch_id, valid_from)
);
CREATE INDEX cs_assignments_branch_idx ON cs_assignments (branch_id, valid_from DESC);
CREATE INDEX cs_assignments_user_idx   ON cs_assignments (user_id);

-- ---------------------------------------------------------------------
-- users — peran baru (SUPER_ADMIN, AREA_MANAGER, DIGITAL_MARKETING) + area
-- APPRAISER dipertahankan: modul taksiran/buyback bergantung padanya.
-- ---------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN area_id   uuid REFERENCES areas (area_id),
  ADD COLUMN job_title varchar(80);
CREATE INDEX users_area_idx ON users (area_id);

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'SUPER_ADMIN', 'HQ_STAFF', 'AREA_MANAGER', 'BRANCH_HEAD',
  'CUSTOMER_SERVICE', 'DIGITAL_MARKETING', 'APPRAISER'));

-- Peran global tidak terikat satu outlet; Area Manager diikat oleh area_id.
ALTER TABLE users DROP CONSTRAINT users_hq_without_branch;
ALTER TABLE users ADD CONSTRAINT users_global_roles_without_branch
  CHECK (role NOT IN ('SUPER_ADMIN', 'HQ_STAFF', 'AREA_MANAGER') OR branch_id IS NULL);

ALTER TABLE users DROP CONSTRAINT users_branch_roles_need_branch;
ALTER TABLE users ADD CONSTRAINT users_outlet_roles_need_branch
  CHECK (role NOT IN ('BRANCH_HEAD', 'APPRAISER') OR branch_id IS NOT NULL);

ALTER TABLE users ADD CONSTRAINT users_area_manager_needs_area
  CHECK (role <> 'AREA_MANAGER' OR area_id IS NOT NULL);
