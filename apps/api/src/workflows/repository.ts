import type { Db } from "../db/pool.js";
import { withTransaction, type Tx } from "../db/tx.js";
import {
  logReconcile,
  reconcileWorkflow,
  type ReconcileSummary,
  type WorkflowStatus,
} from "./reconcile.js";
import type { CreateWorkflowInput } from "./schema.js";

export interface Progress {
  total: number;
  /** Not started: a dependency has not succeeded yet. */
  waiting: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  /** A queued job withdrawn by cancellation. */
  cancelled: number;
  /** Will never run (a dependency failed or was cancelled, or the workflow was cancelled). */
  skipped: number;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  /** The account that owns this workflow and all of its jobs. */
  account: string;
  status: WorkflowStatus;
  /** True once cancellation was requested, even while running jobs are still finishing. */
  cancelRequested: boolean;
  createdAt: string;
  finishedAt: string | null;
  progress: Progress;
}

export type NodeState =
  "waiting" | "skipped" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface WorkflowNode {
  key: string;
  type: string;
  state: NodeState;
  dependsOn: string[];
  /** The job, once the node has been released. */
  jobId: string | null;
  attemptCount: number | null;
  lastError: string | null;
}

export interface WorkflowDetail extends WorkflowSummary {
  nodes: WorkflowNode[];
}

export type CancelResult =
  | { outcome: "ok"; workflow: WorkflowDetail }
  | { outcome: "finished"; status: WorkflowStatus }
  | { outcome: "not_found" };

interface SummaryRow {
  id: string;
  name: string;
  account: string;
  status: WorkflowStatus;
  cancel_requested_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
  total: number;
  waiting: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

// Progress is DERIVED on every read from node status + job status. Nothing is stored that
// could drift out of step with the jobs.
const SUMMARY_SELECT = `
  SELECT w.id, w.name, w.account, w.status, w.cancel_requested_at, w.created_at, w.finished_at,
    count(n.id)::int AS total,
    count(*) FILTER (WHERE n.status = 'waiting')::int AS waiting,
    count(*) FILTER (WHERE n.status = 'skipped')::int AS skipped,
    count(*) FILTER (WHERE n.status = 'released' AND j.status = 'queued')::int AS queued,
    count(*) FILTER (WHERE n.status = 'released' AND j.status = 'running')::int AS running,
    count(*) FILTER (WHERE n.status = 'released' AND j.status = 'succeeded')::int AS succeeded,
    count(*) FILTER (WHERE n.status = 'released' AND j.status = 'failed')::int AS failed,
    count(*) FILTER (WHERE n.status = 'released' AND j.status = 'cancelled')::int AS cancelled
  FROM workflows w
  LEFT JOIN workflow_nodes n ON n.workflow_id = w.id
  LEFT JOIN jobs j ON j.id = n.job_id AND n.status = 'released'`;

function toSummary(r: SummaryRow): WorkflowSummary {
  return {
    id: r.id,
    name: r.name,
    account: r.account,
    status: r.status,
    cancelRequested: r.cancel_requested_at !== null,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    progress: {
      total: r.total,
      waiting: r.waiting,
      queued: r.queued,
      running: r.running,
      succeeded: r.succeeded,
      failed: r.failed,
      cancelled: r.cancelled,
      skipped: r.skipped,
    },
  };
}

export class WorkflowRepository {
  constructor(private readonly db: Db) {}

  /**
   * Creates the workflow, all its nodes and all its dependency edges in ONE transaction, then
   * releases the nodes that have no dependencies. Either everything exists or nothing does:
   * a crash half-way can never leave a workflow with missing edges (which would let a node
   * run too early).
   */
  async create(input: CreateWorkflowInput, account = "default"): Promise<WorkflowDetail> {
    const { detail, summary } = await withTransaction(this.db, async (tx) => {
      const wf = await tx.query<{ id: string }>(
        `INSERT INTO workflows (name, account) VALUES ($1, $2) RETURNING id`,
        [input.name, account],
      );
      const id = wf.rows[0]!.id;
      const nodesJson = JSON.stringify(input.nodes);

      await tx.query(
        `INSERT INTO workflow_nodes (workflow_id, key, job_type, payload, priority, max_attempts)
         SELECT $1, x.key, x.type, x.payload, x.priority, x."maxAttempts"
         FROM jsonb_to_recordset($2::jsonb)
           AS x(key text, type text, payload jsonb, priority int, "maxAttempts" int)`,
        [id, nodesJson],
      );

      const expectedEdges = input.nodes.reduce((sum, n) => sum + n.dependsOn.length, 0);
      const edges = await tx.query(
        `INSERT INTO workflow_edges (workflow_id, node_id, depends_on_node_id)
         SELECT $1, n.id, d.id
         FROM jsonb_to_recordset($2::jsonb) AS x(key text, "dependsOn" jsonb)
         CROSS JOIN LATERAL jsonb_array_elements_text(x."dependsOn") AS dep(key)
         JOIN workflow_nodes n ON n.workflow_id = $1 AND n.key = x.key
         JOIN workflow_nodes d ON d.workflow_id = $1 AND d.key = dep.key`,
        [id, nodesJson],
      );
      if ((edges.rowCount ?? 0) !== expectedEdges) {
        // Validation should make this impossible; if it ever happens, fail loudly and undo
        // everything rather than start a workflow with missing dependencies.
        throw new Error(`inserted ${edges.rowCount} dependency edges, expected ${expectedEdges}`);
      }

      const summary = await reconcileWorkflow(tx, id);
      return { detail: await this.loadDetail(tx, id), summary };
    });
    logReconcile(summary);
    return detail!;
  }

  async findById(id: string): Promise<WorkflowDetail | null> {
    return this.loadDetail(this.db, id);
  }

  async list(filter: {
    status?: WorkflowStatus | undefined;
    limit: number;
    /** Only this account's workflows (clients). Omit for all (operators). */
    account?: string | undefined;
  }): Promise<WorkflowSummary[]> {
    const result = await this.db.query<SummaryRow>(
      `${SUMMARY_SELECT}
       WHERE w.id IN (
         SELECT id FROM workflows
         WHERE ($1::text IS NULL OR status = $1) AND ($3::text IS NULL OR account = $3)
         ORDER BY created_at DESC, id DESC
         LIMIT $2)
       GROUP BY w.id
       ORDER BY w.created_at DESC, w.id DESC`,
      [filter.status ?? null, filter.limit, filter.account ?? null],
    );
    return result.rows.map(toSummary);
  }

  /**
   * Requests cancellation. Waiting nodes are skipped and queued jobs withdrawn immediately;
   * jobs already running are left to finish (they cannot be stopped safely), after which the
   * workflow becomes `cancelled`. Repeating the request is harmless.
   */
  async cancel(
    id: string,
    /** Runs inside the cancel transaction once cancellation took effect (the operator plane writes its audit record here, atomically). */
    inTransaction?: (tx: Tx, workflow: WorkflowDetail) => Promise<void>,
  ): Promise<CancelResult> {
    const outcome = await withTransaction(
      this.db,
      async (
        tx,
      ): Promise<
        | { kind: "not_found" }
        | { kind: "finished"; status: WorkflowStatus }
        | { kind: "ok"; summary: ReconcileSummary; detail: WorkflowDetail }
      > => {
        const locked = await tx.query<{ status: WorkflowStatus }>(
          `SELECT status FROM workflows WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const row = locked.rows[0];
        if (!row) return { kind: "not_found" };
        if (row.status === "succeeded" || row.status === "failed") {
          return { kind: "finished", status: row.status };
        }
        await tx.query(
          `UPDATE workflows
         SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
         WHERE id = $1`,
          [id],
        );
        const summary = await reconcileWorkflow(tx, id);
        const detail = (await this.loadDetail(tx, id))!;
        await inTransaction?.(tx, detail);
        return { kind: "ok", summary, detail };
      },
    );
    if (outcome.kind === "not_found") return { outcome: "not_found" };
    if (outcome.kind === "finished") return { outcome: "finished", status: outcome.status };
    logReconcile(outcome.summary);
    return { outcome: "ok", workflow: outcome.detail };
  }

  private async loadDetail(q: Db | Tx, id: string): Promise<WorkflowDetail | null> {
    const summaryRes = await q.query<SummaryRow>(
      `${SUMMARY_SELECT} WHERE w.id = $1 GROUP BY w.id`,
      [id],
    );
    const summaryRow = summaryRes.rows[0];
    if (!summaryRow) return null;
    const nodes = await q.query<{
      key: string;
      job_type: string;
      node_status: "waiting" | "released" | "skipped";
      job_id: string;
      job_status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;
      attempt_count: number | null;
      last_error: string | null;
      depends_on: string[];
    }>(
      `SELECT n.key, n.job_type, n.status AS node_status, n.job_id, j.status AS job_status,
              j.attempt_count, j.last_error,
              COALESCE((SELECT array_agg(p.key ORDER BY p.key)
                        FROM workflow_edges e
                        JOIN workflow_nodes p ON p.id = e.depends_on_node_id
                        WHERE e.node_id = n.id), '{}') AS depends_on
       FROM workflow_nodes n
       LEFT JOIN jobs j ON j.id = n.job_id AND n.status = 'released'
       WHERE n.workflow_id = $1
       ORDER BY n.key`,
      [id],
    );
    return {
      ...toSummary(summaryRow),
      nodes: nodes.rows.map((n) => ({
        key: n.key,
        type: n.job_type,
        state: n.node_status === "released" ? n.job_status! : n.node_status,
        dependsOn: n.depends_on,
        jobId: n.node_status === "released" ? n.job_id : null,
        attemptCount: n.attempt_count,
        lastError: n.last_error,
      })),
    };
  }
}
