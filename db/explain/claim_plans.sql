-- Plans for the CURRENT claim query (JobLifecycle.claim). Run seed.sql first.
--   docker exec -i workmesh-postgres psql -U workmesh -d workmesh_test < db/explain/claim_plans.sql
\pset pager off
\set ON_ERROR_STOP on

\echo '=== A. worker for t.b only: its jobs rank LAST behind 200k t.a jobs'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
WITH picked AS (
  SELECT id AS pid FROM (
    SELECT c.id, c.claim_rank, c.run_at, c.created_at
    FROM (SELECT DISTINCT unnest(ARRAY['t.b']::text[]) AS type) AS wanted
    CROSS JOIN LATERAL (
      SELECT id, claim_rank, run_at, created_at FROM jobs
      WHERE status = 'queued' AND type = wanted.type AND run_at <= now()
      ORDER BY claim_rank DESC, run_at, created_at, id
      LIMIT 10 FOR UPDATE SKIP LOCKED
    ) AS c
  ) AS candidates
  ORDER BY claim_rank DESC, run_at, created_at, id
  LIMIT 10
)
SELECT pid FROM picked;
ROLLBACK;

\echo '=== B. worker for t.a only (the common case)'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
WITH picked AS (
  SELECT id AS pid FROM (
    SELECT c.id, c.claim_rank, c.run_at, c.created_at
    FROM (SELECT DISTINCT unnest(ARRAY['t.a']::text[]) AS type) AS wanted
    CROSS JOIN LATERAL (
      SELECT id, claim_rank, run_at, created_at FROM jobs
      WHERE status = 'queued' AND type = wanted.type AND run_at <= now()
      ORDER BY claim_rank DESC, run_at, created_at, id
      LIMIT 10 FOR UPDATE SKIP LOCKED
    ) AS c
  ) AS candidates
  ORDER BY claim_rank DESC, run_at, created_at, id
  LIMIT 10
)
SELECT pid FROM picked;
ROLLBACK;

\echo '=== C. worker handling 50 types (t.a, t.b and 48 others)'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
WITH picked AS (
  SELECT id AS pid FROM (
    SELECT c.id, c.claim_rank, c.run_at, c.created_at
    FROM (SELECT DISTINCT unnest((ARRAY['t.a','t.b'] || ARRAY(SELECT 'many.' || g FROM generate_series(0, 47) g))::text[]) AS type) AS wanted
    CROSS JOIN LATERAL (
      SELECT id, claim_rank, run_at, created_at FROM jobs
      WHERE status = 'queued' AND type = wanted.type AND run_at <= now()
      ORDER BY claim_rank DESC, run_at, created_at, id
      LIMIT 10 FOR UPDATE SKIP LOCKED
    ) AS c
  ) AS candidates
  ORDER BY claim_rank DESC, run_at, created_at, id
  LIMIT 10
)
SELECT pid FROM picked;
ROLLBACK;

\echo '=== D. scheduler due-query (20k schedules)'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM schedules WHERE enabled AND next_run_at <= now() + interval '5 minutes'
ORDER BY next_run_at LIMIT 100 FOR UPDATE SKIP LOCKED;
ROLLBACK;

\echo '=== E. reaper sweep query (320k jobs, none running)'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM jobs WHERE status = 'running' AND lease_expires_at < now()
ORDER BY lease_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED;
ROLLBACK;
