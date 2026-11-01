-- Phase 8: machine-plane API keys (hashed, revocable) and per-account isolation.

-- ------------------------------------------------------------------ api_keys
-- A key looks like  wm_<prefix>_<secret>.  The PREFIX is a public lookup handle (it is shown in
-- lists and logs); the SECRET is 256 random bits and is never stored. We store only its SHA-256
-- digest. A fast hash is enough here because the secret is random and long (nothing to guess or
-- dictionary-attack), unlike a human password.
CREATE TABLE api_keys (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prefix       text        NOT NULL UNIQUE CHECK (prefix ~ '^[A-Za-z0-9]{8}$'),
  secret_hash  bytea       NOT NULL CHECK (length(secret_hash) = 32),
  -- client: submits and reads jobs/workflows/schedules.  worker: registers and claims, reports.
  kind         text        NOT NULL CHECK (kind IN ('client', 'worker')),
  -- Everything a key creates or can see belongs to this account (a label, not a login).
  account      text        NOT NULL CHECK (account ~ '^[a-z0-9][a-z0-9._-]{0,49}$'),
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- worker keys only: the job types it may handle (NULL = any type within its account).
  job_types    text[]      CHECK (job_types IS NULL OR cardinality(job_types) BETWEEN 1 AND 50),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text        NOT NULL,
  -- Optional expiry: a key stops working at this time without anyone revoking it.
  expires_at   timestamptz,
  revoked_at   timestamptz,
  revoked_by   text,
  last_used_at timestamptz,
  CHECK (kind = 'worker' OR job_types IS NULL),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX api_keys_account_idx ON api_keys (account, created_at DESC);

-- --------------------------------------------------------------- accounts
-- Existing rows belong to the 'default' account, so everything created before this phase is
-- still reachable by keys created in that account.
ALTER TABLE jobs      ADD COLUMN account text NOT NULL DEFAULT 'default'
  CHECK (account ~ '^[a-z0-9][a-z0-9._-]{0,49}$');
ALTER TABLE workflows ADD COLUMN account text NOT NULL DEFAULT 'default'
  CHECK (account ~ '^[a-z0-9][a-z0-9._-]{0,49}$');
ALTER TABLE schedules ADD COLUMN account text NOT NULL DEFAULT 'default'
  CHECK (account ~ '^[a-z0-9][a-z0-9._-]{0,49}$');
ALTER TABLE workers   ADD COLUMN account text NOT NULL DEFAULT 'default'
  CHECK (account ~ '^[a-z0-9][a-z0-9._-]{0,49}$');
-- Which key registered this worker. A worker id alone must not be enough to act as that worker.
ALTER TABLE workers   ADD COLUMN api_key_id uuid REFERENCES api_keys (id);

-- The request that enqueued a job, so a job in the logs can be traced to the HTTP request that
-- created it (and from there to the gateway's access log, which uses the same id).
ALTER TABLE jobs ADD COLUMN request_id text CHECK (request_id IS NULL OR length(request_id) <= 128);

-- A schedule name only has to be unique within its account: otherwise "that name is taken"
-- would tell one customer that another customer has a schedule with that name.
ALTER TABLE schedules DROP CONSTRAINT schedules_name_key;
CREATE UNIQUE INDEX schedules_account_name_uq ON schedules (account, name);

-- The claim probe now also filters on account. Putting account right after type keeps each probe
-- reading ONLY its own account's jobs of that type, in rank order, instead of skipping over other
-- accounts' rows.
DROP INDEX jobs_claim_order_idx;
CREATE INDEX jobs_claim_order_idx
  ON jobs (type, account, claim_rank DESC, run_at, created_at, id) WHERE status = 'queued';

-- Listing "my jobs" newest first.
CREATE INDEX jobs_account_created_idx ON jobs (account, created_at DESC, id DESC);
