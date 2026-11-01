import { logInfo, logWarn } from "@workmesh/shared";
import type { Tx } from "../db/tx.js";

export type WorkflowStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface ReconcileSummary {
  workflowId: string;
  /** Jobs created for nodes whose dependencies all succeeded. */
  releasedJobIds: string[];
  /** Nodes that will never run because a dependency failed/was cancelled, or the workflow was. */
  skippedNodes: number;
  /** Queued jobs withdrawn because cancellation was requested. */
  cancelledJobs: number;
  /** Set when this call moved the workflow to a terminal status. */
  finishedAs: WorkflowStatus | null;
}

// "node n has at least one dependency whose job has not succeeded" (a dependency that has no
// job yet counts: its LEFT JOIN yields NULL, which IS DISTINCT FROM 'succeeded').
const SOME_DEPENDENCY_NOT_SUCCEEDED = `
  EXISTS (
    SELECT 1 FROM workflow_edges e
    JOIN workflow_nodes p ON p.id = e.depends_on_node_id
    LEFT JOIN jobs pj ON pj.id = p.job_id
    WHERE e.node_id = n.id AND pj.status IS DISTINCT FROM 'succeeded')`;

// "node n has a dependency that can never succeed"
const SOME_DEPENDENCY_DEAD = `
  EXISTS (
    SELECT 1 FROM workflow_edges e
    JOIN workflow_nodes p ON p.id = e.depends_on_node_id
    LEFT JOIN jobs pj ON pj.id = p.job_id
    WHERE e.node_id = n.id AND (p.status = 'skipped' OR pj.status IN ('failed', 'cancelled')))`;

/**
 * Brings one workflow's runtime state in line with its jobs. Call it, inside the transaction
 * that changed a workflow job (or the workflow itself), after EVERY such change.
 *
 * It is level-triggered and idempotent: it looks at the current state and does whatever is
 * needed, so calling it twice, or when nothing changed, is harmless. In order it
 *   1. locks the workflow row,
 *   2. if cancellation was requested: skips waiting nodes and withdraws queued jobs;
 *      otherwise: skips nodes with a dead dependency (repeating until nothing more
 *      cascades), then releases nodes whose dependencies have all succeeded,
 *   3. moves the workflow to a terminal status when nothing is waiting or executing.
 *
 * THE LOCK IS WHAT MAKES IT CORRECT. Suppose parents P1 and P2 of child C finish at the same
 * moment in two transactions. Each has updated its own job but cannot see the other's
 * uncommitted change, so each would conclude "the other parent isn't done yet" and neither
 * would release C: C would wait forever (a lost wake-up). Because every transaction takes the
 * workflow row lock AFTER making its own job change, the second one to get the lock runs its
 * checks in a fresh statement that sees the first one's committed change.
 *
 * Cost: O(nodes + edges) of one workflow (bounded at definition time), and concurrent
 * completions within ONE workflow serialize on its lock.
 */
export async function reconcileWorkflow(tx: Tx, workflowId: string): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    workflowId,
    releasedJobIds: [],
    skippedNodes: 0,
    cancelledJobs: 0,
    finishedAs: null,
  };

  const locked = await tx.query<{ status: WorkflowStatus; cancel_requested_at: Date | null }>(
    `SELECT status, cancel_requested_at FROM workflows WHERE id = $1 FOR UPDATE`,
    [workflowId],
  );
  const workflow = locked.rows[0];
  if (!workflow || workflow.status !== "running") return summary; // gone, or already final

  if (workflow.cancel_requested_at) {
    const skipped = await tx.query(
      `UPDATE workflow_nodes SET status = 'skipped'
       WHERE workflow_id = $1 AND status = 'waiting'`,
      [workflowId],
    );
    summary.skippedNodes += skipped.rowCount ?? 0;
    // Only QUEUED jobs can be withdrawn. A running job cannot be stopped safely (a timeout is
    // not proof that its work stopped), so it is left to finish; its result is recorded but
    // releases nothing, because every waiting node is already skipped.
    const cancelled = await tx.query(
      `UPDATE jobs SET status = 'cancelled', finished_at = now(), updated_at = now()
       WHERE workflow_id = $1 AND status = 'queued'`,
      [workflowId],
    );
    summary.cancelledJobs = cancelled.rowCount ?? 0;
  } else {
    // A skipped node can doom its own dependents, so repeat until nothing changes. Each pass
    // skips at least one node or stops, so it ends within (number of nodes + 1) passes.
    for (;;) {
      const skipped = await tx.query(
        `UPDATE workflow_nodes n SET status = 'skipped'
         WHERE n.workflow_id = $1 AND n.status = 'waiting' AND ${SOME_DEPENDENCY_DEAD}`,
        [workflowId],
      );
      if (!skipped.rowCount) break;
      summary.skippedNodes += skipped.rowCount;
    }
    // Releasing creates jobs that are not yet terminal, so it cannot unblock or doom anything
    // else: one pass is enough. Roots (no dependencies) are released by the same statement.
    const released = await tx.query<{ id: string }>(
      `WITH ready AS (
         UPDATE workflow_nodes n SET status = 'released'
         WHERE n.workflow_id = $1 AND n.status = 'waiting'
           AND NOT ${SOME_DEPENDENCY_NOT_SUCCEEDED}
         RETURNING n.job_id, n.job_type, n.payload, n.priority, n.max_attempts, n.workflow_id
       )
       INSERT INTO jobs
         (id, type, payload, priority, max_attempts, run_at, scheduled_for, workflow_id, account)
       SELECT job_id, job_type, payload, priority, max_attempts, now(), now(), workflow_id,
              (SELECT account FROM workflows WHERE id = $1)
       FROM ready
       RETURNING id`,
      [workflowId],
    );
    summary.releasedJobIds = released.rows.map((r) => r.id);
  }

  const counts = await tx.query<{ waiting: number; active: number; bad: number }>(
    `SELECT
       count(*) FILTER (WHERE n.status = 'waiting')::int AS waiting,
       count(*) FILTER (WHERE n.status = 'released' AND j.status IN ('queued', 'running'))::int AS active,
       count(*) FILTER (WHERE n.status = 'skipped' OR j.status IN ('failed', 'cancelled'))::int AS bad
     FROM workflow_nodes n
     LEFT JOIN jobs j ON j.id = n.job_id AND n.status = 'released'
     WHERE n.workflow_id = $1`,
    [workflowId],
  );
  const { waiting, active, bad } = counts.rows[0]!;
  if (waiting === 0 && active === 0) {
    // Cancellation wins over everything else: the caller asked for it, and node-level states
    // still show which nodes succeeded or failed before it took effect.
    const finalStatus: WorkflowStatus = workflow.cancel_requested_at
      ? "cancelled"
      : bad > 0
        ? "failed"
        : "succeeded";
    await tx.query(
      `UPDATE workflows SET status = $2, finished_at = now(), updated_at = now() WHERE id = $1`,
      [workflowId, finalStatus],
    );
    summary.finishedAs = finalStatus;
  } else if (summary.releasedJobIds.length || summary.skippedNodes || summary.cancelledJobs) {
    await tx.query(`UPDATE workflows SET updated_at = now() WHERE id = $1`, [workflowId]);
  }
  return summary;
}

/** Log what a reconcile did. Call AFTER the transaction commits, so the log never describes work that rolled back. */
export function logReconcile(summary: ReconcileSummary): void {
  const base = { workflowId: summary.workflowId };
  for (const jobId of summary.releasedJobIds) logInfo("workflow_node_released", { ...base, jobId });
  if (summary.skippedNodes) {
    logWarn("workflow_nodes_skipped", { ...base, count: summary.skippedNodes });
  }
  if (summary.cancelledJobs) {
    logWarn("workflow_jobs_cancelled", { ...base, count: summary.cancelledJobs });
  }
  if (summary.finishedAs) {
    (summary.finishedAs === "succeeded" ? logInfo : logWarn)("workflow_finished", {
      ...base,
      status: summary.finishedAs,
    });
  }
}
