-- Phase 1: durable job records.
-- Only the 'queued' status exists: no worker can claim jobs yet (Phase 2).
CREATE TABLE jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text        NOT NULL CHECK (type ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  payload       jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status        text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued')),
  priority      integer     NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempt_count integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Supports the newest-first keyset pagination used by GET /jobs.
CREATE INDEX jobs_created_at_id_idx ON jobs (created_at DESC, id DESC);
-- Supports the status / type filters combined with the same ordering.
CREATE INDEX jobs_status_created_at_id_idx ON jobs (status, created_at DESC, id DESC);
CREATE INDEX jobs_type_created_at_id_idx ON jobs (type, created_at DESC, id DESC);
