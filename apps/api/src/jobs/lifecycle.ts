import type { Db } from "../db/pool.js";
import { withTransaction, type Tx } from "../db/tx.js";
import { logReconcile, reconcileWorkflow } from "../workflows/reconcile.js";
import { COLUMNS, toJob, type FinishResult, type Job, type JobRow } from "./repository.js";

export interface LifecycleConfig {
  /** How long a claim (or a renewal) keeps a job owned. */
  leaseMs: number;
  /** First retry delay; doubles each attempt. */
  retryBaseMs: number;
  /** Upper bound for the retry delay. */
  retryMaxMs: number;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  leaseMs: 30_000,
  retryBaseMs: 1000,
  retryMaxMs: 300_000,
};

export interface JobAttempt {
  attemptNumber: number;
  workerId: string;
  outcome: "running" | "succeeded" | "failed" | "lease_expired";
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * Exponential backoff with a cap and "equal jitter", evaluated in SQL so the
 * delay is computed from the very attempt_count the UPDATE is acting on.
 *   ceiling = min(cap, base * 2^(attempt-1));  delay = ceiling * uniform(0.5, 1)
 * Jitter spreads retries out so many jobs that failed together do not all
 * come back at the same instant (a retry storm).
 */
function backoffInterval(base: string, cap: string): string {
  return `(LEAST(${cap}::double precision, ${base}::double precision * power(2, attempt_count - 1))
           * (0.5 + random() * 0.5)) * interval '1 millisecond'`;
}

/**
 * Everything that moves a job through running -> succeeded / queued (retry) / failed.
 *
 * Every transition is ONE SQL statement, so it is atomic, and is guarded by
 * `status = 'running' AND claimed_by = worker AND attempt_count = attempt`.
 * The attempt number is a fencing token: it increases on every claim, so a
 * report from an older attempt can never touch the state of a newer one.
 */
export class JobLifecycle {
  constructor(
    private readonly db: Db,
    readonly config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
  ) {}

  /**
   * Runs a job-state change and, in the SAME transaction, reconciles every workflow the changed
   * jobs belong to (release newly unblocked nodes, skip doomed ones, withdraw queued jobs of a
   * cancelled workflow, finish the workflow). Doing both in one transaction is what makes
   * workflow progress durable: a crash can never leave "job finished but its children not
   * released". Workflows are reconciled in id order so two transactions touching the same
   * workflows lock them in the same order and cannot deadlock.
   */
  private async changeAndReconcile(change: (tx: Tx) => Promise<JobRow[]>): Promise<JobRow[]> {
    const { rows, summaries } = await withTransaction(this.db, async (tx) => {
      const changed = await change(tx);
      const workflowIds = [
        ...new Set(changed.map((r) => r.workflow_id).filter((id): id is string => id !== null)),
      ].sort();
      const summaries = [];
      for (const id of workflowIds) summaries.push(await reconcileWorkflow(tx, id));
      if (workflowIds.length === 0) return { rows: changed, summaries };
      // Reconciling can change the very jobs we just changed (a job queued for retry in a
      // cancelled workflow is cancelled). Re-read them so the caller reports what is true now,
      // not the intermediate state.
      const fresh = await tx.query<JobRow>(
        `SELECT ${COLUMNS} FROM jobs WHERE id = ANY($1::uuid[])`,
        [changed.map((r) => r.id)],
      );
      const byId = new Map(fresh.rows.map((r) => [r.id, r] as const));
      return { rows: changed.map((r) => byId.get(r.id) ?? r), summaries };
    });
    summaries.forEach(logReconcile);
    return rows;
  }

  /**
   * Atomically hands up to `limit` eligible jobs to one worker, best rank first
   * (priority with aging, then FIFO; see migration 0004 for the rank formula).
   *
   * For each type the worker handles, a LATERAL probe reads that type's best `limit` rows
   * from jobs_claim_order_idx (type, claim_rank DESC, ...), locking them `FOR UPDATE SKIP
   * LOCKED` so concurrent claimers get different rows. The probes' candidates are merged
   * and the best `limit` overall win. Cost is O(types x limit), independent of how many
   * jobs of OTHER types are waiting. Candidates that lose the merge stay locked only until
   * this statement ends, which briefly hides them from concurrent claimers: harmless, but
   * the reason a worker with very many types is not free.
   * The UPDATE flips the winners to `running`, bumps the attempt number and sets the lease
   * deadline; the INSERT records the attempt. All in one statement.
   */
  async claim(workerId: string, jobTypes: string[], limit: number): Promise<Job[]> {
    const result = await this.db.query<JobRow>(
      `WITH picked AS (
         SELECT id AS pid FROM (
           SELECT c.id, c.claim_rank, c.run_at, c.created_at
           FROM (SELECT DISTINCT unnest($1::text[]) AS type) AS wanted
           CROSS JOIN LATERAL (
             SELECT id, claim_rank, run_at, created_at FROM jobs
             WHERE status = 'queued' AND type = wanted.type AND run_at <= now()
             ORDER BY claim_rank DESC, run_at, created_at, id
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           ) AS c
         ) AS candidates
         ORDER BY claim_rank DESC, run_at, created_at, id
         LIMIT $2
       ),
       claimed AS (
         UPDATE jobs
         SET status = 'running', claimed_by = $3::uuid, started_at = now(),
             attempt_count = attempt_count + 1,
             lease_expires_at = now() + ($4::int * interval '1 millisecond'),
             updated_at = now()
         FROM picked
         WHERE jobs.id = picked.pid
         RETURNING ${COLUMNS}
       ),
       recorded AS (
         INSERT INTO job_attempts (job_id, attempt_number, worker_id)
         SELECT id, attempt_count, $3::uuid FROM claimed
       )
       SELECT ${COLUMNS} FROM claimed`,
      [jobTypes, limit, workerId, this.config.leaseMs],
    );
    // Row order from a CTE is unspecified; present the jobs in claim order.
    const rank = (row: JobRow): number => row.priority * 60 - row.run_at.getTime() / 1000;
    return result.rows
      .slice()
      .sort(
        (a, b) =>
          rank(b) - rank(a) ||
          a.run_at.getTime() - b.run_at.getTime() ||
          a.created_at.getTime() - b.created_at.getTime() ||
          a.id.localeCompare(b.id),
      )
      .map(toJob);
  }

  /** Extends the lease, but only for the worker and attempt that currently own the job. */
  async renewLease(id: string, workerId: string, attempt: number): Promise<FinishResult> {
    // Deliberately allowed even if the deadline has just passed: until the recovery
    // sweep actually takes the job back, a live owner may keep it. The sweep and this
    // UPDATE both lock the row, so exactly one of them wins.
    const result = await this.db.query<JobRow>(
      `UPDATE jobs
       SET lease_expires_at = now() + ($4::int * interval '1 millisecond')
       WHERE id = $1 AND status = 'running' AND claimed_by = $2 AND attempt_count = $3
       RETURNING ${COLUMNS}`,
      [id, workerId, attempt, this.config.leaseMs],
    );
    const row = result.rows[0];
    return row ? { outcome: "ok", job: toJob(row) } : this.notOwner(id);
  }

  /**
   * Applies a completion or failure. Most jobs are NOT in a workflow, and for them one bare
   * statement is already atomic and costs a single round trip. So try that first, restricted to
   * jobs with no workflow. Only if it matches nothing (a workflow job, or a report that is a
   * replay or from a stale owner) fall back to the transactional path, which also reconciles the
   * job's workflow in the same transaction. Measured: wrapping every completion in a transaction
   * cost about +1.2 ms on a 1.9 ms operation (BEGIN and COMMIT are two extra round trips).
   */
  private async finishJob(
    sql: (plainJobsOnly: boolean) => string,
    params: unknown[],
  ): Promise<JobRow | undefined> {
    const fast = await this.db.query<JobRow>(sql(true), params);
    if (fast.rows[0]) return fast.rows[0];
    const rows = await this.changeAndReconcile(
      async (tx) => (await tx.query<JobRow>(sql(false), params)).rows,
    );
    return rows[0];
  }

  /** Marks the attempt succeeded. Repeating the same report is a harmless no-op (200). */
  async complete(id: string, workerId: string, attempt: number): Promise<FinishResult> {
    const row = await this.finishJob(
      (plain) => `WITH done AS (
         UPDATE jobs
         SET status = 'succeeded', finished_at = now(), lease_expires_at = NULL,
             last_error = NULL, updated_at = now()
         WHERE id = $1 AND status = 'running' AND claimed_by = $2 AND attempt_count = $3
           ${plain ? "AND workflow_id IS NULL" : ""}
         RETURNING ${COLUMNS}
       ),
       recorded AS (
         UPDATE job_attempts
         SET outcome = 'succeeded', finished_at = now()
         FROM done
         WHERE job_attempts.job_id = done.id AND job_attempts.attempt_number = done.attempt_count
       )
       SELECT ${COLUMNS} FROM done`,
      [id, workerId, attempt],
    );
    return row
      ? { outcome: "ok", job: toJob(row) }
      : this.replayOrReject(id, workerId, attempt, "succeeded");
  }

  /**
   * Records a failed attempt. If the failure is retryable and attempts remain, the job
   * goes back to `queued` with run_at pushed out by the backoff; otherwise it becomes
   * `failed` (the dead-letter state: it stays visible for a human, and is never retried).
   */
  async fail(
    id: string,
    workerId: string,
    attempt: number,
    error: string,
    retryable: boolean,
  ): Promise<FinishResult> {
    const retry = `($5::boolean AND attempt_count < max_attempts)`;
    const row = await this.finishJob(
      (plain) => `WITH failed AS (
         UPDATE jobs
         SET status = CASE WHEN ${retry} THEN 'queued' ELSE 'failed' END,
             run_at = CASE WHEN ${retry} THEN now() + ${backoffInterval("$6", "$7")} ELSE run_at END,
             claimed_by = CASE WHEN ${retry} THEN NULL ELSE claimed_by END,
             finished_at = CASE WHEN ${retry} THEN NULL ELSE now() END,
             last_error = $4, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'running' AND claimed_by = $2 AND attempt_count = $3
           ${plain ? "AND workflow_id IS NULL" : ""}
         RETURNING ${COLUMNS}
       ),
       recorded AS (
         UPDATE job_attempts
         SET outcome = 'failed', error = $4, finished_at = now()
         FROM failed
         WHERE job_attempts.job_id = failed.id AND job_attempts.attempt_number = failed.attempt_count
       )
       SELECT ${COLUMNS} FROM failed`,
      [id, workerId, attempt, error, retryable, this.config.retryBaseMs, this.config.retryMaxMs],
    );
    return row
      ? { outcome: "ok", job: toJob(row) }
      : this.replayOrReject(id, workerId, attempt, "failed");
  }

  /**
   * Takes back every job whose lease deadline has passed: retry with backoff if attempts
   * remain, otherwise `failed`. Safe to run from many API instances at once: the SELECT
   * uses FOR UPDATE SKIP LOCKED, so each expired job is recovered by exactly one sweeper,
   * and the UPDATE re-checks the lease so a renewal that landed first wins.
   */
  async recoverExpired(batchSize = 100): Promise<Job[]> {
    const retry = `attempt_count < max_attempts`;
    const rows = await this.changeAndReconcile(
      async (tx) =>
        (
          await tx.query<JobRow>(
            `WITH expired AS (
         SELECT id AS eid FROM jobs
         WHERE status = 'running' AND lease_expires_at < now()
         ORDER BY lease_expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ),
       recovered AS (
         UPDATE jobs
         SET status = CASE WHEN ${retry} THEN 'queued' ELSE 'failed' END,
             run_at = CASE WHEN ${retry} THEN now() + ${backoffInterval("$2", "$3")} ELSE run_at END,
             claimed_by = CASE WHEN ${retry} THEN NULL ELSE claimed_by END,
             finished_at = CASE WHEN ${retry} THEN NULL ELSE now() END,
             last_error = 'lease expired: the worker stopped renewing its lease',
             lease_expires_at = NULL, updated_at = now()
         FROM expired
         WHERE jobs.id = expired.eid AND jobs.status = 'running' AND jobs.lease_expires_at < now()
         RETURNING ${COLUMNS}
       ),
       recorded AS (
         UPDATE job_attempts
         SET outcome = 'lease_expired', error = 'lease expired', finished_at = now()
         FROM recovered
         WHERE job_attempts.job_id = recovered.id AND job_attempts.attempt_number = recovered.attempt_count
       )
       SELECT ${COLUMNS} FROM recovered`,
            [batchSize, this.config.retryBaseMs, this.config.retryMaxMs],
          )
        ).rows,
    );
    return rows.map(toJob);
  }

  async attempts(jobId: string): Promise<JobAttempt[] | null> {
    const exists = await this.db.query("SELECT 1 FROM jobs WHERE id = $1", [jobId]);
    if (exists.rowCount === 0) return null;
    const result = await this.db.query<{
      attempt_number: number;
      worker_id: string;
      outcome: JobAttempt["outcome"];
      error: string | null;
      started_at: Date;
      finished_at: Date | null;
    }>(
      `SELECT attempt_number, worker_id, outcome, error, started_at, finished_at
       FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number`,
      [jobId],
    );
    return result.rows.map((r) => ({
      attemptNumber: r.attempt_number,
      workerId: r.worker_id,
      outcome: r.outcome,
      error: r.error,
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
    }));
  }

  /** The guarded UPDATE matched nothing: distinguish "no such job" from "not yours (any more)". */
  private async notOwner(id: string): Promise<FinishResult> {
    const exists = await this.db.query("SELECT 1 FROM jobs WHERE id = $1", [id]);
    return { outcome: exists.rowCount === 0 ? "not_found" : "conflict" };
  }

  /**
   * Lost-acknowledgement handling. If the worker's earlier identical report already
   * committed but the HTTP response was lost, the retry finds its own attempt already
   * closed with the same outcome: answer success without changing anything.
   */
  private async replayOrReject(
    id: string,
    workerId: string,
    attempt: number,
    outcome: "succeeded" | "failed",
  ): Promise<FinishResult> {
    const prior = await this.db.query<{ worker_id: string; outcome: string }>(
      `SELECT worker_id, outcome FROM job_attempts WHERE job_id = $1 AND attempt_number = $2`,
      [id, attempt],
    );
    const row = prior.rows[0];
    if (row && row.worker_id === workerId && row.outcome === outcome) {
      const job = await this.db.query<JobRow>(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id]);
      if (job.rows[0]) return { outcome: "ok", job: toJob(job.rows[0]) };
    }
    return this.notOwner(id);
  }
}
