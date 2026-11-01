-- Phase 3: attempt history, leases, retries.

-- Per-job retry budget. attempt_count (already present) counts claims, so a job
-- may be claimed at most max_attempts times.
ALTER TABLE jobs
  ADD COLUMN max_attempts     integer     NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN lease_expires_at timestamptz;

-- Jobs that were 'running' before leases existed get an already-expired lease,
-- so the recovery sweep can pick them up instead of leaving them stuck forever.
UPDATE jobs SET lease_expires_at = now() WHERE status = 'running';

-- Running means "leased": there must be a deadline after which the job can be recovered.
ALTER TABLE jobs
  ADD CONSTRAINT jobs_running_has_lease
  CHECK (status <> 'running' OR lease_expires_at IS NOT NULL);

-- Recovery sweep: find running jobs whose lease deadline has passed.
CREATE INDEX jobs_lease_expiry_idx ON jobs (lease_expires_at) WHERE status = 'running';

-- One row per execution attempt: an audit trail that survives retries.
-- (job_id, attempt_number) is the fencing identity used by every worker report.
CREATE TABLE job_attempts (
  id             bigserial   PRIMARY KEY,
  job_id         uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attempt_number integer     NOT NULL CHECK (attempt_number >= 1),
  worker_id      uuid        NOT NULL REFERENCES workers (id),
  outcome        text        NOT NULL DEFAULT 'running'
                 CHECK (outcome IN ('running', 'succeeded', 'failed', 'lease_expired')),
  error          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  UNIQUE (job_id, attempt_number)
);
