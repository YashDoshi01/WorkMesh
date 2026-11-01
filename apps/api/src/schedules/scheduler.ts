import { logInfo, logWarn } from "@workmesh/shared";
import type { Db } from "../db/pool.js";
import { PeriodicTask } from "../util/periodic.js";
import { latestOccurrenceAtOrBefore, nextOccurrenceAfter } from "./cron.js";

export interface ScheduledRun {
  scheduleId: string;
  name: string;
  /** The cron instant this job stands for (jobs.scheduled_for). */
  occurrence: Date;
  /** The created job, or null if one already existed for this occurrence. */
  jobId: string | null;
  /** True if earlier occurrences were skipped (the scheduler was down or behind). */
  skippedEarlier: boolean;
}

interface DueRow {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  job_type: string;
  payload: Record<string, unknown>;
  priority: number;
  max_attempts: number;
  next_run_at: Date;
}

const BATCH_SIZE = 100;

/**
 * Turns due schedules into jobs.
 *
 * Each tick runs in ONE transaction:
 *   1. Pick due schedules `FOR UPDATE SKIP LOCKED`. Another scheduler loop (another API
 *      instance, or this one again) that reaches the same row simply skips it.
 *   2. For each: INSERT the job and advance `next_run_at` together. They commit or roll back
 *      as a unit, so a crash can never leave "job created but schedule not advanced"
 *      (which would create a duplicate next tick) or the reverse (a lost occurrence).
 *   3. The INSERT is also protected by a unique index on (schedule_id, scheduled_for),
 *      so even a bug in steps 1-2 cannot create two jobs for one occurrence.
 *
 * Missed runs: if the scheduler was down and several occurrences are overdue, only the LATEST
 * one becomes a job; earlier ones are skipped. A burst of 100 stale "daily report" jobs after
 * an outage helps nobody. (Skips are logged, never silent.)
 *
 * Clock: "now" is the DATABASE's now(), so API instances with skewed clocks agree.
 */
export class Scheduler {
  private readonly loop: PeriodicTask;

  constructor(
    private readonly db: Db,
    intervalMs: number,
  ) {
    this.loop = new PeriodicTask("scheduler_tick", () => this.runOnce(), intervalMs);
  }

  /**
   * One tick. `at` overrides "now" for deterministic tests of time boundaries; production
   * leaves it undefined and uses the database clock.
   */
  async runOnce(at?: Date): Promise<ScheduledRun[]> {
    const client = await this.db.connect();
    const runs: ScheduledRun[] = [];
    try {
      await client.query("BEGIN");
      const now = at ?? (await client.query<{ t: Date }>("SELECT now() AS t")).rows[0]!.t;
      const due = await client.query<DueRow>(
        `SELECT id, name, cron, timezone, job_type, payload, priority, max_attempts, next_run_at
         FROM schedules
         WHERE enabled AND next_run_at <= $1::timestamptz
         ORDER BY next_run_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, BATCH_SIZE],
      );
      for (const s of due.rows) {
        // latestOccurrenceAtOrBefore can in principle land before next_run_at (e.g. the
        // expression was edited by hand); never go backwards.
        const latest = latestOccurrenceAtOrBefore(s.cron, s.timezone, now);
        const occurrence = latest.getTime() >= s.next_run_at.getTime() ? latest : s.next_run_at;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO jobs
             (type, payload, priority, max_attempts, run_at, scheduled_for, schedule_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [
            s.job_type,
            JSON.stringify(s.payload),
            s.priority,
            s.max_attempts,
            now,
            occurrence,
            s.id,
          ],
        );
        await client.query(
          `UPDATE schedules SET next_run_at = $2, last_run_at = $3, updated_at = now()
           WHERE id = $1`,
          [s.id, nextOccurrenceAfter(s.cron, s.timezone, now), occurrence],
        );
        runs.push({
          scheduleId: s.id,
          name: s.name,
          occurrence,
          jobId: inserted.rows[0]?.id ?? null,
          skippedEarlier: occurrence.getTime() > s.next_run_at.getTime(),
        });
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    for (const r of runs) {
      const fields = {
        scheduleId: r.scheduleId,
        name: r.name,
        occurrence: r.occurrence.toISOString(),
        jobId: r.jobId,
      };
      if (r.skippedEarlier) logWarn("schedule_missed_occurrences_skipped", fields);
      if (r.jobId) logInfo("schedule_job_created", fields);
      else logWarn("schedule_occurrence_already_exists", fields);
    }
    return runs;
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
