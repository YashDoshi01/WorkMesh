-- Phase 4: recurring schedules, original schedule time, priority with aging.

-- ---------------------------------------------------------------- schedules
CREATE TABLE schedules (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  cron         text        NOT NULL CHECK (length(cron) BETWEEN 9 AND 100),
  timezone     text        NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  job_type     text        NOT NULL CHECK (job_type ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  payload      jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  priority     integer     NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  max_attempts integer     NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  enabled      boolean     NOT NULL DEFAULT true,
  -- The next cron occurrence that has not been turned into a job yet.
  next_run_at  timestamptz NOT NULL,
  last_run_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The scheduler's only hot query: enabled schedules that are due, soonest first.
CREATE INDEX schedules_due_idx ON schedules (next_run_at) WHERE enabled;

-- ------------------------------------------------- original schedule time
-- run_at   = earliest time the job may run NOW (retries and recovery push it out).
-- scheduled_for = when the job was originally meant to run; never changes.
ALTER TABLE jobs
  ADD COLUMN scheduled_for timestamptz,
  ADD COLUMN schedule_id   uuid REFERENCES schedules (id) ON DELETE SET NULL;

UPDATE jobs SET scheduled_for = run_at;

ALTER TABLE jobs
  ALTER COLUMN scheduled_for SET NOT NULL,
  ALTER COLUMN scheduled_for SET DEFAULT now();

-- Backstop against duplicate occurrences: a schedule can have at most one job per
-- scheduled instant, whatever the application does. The scheduler also locks the
-- schedule row, so this index should never fire; it is there for the day a bug or a
-- manual statement tries.
CREATE UNIQUE INDEX jobs_schedule_occurrence_uq
  ON jobs (schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL;

-- ---------------------------------------------------------- priority + aging
-- Claim order is by claim_rank, highest first:
--     claim_rank = priority * 60  -  (seconds since the epoch at which the job became eligible)
-- Each priority point is worth 60 seconds of waiting. Because "now" cancels out of any
-- comparison between two waiting jobs, the rank never changes while a job waits, so it
-- can be stored and indexed, yet it behaves exactly like "priority + minutes waited".
-- Starvation bound: a priority-0 job outranks any job that becomes eligible 100 * 60 = 6000 s
-- (100 minutes) after it, even one with priority 100.
-- The constant 60 is baked in here (an index cannot depend on a runtime setting);
-- changing it needs a migration that rebuilds the column and index.
-- AT TIME ZONE 'UTC' makes the expression IMMUTABLE, which generated columns require.
ALTER TABLE jobs
  ADD COLUMN claim_rank numeric
  GENERATED ALWAYS AS (priority * 60 - extract(epoch FROM (run_at AT TIME ZONE 'UTC'))) STORED;

DROP INDEX jobs_claimable_idx;
-- type FIRST: a worker asks for specific job types, and the claim probes this index once
-- per type, each probe reading in rank order and stopping after LIMIT rows. With rank first
-- instead, a worker whose type ranks last had to read past every higher-ranked job of every
-- other type (measured: ~200k index entries, ~80 ms per claim; see docs/QUERY_PLANS.md).
CREATE INDEX jobs_claim_order_idx
  ON jobs (type, claim_rank DESC, run_at, created_at, id) WHERE status = 'queued';
