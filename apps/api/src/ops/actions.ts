import type { Db } from "../db/pool.js";
import { withTransaction, type Tx } from "../db/tx.js";
import { COLUMNS, toJob, type Job, type JobRepository, type JobRow } from "../jobs/repository.js";
import type { CreateJobInput } from "../jobs/schema.js";
import type { ApiKey, ApiKeyRepository } from "../keys/repository.js";
import type { CreateKeyInput } from "../keys/schema.js";
import type { Schedule, ScheduleRepository } from "../schedules/repository.js";
import type { CreateScheduleInput } from "../schedules/schema.js";
import type { WorkflowDetail, WorkflowRepository } from "../workflows/repository.js";
import type { AuditActor, AuditRepository } from "./audit.js";

export type ActionResult<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "not_found" }
  | { outcome: "conflict"; code: string; message: string };

/** The most attempts a job can ever be allowed (mirrors the CHECK constraint). */
export const MAX_ATTEMPT_BUDGET = 1000;

export interface Context {
  principal: AuditActor;
  /** Set for customer users: the audit record then belongs to that organisation. */
  account?: string | undefined;
  requestId: string | undefined;
  clientIp: string | undefined;
}

/**
 * Operator actions. Every one writes its audit record INSIDE the transaction that performs the
 * action: there is no action without a record, and no record of an action that rolled back.
 *
 * Every state change is a conditional UPDATE (`WHERE status = ...`), so the DATABASE decides
 * whether the transition is allowed. The dashboard hides buttons that cannot work, but that is
 * a courtesy: a direct API call for an impossible transition is refused here (tested).
 */
export class OpsActions {
  constructor(
    private readonly db: Db,
    private readonly jobs: JobRepository,
    private readonly workflows: WorkflowRepository,
    private readonly schedules: ScheduleRepository,
    private readonly audit: AuditRepository,
    private readonly keys: ApiKeyRepository,
  ) {}

  /**
   * Creates a machine API key. The secret is returned ONCE to the caller and appears nowhere else:
   * the audit record holds the key's id, prefix, kind, account and name, never the secret.
   */
  async createKey(ctx: Context, input: CreateKeyInput): Promise<{ key: ApiKey; secret: string }> {
    return withTransaction(this.db, async (tx) => {
      const created = await this.keys.create(tx, {
        kind: input.kind,
        account: input.account,
        name: input.name,
        jobTypes: input.jobTypes ?? null,
        expiresInDays: input.expiresInDays ?? null,
        createdBy: ctx.principal.actor,
      });
      await this.audit.record(tx, ctx.principal, {
        action: "key.create",
        targetType: "api_key",
        targetId: created.key.id,
        details: {
          prefix: created.key.prefix,
          kind: created.key.kind,
          account: created.key.account,
          name: created.key.name,
          expiresAt: created.key.expiresAt,
        },
        requestId: ctx.requestId,
        clientIp: ctx.clientIp,
        account: ctx.account,
      });
      return created;
    });
  }

  /** Revokes a key at once, on every API instance. Repeating it is harmless and not re-audited. */
  async revokeKey(ctx: Context, id: string): Promise<ActionResult<ApiKey>> {
    return withTransaction(this.db, async (tx): Promise<ActionResult<ApiKey>> => {
      const before = await this.keys.findById(id, tx);
      if (!before) return { outcome: "not_found" };
      if (before.status === "revoked") return { outcome: "ok", value: before };
      const key = (await this.keys.revoke(tx, id, ctx.principal.actor))!;
      await this.audit.record(tx, ctx.principal, {
        action: "key.revoke",
        targetType: "api_key",
        targetId: id,
        details: { prefix: key.prefix, kind: key.kind, account: key.account, name: key.name },
        requestId: ctx.requestId,
        clientIp: ctx.clientIp,
        account: ctx.account,
      });
      return { outcome: "ok", value: key };
    });
  }

  /** One-off job submission from the dashboard. Payloads are never written to the audit log. */
  async submitJob(ctx: Context, input: CreateJobInput, account = "default"): Promise<Job> {
    return withTransaction(this.db, async (tx) => {
      const job = await this.jobs.create(input, { account, requestId: ctx.requestId }, tx);
      await this.audit.record(tx, ctx.principal, {
        action: "job.submit",
        targetType: "job",
        targetId: job.id,
        details: {
          type: job.type,
          priority: job.priority,
          maxAttempts: job.maxAttempts,
          scheduledFor: job.scheduledFor,
          account,
        },
        requestId: ctx.requestId,
        clientIp: ctx.clientIp,
        account: ctx.account,
      });
      return job;
    });
  }

  /** Withdraws a job nobody has started. Running jobs cannot be stopped safely, so they are refused. */
  async cancelJob(ctx: Context, id: string): Promise<ActionResult<Job>> {
    return withTransaction(this.db, async (tx): Promise<ActionResult<Job>> => {
      const result = await tx.query<JobRow>(
        `UPDATE jobs SET status = 'cancelled', finished_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'queued' AND workflow_id IS NULL
         RETURNING ${COLUMNS}`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return this.whyNot(tx, id, "cancel");
      await this.audit.record(tx, ctx.principal, {
        action: "job.cancel",
        targetType: "job",
        targetId: id,
        details: { type: row.type },
        requestId: ctx.requestId,
        clientIp: ctx.clientIp,
        account: ctx.account,
      });
      return { outcome: "ok", value: toJob(row) };
    });
  }

  /**
   * Gives a dead-lettered (`failed`) job `attempts` more tries. attempt_count is NOT reset: it is
   * the fencing token and the key of the attempt history, so history stays intact and a stale
   * report from an old attempt is still rejected. The budget becomes attempts-so-far + granted.
   */
  async retryJob(ctx: Context, id: string, attempts: number): Promise<ActionResult<Job>> {
    return withTransaction(this.db, async (tx): Promise<ActionResult<Job>> => {
      const result = await tx.query<JobRow>(
        `UPDATE jobs
         SET status = 'queued', run_at = now(), claimed_by = NULL, finished_at = NULL,
             lease_expires_at = NULL, max_attempts = attempt_count + $2, updated_at = now()
         WHERE id = $1 AND status = 'failed' AND workflow_id IS NULL
           AND attempt_count + $2 <= ${MAX_ATTEMPT_BUDGET}
         RETURNING ${COLUMNS}`,
        [id, attempts],
      );
      const row = result.rows[0];
      if (!row) return this.whyNot(tx, id, "retry", attempts);
      await this.audit.record(tx, ctx.principal, {
        action: "job.retry",
        targetType: "job",
        targetId: id,
        details: { type: row.type, attemptsGranted: attempts, attemptsSoFar: row.attempt_count },
        requestId: ctx.requestId,
        clientIp: ctx.clientIp,
        account: ctx.account,
      });
      return { outcome: "ok", value: toJob(row) };
    });
  }

  async cancelWorkflow(ctx: Context, id: string): Promise<ActionResult<WorkflowDetail>> {
    const result = await this.workflows.cancel(id, (tx, workflow) =>
      this.audit.record(tx, ctx.principal, {
        action: "workflow.cancel",
        targetType: "workflow",
        targetId: id,
        details: { name: workflow.name, statusAfter: workflow.status },
        requestId: ctx.requestId,
        clientIp: ctx.clientIp,
        account: ctx.account,
      }),
    );
    if (result.outcome === "not_found") return { outcome: "not_found" };
    if (result.outcome === "finished") {
      return {
        outcome: "conflict",
        code: "workflow_finished",
        message: `Workflow ${id} already finished as ${result.status}; nothing to cancel`,
      };
    }
    return { outcome: "ok", value: result.workflow };
  }

  async setScheduleEnabled(
    ctx: Context,
    id: string,
    enabled: boolean,
  ): Promise<ActionResult<Schedule>> {
    return withTransaction(this.db, async (tx): Promise<ActionResult<Schedule>> => {
      const schedule = await this.schedules.setEnabled(id, enabled, tx);
      if (!schedule) return { outcome: "not_found" };
      await this.audit.record(tx, ctx.principal, {
        action: enabled ? "schedule.enable" : "schedule.disable",
        targetType: "schedule",
        targetId: id,
        details: { name: schedule.name },
        requestId: ctx.requestId,
        clientIp: ctx.clientIp,
        account: ctx.account,
      });
      return { outcome: "ok", value: schedule };
    });
  }

  /** Creates a recurring schedule in an account, with its audit record in the same transaction. */
  async createSchedule(
    ctx: Context,
    input: CreateScheduleInput,
    account: string,
  ): Promise<Schedule> {
    return withTransaction(this.db, async (tx) => {
      const schedule = await this.schedules.create(input, account, tx);
      await this.audit.record(tx, ctx.principal, {
        action: "schedule.create",
        targetType: "schedule",
        targetId: schedule.id,
        details: {
          name: schedule.name,
          cron: schedule.cron,
          timezone: schedule.timezone,
          jobType: schedule.jobType,
        },
        requestId: ctx.requestId,
        clientIp: ctx.clientIp,
        account: ctx.account,
      });
      return schedule;
    });
  }

  async deleteSchedule(ctx: Context, id: string): Promise<ActionResult<{ name: string }>> {
    return withTransaction(this.db, async (tx): Promise<ActionResult<{ name: string }>> => {
      const existing = await this.schedules.findById(id, tx);
      if (!existing || !(await this.schedules.delete(id, tx))) return { outcome: "not_found" };
      await this.audit.record(tx, ctx.principal, {
        action: "schedule.delete",
        targetType: "schedule",
        targetId: id,
        details: { name: existing.name },
        requestId: ctx.requestId,
        clientIp: ctx.clientIp,
        account: ctx.account,
      });
      return { outcome: "ok", value: { name: existing.name } };
    });
  }

  /** The guarded UPDATE matched nothing: say precisely why. */
  private async whyNot(
    tx: Tx,
    id: string,
    verb: "cancel" | "retry",
    attempts?: number,
  ): Promise<ActionResult<never>> {
    const found = await tx.query<{
      status: string;
      workflow_id: string | null;
      attempt_count: number;
    }>(`SELECT status, workflow_id, attempt_count FROM jobs WHERE id = $1`, [id]);
    const job = found.rows[0];
    if (!job) return { outcome: "not_found" };
    if (job.workflow_id) {
      return {
        outcome: "conflict",
        code: "job_in_workflow",
        message:
          verb === "cancel"
            ? "This job belongs to a workflow; cancel the workflow instead"
            : "This job belongs to a workflow; re-running part of a workflow is not supported",
      };
    }
    if (verb === "retry" && job.status === "failed") {
      return {
        outcome: "conflict",
        code: "retry_budget_exhausted",
        message: `The job has already used ${job.attempt_count} attempts; granting ${attempts} more would exceed the limit of ${MAX_ATTEMPT_BUDGET}`,
      };
    }
    return {
      outcome: "conflict",
      code: verb === "cancel" ? "job_not_cancellable" : "job_not_retryable",
      message:
        verb === "cancel"
          ? `The job is ${job.status}; only queued jobs can be cancelled (a running job cannot be stopped safely)`
          : `The job is ${job.status}; only failed jobs can be retried`,
    };
  }
}
