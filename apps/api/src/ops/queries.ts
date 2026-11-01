import type { Db } from "../db/pool.js";

/** A worker whose last heartbeat is older than this is shown as stale. */
export const WORKER_STALE_AFTER_MS = 30_000;
/** Workers silent for longer than this are not listed at all (rows are never pruned). */
export const WORKER_LIST_HORIZON_HOURS = 24;

export interface WorkerHealth {
  id: string;
  name: string;
  jobTypes: string[];
  concurrency: number;
  registeredAt: string;
  lastHeartbeatAt: string;
  lastHeartbeatAgeSeconds: number;
  health: "alive" | "stale";
  /** Jobs this worker currently holds. */
  runningJobs: number;
}

export interface Distribution {
  p50: number;
  p95: number;
  max: number;
}

export interface Stats {
  generatedAt: string;
  windowMinutes: number;
  /** Size of one chart bucket. */
  bucketMinutes: number;
  /** Right now. */
  queue: {
    /** Waiting to run (ready now plus scheduled for later). */
    queued: number;
    /** Eligible this instant. */
    ready: number;
    scheduled: number;
    running: number;
    /** How long the longest-waiting ready job has been waiting; null if none is ready. */
    oldestReadyAgeSeconds: number | null;
  };
  /** Over the last `windowMinutes`. */
  window: {
    succeeded: number;
    failed: number;
    cancelled: number;
    /** Attempts beyond the first that started in the window. */
    retries: number;
    leaseExpirations: number;
    /** Succeeded jobs per minute, averaged over the window. */
    throughputPerMinute: number;
    /** How long successful attempts ran. null if none finished. */
    executionSeconds: Distribution | null;
    /** From the time a job was meant to run until a worker started it (first attempts). null if none. */
    waitSeconds: Distribution | null;
  };
  series: { start: string; succeeded: number; failed: number }[];
  workers: { alive: number; stale: number };
}

interface DistRow {
  p50: number | null;
  p95: number | null;
  max: number | null;
}

const dist = (r: DistRow | undefined): Distribution | null =>
  r && r.p50 !== null && r.p95 !== null && r.max !== null
    ? { p50: r.p50, p95: r.p95, max: r.max }
    : null;

/**
 * Read-only queries behind the dashboard. Every number is computed from the real tables on
 * request; nothing is cached or estimated. Each query is bounded by an index (see the
 * migration) or by the number of CURRENTLY queued/running rows.
 */
export class OpsQueries {
  constructor(private readonly db: Db) {}

  /** `account` limits it to one customer organisation; omit for everything (operator tooling). */
  async workers(limit: number, account?: string): Promise<WorkerHealth[]> {
    const result = await this.db.query<{
      id: string;
      name: string;
      job_types: string[];
      concurrency: number;
      registered_at: Date;
      last_heartbeat_at: Date;
      age_seconds: number;
      running: number;
    }>(
      `SELECT w.id, w.name, w.job_types, w.concurrency, w.registered_at, w.last_heartbeat_at,
              extract(epoch FROM (now() - w.last_heartbeat_at))::float8 AS age_seconds,
              (SELECT count(*) FROM jobs j WHERE j.claimed_by = w.id AND j.status = 'running')::int AS running
       FROM workers w
       WHERE w.last_heartbeat_at > now() - make_interval(hours => $2)
         AND ($3::text IS NULL OR w.account = $3)
       ORDER BY w.last_heartbeat_at DESC, w.id
       LIMIT $1`,
      [limit, WORKER_LIST_HORIZON_HOURS, account ?? null],
    );
    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      jobTypes: r.job_types,
      concurrency: r.concurrency,
      registeredAt: r.registered_at.toISOString(),
      lastHeartbeatAt: r.last_heartbeat_at.toISOString(),
      lastHeartbeatAgeSeconds: Math.max(0, r.age_seconds),
      health: r.age_seconds * 1000 <= WORKER_STALE_AFTER_MS ? "alive" : "stale",
      runningJobs: r.running,
    }));
  }

  async stats(windowMinutes: number, account?: string): Promise<Stats> {
    // For one organisation, attempts are joined to their job to filter by account. The global
    // (operator) path keeps the original unjoined SQL, so its cost is unchanged.
    const scoped = account !== undefined;
    const attemptsFrom = scoped
      ? "job_attempts a JOIN jobs aj ON aj.id = a.job_id"
      : "job_attempts a";
    const attemptsWho = scoped ? "AND aj.account = $2" : "";
    const acc: unknown[] = scoped ? [account] : [];
    // Roughly 60 buckets however long the window is.
    const bucketMinutes = Math.max(1, Math.ceil(windowMinutes / 60));
    const [queue, windowCounts, retries, exec, wait, series, workers, now] = await Promise.all([
      this.db.query<{
        queued: number;
        ready: number;
        running: number;
        oldest: number | null;
      }>(
        `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
                count(*) FILTER (WHERE status = 'queued' AND run_at <= now())::int AS ready,
                count(*) FILTER (WHERE status = 'running')::int AS running,
                extract(epoch FROM (now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now())))::float8 AS oldest
         FROM jobs WHERE status IN ('queued', 'running') ${scoped ? "AND account = $1" : ""}`,
        acc,
      ),
      this.db.query<{ succeeded: number; failed: number; cancelled: number }>(
        `SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM jobs WHERE finished_at >= now() - make_interval(mins => $1) ${scoped ? "AND account = $2" : ""}`,
        [windowMinutes, ...acc],
      ),
      this.db.query<{ retries: number; expirations: number }>(
        `SELECT (SELECT count(*) FROM ${attemptsFrom}
                  WHERE a.attempt_number > 1 AND a.started_at >= now() - make_interval(mins => $1) ${attemptsWho})::int AS retries,
                (SELECT count(*) FROM ${attemptsFrom}
                  WHERE a.outcome = 'lease_expired' AND a.finished_at >= now() - make_interval(mins => $1) ${attemptsWho})::int AS expirations`,
        [windowMinutes, ...acc],
      ),
      this.db.query<DistRow>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY secs) AS p95,
                max(secs) AS max
         FROM (SELECT extract(epoch FROM (a.finished_at - a.started_at))::float8 AS secs
               FROM ${attemptsFrom}
               WHERE a.outcome = 'succeeded' AND a.finished_at >= now() - make_interval(mins => $1) ${attemptsWho}) t`,
        [windowMinutes, ...acc],
      ),
      this.db.query<DistRow>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY secs) AS p95,
                max(secs) AS max
         FROM (SELECT greatest(0, extract(epoch FROM (a.started_at - j.scheduled_for)))::float8 AS secs
               FROM job_attempts a JOIN jobs j ON j.id = a.job_id
               WHERE a.attempt_number = 1 AND a.started_at >= now() - make_interval(mins => $1) ${scoped ? "AND j.account = $2" : ""}) t`,
        [windowMinutes, ...acc],
      ),
      this.db.query<{ bucket: Date; succeeded: number; failed: number }>(
        `SELECT date_bin(make_interval(mins => $2), finished_at, 'epoch'::timestamptz) AS bucket,
                count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM jobs
         WHERE finished_at >= now() - make_interval(mins => $1) AND status IN ('succeeded', 'failed')
           ${scoped ? "AND account = $3" : ""}
         GROUP BY 1 ORDER BY 1`,
        [windowMinutes, bucketMinutes, ...acc],
      ),
      this.db.query<{ alive: number; stale: number }>(
        `SELECT count(*) FILTER (WHERE last_heartbeat_at > now() - make_interval(secs => $1))::int AS alive,
                count(*) FILTER (WHERE last_heartbeat_at <= now() - make_interval(secs => $1))::int AS stale
         FROM workers WHERE last_heartbeat_at > now() - make_interval(hours => $2) ${scoped ? "AND account = $3" : ""}`,
        [WORKER_STALE_AFTER_MS / 1000, WORKER_LIST_HORIZON_HOURS, ...acc],
      ),
      this.db.query<{ t: Date }>(`SELECT now() AS t`),
    ]);

    const q = queue.rows[0]!;
    const w = windowCounts.rows[0]!;
    const generatedAt = now.rows[0]!.t;

    // Fill empty buckets with zeros so a chart shows quiet periods as quiet, not as gaps. Buckets
    // are aligned to the epoch, so the first one starts at or before the window start and no row
    // inside the window can fall outside the series.
    const byStart = new Map(series.rows.map((r) => [r.bucket.getTime(), r] as const));
    const bucketMs = bucketMinutes * 60_000;
    const windowStartMs = generatedAt.getTime() - windowMinutes * 60_000;
    const firstStart = Math.floor(windowStartMs / bucketMs) * bucketMs;
    const lastStart = Math.floor(generatedAt.getTime() / bucketMs) * bucketMs;
    const buckets: Stats["series"] = [];
    for (let start = firstStart; start <= lastStart; start += bucketMs) {
      const row = byStart.get(start);
      buckets.push({
        start: new Date(start).toISOString(),
        succeeded: row?.succeeded ?? 0,
        failed: row?.failed ?? 0,
      });
    }

    return {
      generatedAt: generatedAt.toISOString(),
      windowMinutes,
      bucketMinutes,
      queue: {
        queued: q.queued,
        ready: q.ready,
        scheduled: q.queued - q.ready,
        running: q.running,
        oldestReadyAgeSeconds: q.oldest,
      },
      window: {
        succeeded: w.succeeded,
        failed: w.failed,
        cancelled: w.cancelled,
        retries: retries.rows[0]!.retries,
        leaseExpirations: retries.rows[0]!.expirations,
        throughputPerMinute: w.succeeded / windowMinutes,
        executionSeconds: dist(exec.rows[0]),
        waitSeconds: dist(wait.rows[0]),
      },
      series: buckets,
      workers: workers.rows[0]!,
    };
  }
}
