import type { Db } from "../db/pool.js";
import { nextOccurrenceAfter } from "./cron.js";
import type { CreateScheduleInput } from "./schema.js";

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  jobType: string;
  payload: Record<string, unknown>;
  priority: number;
  maxAttempts: number;
  enabled: boolean;
  /** Why the scheduler disabled this schedule, if it did. Cleared when re-enabled. */
  lastError: string | null;
  /** The next occurrence that has not been turned into a job yet. */
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  job_type: string;
  payload: Record<string, unknown>;
  priority: number;
  max_attempts: number;
  enabled: boolean;
  last_error: string | null;
  next_run_at: Date;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  "id, name, cron, timezone, job_type, payload, priority, max_attempts, enabled, last_error, next_run_at, last_run_at, created_at, updated_at";

function toSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    name: r.name,
    cron: r.cron,
    timezone: r.timezone,
    jobType: r.job_type,
    payload: r.payload,
    priority: r.priority,
    maxAttempts: r.max_attempts,
    enabled: r.enabled,
    lastError: r.last_error,
    nextRunAt: r.next_run_at.toISOString(),
    lastRunAt: r.last_run_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export class ScheduleNameTakenError extends Error {}

export class ScheduleRepository {
  constructor(private readonly db: Db) {}

  /** The database clock is the single time source for scheduling decisions. */
  private async dbNow(): Promise<Date> {
    const r = await this.db.query<{ t: Date }>("SELECT now() AS t");
    return r.rows[0]!.t;
  }

  async create(input: CreateScheduleInput): Promise<Schedule> {
    const next = nextOccurrenceAfter(input.cron, input.timezone, await this.dbNow());
    try {
      const r = await this.db.query<ScheduleRow>(
        `INSERT INTO schedules
           (name, cron, timezone, job_type, payload, priority, max_attempts, enabled, next_run_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${COLUMNS}`,
        [
          input.name,
          input.cron.trim(),
          input.timezone,
          input.jobType,
          JSON.stringify(input.payload),
          input.priority,
          input.maxAttempts,
          input.enabled,
          next,
        ],
      );
      return toSchedule(r.rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ScheduleNameTakenError();
      throw err;
    }
  }

  async findById(id: string): Promise<Schedule | null> {
    const r = await this.db.query<ScheduleRow>(`SELECT ${COLUMNS} FROM schedules WHERE id = $1`, [
      id,
    ]);
    return r.rows[0] ? toSchedule(r.rows[0]) : null;
  }

  async list(limit: number): Promise<Schedule[]> {
    const r = await this.db.query<ScheduleRow>(
      `SELECT ${COLUMNS} FROM schedules ORDER BY name LIMIT $1`,
      [limit],
    );
    return r.rows.map(toSchedule);
  }

  /**
   * Enabling recomputes next_run_at from NOW, so a schedule that was off for a week does not
   * fire a catch-up run the moment it is switched back on. (Downtime of the SCHEDULER is
   * different: that does catch up, once. See Scheduler.)
   */
  async setEnabled(id: string, enabled: boolean): Promise<Schedule | null> {
    const current = await this.findById(id);
    if (!current) return null;
    const next = enabled
      ? nextOccurrenceAfter(current.cron, current.timezone, await this.dbNow())
      : new Date(current.nextRunAt);
    const r = await this.db.query<ScheduleRow>(
      `UPDATE schedules SET enabled = $2, next_run_at = $3, last_error = NULL, updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, enabled, next],
    );
    return r.rows[0] ? toSchedule(r.rows[0]) : null;
  }

  /** Jobs it already created are kept (their schedule_id becomes NULL). */
  async delete(id: string): Promise<boolean> {
    const r = await this.db.query("DELETE FROM schedules WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  }
}
