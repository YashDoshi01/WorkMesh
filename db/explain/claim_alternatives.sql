-- Plans for the REJECTED designs, on the same data. Run seed.sql first.
-- Index changes happen inside a transaction that is rolled back, so nothing persists.
--   docker exec -i workmesh-postgres psql -U workmesh -d workmesh_test < db/explain/claim_alternatives.sql
\pset pager off
\set ON_ERROR_STOP on

\echo '=== X1. Single scan, rank-first index (the earlier design), worker for t.b'
BEGIN;
DROP INDEX jobs_claim_order_idx;
CREATE INDEX tmp_rank_first ON jobs (claim_rank DESC, run_at, created_at, id) WHERE status = 'queued';
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM jobs
WHERE status = 'queued' AND run_at <= now() AND type = ANY(ARRAY['t.b'])
ORDER BY claim_rank DESC, run_at, created_at, id
LIMIT 10 FOR UPDATE SKIP LOCKED;
ROLLBACK;

\echo '=== X2. Same rank-first design, worker for t.a (its best case)'
BEGIN;
DROP INDEX jobs_claim_order_idx;
CREATE INDEX tmp_rank_first ON jobs (claim_rank DESC, run_at, created_at, id) WHERE status = 'queued';
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM jobs
WHERE status = 'queued' AND run_at <= now() AND type = ANY(ARRAY['t.a'])
ORDER BY claim_rank DESC, run_at, created_at, id
LIMIT 10 FOR UPDATE SKIP LOCKED;
ROLLBACK;

\echo '=== X3. Aging computed from now() at query time (not indexable), worker for t.a'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM jobs
WHERE status = 'queued' AND run_at <= now() AND type = ANY(ARRAY['t.a'])
ORDER BY priority + extract(epoch FROM (now() - run_at)) / 60 DESC, run_at, created_at, id
LIMIT 10 FOR UPDATE SKIP LOCKED;
ROLLBACK;

\echo '=== X4. No usable index at all (sort every waiting job), worker for t.a'
BEGIN;
SET LOCAL enable_indexscan = off;
SET LOCAL enable_bitmapscan = off;
SET LOCAL enable_indexonlyscan = off;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM jobs
WHERE status = 'queued' AND run_at <= now() AND type = ANY(ARRAY['t.a'])
ORDER BY claim_rank DESC, run_at, created_at, id
LIMIT 10 FOR UPDATE SKIP LOCKED;
ROLLBACK;
