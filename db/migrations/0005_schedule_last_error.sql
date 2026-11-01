-- Phase 4 fix: a schedule that cannot be turned into a job (hand-edited bad cron or time zone,
-- a rejected insert) used to abort the whole scheduler tick and block every schedule behind it.
-- The scheduler now isolates each schedule, disables the broken one and records why here.
ALTER TABLE schedules ADD COLUMN last_error text;
