-- Phase 6: operator plane (dashboard): audit log, statistics indexes, manual retry.

-- ------------------------------------------------------------------ audit log
-- Every operator action is recorded IN THE SAME TRANSACTION as the action itself, so an
-- action cannot happen without its record, nor a record exist for an action that rolled back.
-- `actor` is a fingerprint of the API key used (never the key); `role` is what it was allowed to do.
CREATE TABLE audit_log (
  id          bigserial   PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('viewer', 'operator')),
  action      text        NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type text        NOT NULL CHECK (length(target_type) BETWEEN 1 AND 50),
  target_id   text        NOT NULL CHECK (length(target_id) BETWEEN 1 AND 100),
  details     jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  request_id  text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC, id DESC);

-- ------------------------------------------------------- statistics (GET /ops/stats)
-- Windowed counts and percentiles read the rows that finished/started inside the window, so
-- they need indexes on those columns (partial: unfinished rows are not in them).
CREATE INDEX jobs_finished_at_idx ON jobs (finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX job_attempts_started_at_idx ON job_attempts (started_at);
CREATE INDEX job_attempts_finished_at_idx ON job_attempts (finished_at) WHERE finished_at IS NOT NULL;

-- GET /ops/workers shows how many jobs each worker is running right now.
CREATE INDEX jobs_running_by_worker_idx ON jobs (claimed_by) WHERE status = 'running';

-- ------------------------------------------------------------------ manual retry
-- A manual retry grants a failed job more attempts WITHOUT resetting attempt_count (which is
-- the fencing token and the key of job_attempts). So the budget can exceed the 20 allowed at
-- submission: it is attempts already made plus the attempts granted.
ALTER TABLE jobs DROP CONSTRAINT jobs_max_attempts_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 1000);
