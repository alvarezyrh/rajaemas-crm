-- =====================================================================
-- 003_integrations — pull customer data from other applications' APIs
-- =====================================================================

-- ---------------------------------------------------------------------
-- integration_sources — one external API that returns a customer list
-- ---------------------------------------------------------------------
CREATE TABLE integration_sources (
  source_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 varchar(80)  NOT NULL UNIQUE,
  endpoint_url         varchar(500) NOT NULL,
  -- credentials: header name in clear, value encrypted (AES-256-GCM, never returned)
  auth_header          varchar(64),
  auth_token_encrypted text,
  -- cluster the imported customers join (NULL = import profiles only)
  channel              varchar(16)
                       CHECK (channel IN ('STORE', 'MOBILE_APP', 'ECOMMERCE')),
  -- where the array sits in the JSON response ('' = the response is the array)
  list_path            varchar(120) NOT NULL DEFAULT '',
  -- { fullName, phone, email, accountId } → dot paths inside each record
  field_map            jsonb        NOT NULL,
  pagination           varchar(8)   NOT NULL DEFAULT 'none'
                       CHECK (pagination IN ('none', 'page')),
  page_size            integer      NOT NULL DEFAULT 100 CHECK (page_size BETWEEN 1 AND 1000),
  is_active            boolean      NOT NULL DEFAULT true,
  created_by           uuid REFERENCES users (user_id),
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT integration_auth_pair
    CHECK ((auth_header IS NULL) = (auth_token_encrypted IS NULL))
);
CREATE TRIGGER integration_sources_touch BEFORE UPDATE ON integration_sources
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- integration_runs — history of every sync
-- ---------------------------------------------------------------------
CREATE TABLE integration_runs (
  run_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid         NOT NULL REFERENCES integration_sources (source_id) ON DELETE CASCADE,
  status        varchar(12)  NOT NULL DEFAULT 'RUNNING'
                CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  fetched       integer      NOT NULL DEFAULT 0,
  created       integer      NOT NULL DEFAULT 0,
  matched       integer      NOT NULL DEFAULT 0,
  skipped       integer      NOT NULL DEFAULT 0,
  error_message varchar(500),
  -- first few per-record problems: [{ index, reason }]
  errors        jsonb        NOT NULL DEFAULT '[]'::jsonb,
  started_by    uuid REFERENCES users (user_id),
  started_at    timestamptz  NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX integration_runs_source_idx ON integration_runs (source_id, started_at DESC);
-- at most one sync in flight per source
CREATE UNIQUE INDEX integration_runs_one_running ON integration_runs (source_id) WHERE status = 'RUNNING';
