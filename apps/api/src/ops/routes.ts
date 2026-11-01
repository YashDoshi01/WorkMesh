import { Router, type Request } from "express";
import { z } from "zod";
import { logInfo } from "@workmesh/shared";
import { HttpError } from "../http/errors.js";
import { parse } from "../http/validate.js";
import type { JobLifecycle } from "../jobs/lifecycle.js";
import { InvalidCursorError, type JobRepository } from "../jobs/repository.js";
import { createJobSchema, jobIdSchema, listJobsQuerySchema } from "../jobs/schema.js";
import { patchScheduleSchema, listSchedulesQuerySchema } from "../schedules/schema.js";
import type { ScheduleRepository } from "../schedules/repository.js";
import type { WorkflowRepository } from "../workflows/repository.js";
import { listWorkflowsQuerySchema } from "../workflows/schema.js";
import type { OpsActions, ActionResult } from "./actions.js";
import type { AuditRepository } from "./audit.js";
import { principalOf, requireRole, type Authenticator } from "./auth.js";
import { WORKER_STALE_AFTER_MS, type OpsQueries } from "./queries.js";

const retryBodySchema = z.strictObject({ attempts: z.number().int().min(1).max(20).default(1) });
const statsQuerySchema = z.strictObject({
  windowMinutes: z.coerce.number().int().min(1).max(1440).default(60),
});
const workersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const auditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z
    .string()
    .regex(/^\d{1,18}$/, "must be an audit entry id")
    .optional(),
});

/** Turns a non-ok action result into the matching HTTP error. */
function unwrap<T>(result: ActionResult<T>, what: string): T {
  if (result.outcome === "ok") return result.value;
  if (result.outcome === "not_found")
    throw new HttpError(404, `${what}_not_found`, `No such ${what}`);
  throw new HttpError(409, result.code, result.message);
}

export interface OpsDeps {
  auth: Authenticator;
  actions: OpsActions;
  audit: AuditRepository;
  queries: OpsQueries;
  jobs: JobRepository;
  lifecycle: JobLifecycle;
  workflows: WorkflowRepository;
  schedules: ScheduleRepository;
}

/**
 * The operator plane: everything the dashboard needs, behind API-key authentication.
 *
 *   viewer   : read-only  (every GET)
 *   operator : everything a viewer can do, plus every state-changing request
 *
 * The role of each route is declared on the route itself, next to its handler.
 */
export function opsRoutes(d: OpsDeps): Router {
  const router = Router();
  const viewer = requireRole("viewer");
  const operator = requireRole("operator");

  // Operator responses can contain payloads and errors: never let a proxy or browser cache them.
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(d.auth.authenticate);

  router.get("/me", viewer, (req, res) => {
    const p = principalOf(req);
    res.json({ role: p.role, actor: p.actor });
  });

  // ------------------------------------------------------------------ read-only
  router.get("/stats", viewer, async (req, res) => {
    const { windowMinutes } = parse(statsQuerySchema, req.query, "query parameters");
    res.json(await d.queries.stats(windowMinutes));
  });

  router.get("/workers", viewer, async (req, res) => {
    const { limit } = parse(workersQuerySchema, req.query, "query parameters");
    res.json({ staleAfterMs: WORKER_STALE_AFTER_MS, items: await d.queries.workers(limit) });
  });

  router.get("/audit", viewer, async (req, res) => {
    const { limit, before } = parse(auditQuerySchema, req.query, "query parameters");
    res.json(await d.audit.list(limit, before));
  });

  router.get("/jobs", viewer, async (req, res) => {
    const query = parse(listJobsQuerySchema, req.query, "query parameters");
    try {
      res.json(await d.jobs.list(query));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        throw new HttpError(400, "validation_error", "Invalid query parameters", [
          { path: "cursor", message: err.message },
        ]);
      }
      throw err;
    }
  });

  router.get("/jobs/:id", viewer, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    const job = await d.jobs.findById(id);
    if (!job) throw new HttpError(404, "job_not_found", `Job ${id} does not exist`);
    res.json(job);
  });

  router.get("/jobs/:id/attempts", viewer, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    const attempts = await d.lifecycle.attempts(id);
    if (!attempts) throw new HttpError(404, "job_not_found", `Job ${id} does not exist`);
    res.json({ items: attempts });
  });

  router.get("/workflows", viewer, async (req, res) => {
    const query = parse(listWorkflowsQuerySchema, req.query, "query parameters");
    res.json({ items: await d.workflows.list(query) });
  });

  router.get("/workflows/:id", viewer, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "workflow id");
    const workflow = await d.workflows.findById(id);
    if (!workflow) throw new HttpError(404, "workflow_not_found", `Workflow ${id} does not exist`);
    res.json(workflow);
  });

  router.get("/schedules", viewer, async (req, res) => {
    const { limit } = parse(listSchedulesQuerySchema, req.query, "query parameters");
    res.json({ items: await d.schedules.list(limit) });
  });

  router.get("/schedules/:id", viewer, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "schedule id");
    const schedule = await d.schedules.findById(id);
    if (!schedule) throw new HttpError(404, "schedule_not_found", `Schedule ${id} does not exist`);
    res.json(schedule);
  });

  // ------------------------------------------------------------- state-changing
  const ctx = (req: Request) => ({ principal: principalOf(req), requestId: req.requestId });

  router.post("/jobs", operator, async (req, res) => {
    const input = parse(createJobSchema, req.body, "job");
    const job = await d.actions.submitJob(ctx(req), input);
    logInfo("ops_job_submitted", {
      requestId: req.requestId,
      actor: principalOf(req).actor,
      jobId: job.id,
    });
    res.status(201).location(`/ops/jobs/${job.id}`).json(job);
  });

  router.post("/jobs/:id/cancel", operator, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    const job = unwrap(await d.actions.cancelJob(ctx(req), id), "job");
    logInfo("ops_job_cancelled", {
      requestId: req.requestId,
      actor: principalOf(req).actor,
      jobId: id,
    });
    res.json(job);
  });

  router.post("/jobs/:id/retry", operator, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    const { attempts } = parse(retryBodySchema, req.body ?? {}, "retry request");
    const job = unwrap(await d.actions.retryJob(ctx(req), id, attempts), "job");
    logInfo("ops_job_retried", {
      requestId: req.requestId,
      actor: principalOf(req).actor,
      jobId: id,
      attempts,
    });
    res.json(job);
  });

  router.post("/workflows/:id/cancel", operator, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "workflow id");
    const workflow = unwrap(await d.actions.cancelWorkflow(ctx(req), id), "workflow");
    res.json(workflow);
  });

  router.patch("/schedules/:id", operator, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "schedule id");
    const { enabled } = parse(patchScheduleSchema, req.body, "schedule update");
    res.json(unwrap(await d.actions.setScheduleEnabled(ctx(req), id, enabled), "schedule"));
  });

  router.delete("/schedules/:id", operator, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "schedule id");
    unwrap(await d.actions.deleteSchedule(ctx(req), id), "schedule");
    res.status(204).end();
  });

  return router;
}
