-- Seeds a realistic-sized table for query-plan work. DESTRUCTIVE: truncates jobs, workers and
-- schedules, so it refuses to run anywhere except the workmesh_test database.
--   docker exec -i workmesh-postgres psql -U workmesh -d workmesh_test < db/explain/seed.sql
SELECT current_database() = 'workmesh_test' AS safe \gset
\if :safe
\else
  \echo 'refusing to run: connect to workmesh_test'
  \quit
\endif
\set ON_ERROR_STOP on
TRUNCATE jobs, workers, schedules CASCADE;
INSERT INTO workers (name, job_types, concurrency) VALUES ('w', ARRAY['t.a'], 1);

-- 200k waiting jobs of type t.a that rank HIGH (priority 50-100, waiting 12-24 h)
INSERT INTO jobs (type, payload, priority, run_at, scheduled_for)
SELECT 't.a', '{}', 50 + floor(random() * 51)::int,
       now() - interval '12 hours' - random() * interval '12 hours', now()
FROM generate_series(1, 200000);

-- 2,000 waiting jobs of type t.b that rank LOW (priority 0, eligible within the last minute)
INSERT INTO jobs (type, payload, priority, run_at, scheduled_for)
SELECT 't.b', '{}', 0, now() - random() * interval '1 minute', now()
FROM generate_series(1, 2000);

-- 20k waiting jobs spread over 48 more types
INSERT INTO jobs (type, payload, priority, run_at, scheduled_for)
SELECT 'many.' || (g % 48), '{}', floor(random() * 101)::int, now() - random() * interval '3 hours', now()
FROM generate_series(1, 20000) g;

-- 100k finished jobs: history must not slow the hot path
INSERT INTO jobs (type, payload, priority, status, claimed_by, finished_at)
SELECT 't.a', '{}', floor(random() * 101)::int, 'succeeded', (SELECT id FROM workers LIMIT 1), now()
FROM generate_series(1, 100000);

-- 20k schedules (1 in 10 disabled)
INSERT INTO schedules (name, cron, job_type, next_run_at, enabled)
SELECT 's' || g, '*/5 * * * *', 't.a', now() + (g || ' minutes')::interval, (g % 10 <> 0)
FROM generate_series(1, 20000) g;

ANALYZE jobs;
ANALYZE schedules;
SELECT status, count(*) FROM jobs GROUP BY status ORDER BY status;
