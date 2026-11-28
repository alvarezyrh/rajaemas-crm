-- =====================================================================
-- 012_api_gateway_targets — inbound API Gateway targets and custom datasets
-- =====================================================================

ALTER TABLE integration_sources
  ADD COLUMN target_type varchar(16) NOT NULL DEFAULT 'CUSTOMER'
    CHECK (target_type IN ('CUSTOMER', 'PRODUCT', 'LEAD', 'APPOINTMENT', 'TRANSACTION', 'DATASET')),
  ADD COLUMN dataset_name varchar(80),
  ADD CONSTRAINT integration_dataset_name_check
    CHECK ((target_type = 'DATASET') = (dataset_name IS NOT NULL));

ALTER TABLE branch_appointments
  ADD COLUMN integration_source_id uuid REFERENCES integration_sources (source_id) ON DELETE SET NULL,
  ADD COLUMN integration_external_key_hash char(64);
CREATE UNIQUE INDEX appointments_integration_external_uidx
  ON branch_appointments (integration_source_id, integration_external_key_hash)
  WHERE integration_source_id IS NOT NULL AND integration_external_key_hash IS NOT NULL;

ALTER TABLE gold_transactions
  ADD COLUMN integration_source_id uuid REFERENCES integration_sources (source_id) ON DELETE SET NULL,
  ADD COLUMN integration_external_key_hash char(64);
CREATE UNIQUE INDEX gold_transactions_integration_external_uidx
  ON gold_transactions (integration_source_id, integration_external_key_hash)
  WHERE integration_source_id IS NOT NULL AND integration_external_key_hash IS NOT NULL;

CREATE TABLE integration_dataset_records (
  record_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id          uuid NOT NULL REFERENCES integration_sources (source_id) ON DELETE CASCADE,
  external_key_hash  char(64) NOT NULL,
  payload_encrypted  text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_key_hash)
);
CREATE INDEX integration_dataset_records_source_idx
  ON integration_dataset_records (source_id, updated_at DESC);
CREATE TRIGGER integration_dataset_records_touch BEFORE UPDATE ON integration_dataset_records
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
