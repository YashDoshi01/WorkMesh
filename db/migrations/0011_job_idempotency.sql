-- Phase 11: idempotent job submission.
--
-- A client that does not get an answer to POST /jobs (timeout, lost response, instance killed)
-- cannot tell whether the job was created. Retrying could create a second job. With an
-- Idempotency-Key the retry returns the job that already exists instead.
--
--   idempotency_key : chosen by the client, unique PER ACCOUNT (two customers may use the same string)
--   request_hash    : SHA-256 of the request that created it. Reusing a key for a DIFFERENT request
--                     is a client bug, and is refused instead of silently returning the wrong job.
ALTER TABLE jobs
  ADD COLUMN idempotency_key text
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD COLUMN request_hash bytea
    CHECK (request_hash IS NULL OR length(request_hash) = 32),
  ADD CONSTRAINT jobs_idempotency_pair CHECK ((idempotency_key IS NULL) = (request_hash IS NULL));

-- Partial: only jobs submitted with a key are in it, so it adds nothing to the other writes. The
-- unique index (not application code) is what makes two simultaneous requests with the same key
-- safe: exactly one insert wins.
CREATE UNIQUE INDEX jobs_idempotency_uq ON jobs (account, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
