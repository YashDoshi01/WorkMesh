-- Phase 10: customer accounts. People sign in with an email and password and belong to ONE
-- organisation (an "account", the same label the machine plane already uses) as an admin or a viewer.

-- ------------------------------------------------------------------- accounts
-- Until now an account was just a label stored on jobs, keys and so on. This table makes it a real
-- thing so an organisation has a display name and a slug that cannot be claimed twice.
CREATE TABLE accounts (
  slug       text        PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9._-]{0,49}$'),
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every account that already exists in some table becomes a row, so a new sign-up can never be
-- handed somebody else's data by choosing a name that is already in use.
INSERT INTO accounts (slug, name)
SELECT s, s FROM (
  SELECT account AS s FROM jobs
  UNION SELECT account FROM api_keys
  UNION SELECT account FROM workflows
  UNION SELECT account FROM schedules
  UNION SELECT account FROM workers
  UNION SELECT 'default'
) existing
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------- users
-- email is stored lower-cased (the application normalises it) and is unique across the system.
-- password_hash is  scrypt$N$r$p$salt$hash  (see portal/passwords.ts); the parameters travel with
-- the hash, so the cost can be raised later without invalidating existing passwords.
CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  password_hash text        NOT NULL,
  account       text        NOT NULL REFERENCES accounts (slug),
  role          text        NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  -- Lockout after repeated wrong passwords (see portal/store.ts).
  failed_logins integer     NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  disabled_at   timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (email);
CREATE INDEX users_account_idx ON users (account);

-- ------------------------------------------------------------------- sessions
-- A session is a random 256-bit token held in an HttpOnly cookie. Only its SHA-256 is stored, so
-- a database leak does not hand out logged-in sessions.
CREATE TABLE sessions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   bytea       NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text        CHECK (ip IS NULL OR length(ip) <= 64),
  user_agent   text        CHECK (user_agent IS NULL OR length(user_agent) <= 200),
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ------------------------------------------------------------------- invites
-- No email service exists, so an admin gets a one-time link to hand over. Only the token's
-- SHA-256 is stored.
CREATE TABLE invites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  bytea       NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  account     text        NOT NULL REFERENCES accounts (slug),
  email       text        NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  role        text        NOT NULL CHECK (role IN ('admin', 'viewer')),
  invited_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz
);
-- At most one open invitation per person per organisation.
CREATE UNIQUE INDEX invites_open_uq ON invites (account, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- --------------------------------------------------------------------- audit
-- Customers see their own organisation's audit trail; users appear with the role they acted as.
ALTER TABLE audit_log ADD COLUMN account text;
ALTER TABLE audit_log DROP CONSTRAINT audit_log_role_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_role_check CHECK (role IN ('viewer', 'operator', 'admin'));
CREATE INDEX audit_log_account_idx ON audit_log (account, id DESC) WHERE account IS NOT NULL;
