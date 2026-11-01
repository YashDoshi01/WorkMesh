-- Phase 5: durable workflows (DAGs of dependent jobs).
--
-- A workflow is a definition (nodes + edges) plus runtime state. A node has NO job until all of
-- its dependencies have succeeded; only then is its job created (with the id reserved below).
-- So "a job never starts before its dependencies succeed" holds structurally: the job that
-- would run it does not exist yet. The claim query is untouched.
--
-- Job state stays the single source of truth. A node's effective state and a workflow's
-- progress are DERIVED from jobs.status (no mirrored counters that could drift).

CREATE TABLE workflows (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text        NOT NULL DEFAULT '' CHECK (length(name) <= 200),
  status              text        NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  -- Set by POST /workflows/:id/cancel. The status becomes 'cancelled' only once nothing is
  -- still executing: running jobs cannot be stopped safely, so we wait for them.
  cancel_requested_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  CHECK ((status = 'running') = (finished_at IS NULL))
);

CREATE INDEX workflows_status_created_idx ON workflows (status, created_at DESC);

CREATE TABLE workflow_nodes (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid    NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  key          text    NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,49}$'),
  job_type     text    NOT NULL CHECK (job_type ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  payload      jsonb   NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  priority     integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  -- waiting  : some dependency has not succeeded yet; no job exists
  -- released : the job exists (its state lives in jobs)
  -- skipped  : will never run, because a dependency failed/was cancelled/skipped or the
  --            workflow was cancelled
  status       text    NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'released', 'skipped')),
  -- The id the job will have when released. Reserving it at creation means releasing a node
  -- is a single INSERT, and a second release attempt collides on jobs' primary key.
  job_id       uuid    NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  UNIQUE (workflow_id, key)
);

CREATE TABLE workflow_edges (
  workflow_id        uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  node_id            uuid NOT NULL REFERENCES workflow_nodes (id) ON DELETE CASCADE,
  depends_on_node_id uuid NOT NULL REFERENCES workflow_nodes (id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, depends_on_node_id),
  CHECK (node_id <> depends_on_node_id)
);

-- Reconciling a workflow reads all of its nodes and edges.
CREATE INDEX workflow_nodes_workflow_idx ON workflow_nodes (workflow_id);
CREATE INDEX workflow_edges_workflow_idx ON workflow_edges (workflow_id);
CREATE INDEX workflow_edges_parent_idx ON workflow_edges (depends_on_node_id);

-- Jobs that belong to a workflow.
ALTER TABLE jobs ADD COLUMN workflow_id uuid REFERENCES workflows (id) ON DELETE SET NULL;
CREATE INDEX jobs_workflow_idx ON jobs (workflow_id) WHERE workflow_id IS NOT NULL;

-- New terminal job state: cancelled (a queued job withdrawn before any worker started it).
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'));

-- A cancelled job was never (or is no longer) owned by a worker.
ALTER TABLE jobs DROP CONSTRAINT jobs_claimed_has_owner;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_claimed_has_owner
  CHECK (status IN ('queued', 'cancelled') OR claimed_by IS NOT NULL);
