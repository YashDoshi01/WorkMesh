-- Phase 2: worker identity and job claiming.

CREATE TABLE workers (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  job_types         text[]      NOT NULL CHECK (cardinality(job_types) BETWEEN 1 AND 50),
  concurrency       integer     NOT NULL CHECK (concurrency BETWEEN 1 AND 100),
  registered_at     timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jobs
  ADD COLUMN claimed_by  uuid REFERENCES workers (id),
  ADD COLUMN started_at  timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN last_error  text;

-- New states, each with behaviour implemented in this phase.
-- There is no retry yet: 'failed' is terminal until Phase 3.
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed'));

-- Anything past 'queued' has been claimed by someone (kept after finishing, for audit).
ALTER TABLE jobs
  ADD CONSTRAINT jobs_claimed_has_owner
  CHECK (status = 'queued' OR claimed_by IS NOT NULL);

-- Claim query: oldest eligible queued job first. Partial index = only waiting jobs,
-- so it stays small however many finished jobs accumulate.
CREATE INDEX jobs_claimable_idx ON jobs (run_at, created_at, id) WHERE status = 'queued';
