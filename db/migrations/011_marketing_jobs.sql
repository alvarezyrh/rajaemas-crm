-- =====================================================================
-- 011_marketing_jobs — durable job history and consent-based WhatsApp blasts
-- Google Places review content is deliberately not persisted; it is fetched on demand.
-- =====================================================================

CREATE TABLE job_runs (
  job_run_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name      varchar(64)  NOT NULL,
  status        varchar(12) NOT NULL DEFAULT 'RUNNING'
                CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
  attempt       integer     NOT NULL CHECK (attempt > 0),
  result        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error_message varchar(500),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX job_runs_name_started_idx ON job_runs (job_name, started_at DESC);
CREATE INDEX job_runs_status_started_idx ON job_runs (status, started_at DESC);

CREATE TABLE dynamic_blasts (
  blast_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar(120) NOT NULL,
  template_name     varchar(512) NOT NULL,
  language_code     varchar(16) NOT NULL DEFAULT 'id',
  personalize_name  boolean NOT NULL DEFAULT false,
  criteria          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            varchar(12) NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED')),
  scheduled_at      timestamptz,
  created_by        uuid REFERENCES users (user_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dynamic_blast_schedule_state
    CHECK (status <> 'SCHEDULED' OR scheduled_at IS NOT NULL)
);
CREATE INDEX dynamic_blasts_due_idx
  ON dynamic_blasts (scheduled_at, blast_id) WHERE status = 'SCHEDULED';
CREATE TRIGGER dynamic_blasts_touch BEFORE UPDATE ON dynamic_blasts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE blast_runs (
  blast_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blast_id     uuid NOT NULL REFERENCES dynamic_blasts (blast_id) ON DELETE CASCADE,
  status       varchar(12) NOT NULL DEFAULT 'RUNNING'
               CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  sent_count   integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  error_message varchar(500),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE UNIQUE INDEX blast_runs_one_active
  ON blast_runs (blast_id) WHERE status = 'RUNNING';
CREATE INDEX blast_runs_started_idx ON blast_runs (blast_id, started_at DESC);

CREATE TABLE blast_recipients (
  blast_recipient_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blast_id           uuid NOT NULL REFERENCES dynamic_blasts (blast_id) ON DELETE CASCADE,
  customer_id        uuid NOT NULL REFERENCES customers (customer_id),
  blast_run_id       uuid REFERENCES blast_runs (blast_run_id),
  status             varchar(12) NOT NULL DEFAULT 'QUEUED'
                     CHECK (status IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED')),
  provider_message_id varchar(160) UNIQUE,
  error_code         varchar(80),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  queued_at          timestamptz NOT NULL DEFAULT now(),
  sending_at         timestamptz,
  sent_at            timestamptz,
  delivered_at       timestamptz,
  read_at            timestamptz,
  UNIQUE (blast_id, customer_id)
);
CREATE INDEX blast_recipients_queue_idx
  ON blast_recipients (blast_id, status, queued_at);
CREATE INDEX blast_recipients_status_idx
  ON blast_recipients (blast_id, status);
