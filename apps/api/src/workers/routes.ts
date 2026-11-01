import { Router } from "express";
import { logInfo, logWarn } from "@workmesh/shared";
import { HttpError } from "../http/errors.js";
import { parse } from "../http/validate.js";
import type { JobLifecycle } from "../jobs/lifecycle.js";
import type { FinishResult } from "../jobs/repository.js";
import { jobIdSchema } from "../jobs/schema.js";
import type { WorkerRepository } from "./repository.js";
import {
  claimSchema,
  completeSchema,
  failSchema,
  registerWorkerSchema,
  renewSchema,
} from "./schema.js";

function unwrap(result: FinishResult, jobId: string, workerId: string, attempt: number) {
  if (result.outcome === "ok") return result.job;
  if (result.outcome === "not_found") {
    throw new HttpError(404, "job_not_found", `Job ${jobId} does not exist`);
  }
  throw new HttpError(
    409,
    "job_not_owned",
    `Job ${jobId} is not running as attempt ${attempt} under worker ${workerId}`,
  );
}

/** The worker protocol: register, heartbeat, claim, renew lease, complete, fail. */
export function workerRoutes(workers: WorkerRepository, lifecycle: JobLifecycle): Router {
  const router = Router();

  router.post("/workers", async (req, res) => {
    const worker = await workers.register(parse(registerWorkerSchema, req.body, "worker"));
    logInfo("worker_registered", {
      requestId: req.requestId,
      workerId: worker.id,
      name: worker.name,
      jobTypes: worker.jobTypes,
      concurrency: worker.concurrency,
    });
    res.status(201).location(`/workers/${worker.id}`).json(worker);
  });

  router.post("/workers/:id/heartbeat", async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "worker id");
    const worker = await workers.heartbeat(id);
    if (!worker) throw new HttpError(404, "worker_not_found", `Worker ${id} is not registered`);
    res.json({ lastHeartbeatAt: worker.lastHeartbeatAt });
  });

  router.post("/workers/:id/claim", async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "worker id");
    const { limit } = parse(claimSchema, req.body ?? {}, "claim request");
    // Claiming also proves the worker is alive, so it doubles as a heartbeat.
    const worker = await workers.heartbeat(id);
    if (!worker) throw new HttpError(404, "worker_not_found", `Worker ${id} is not registered`);
    const claimed = await lifecycle.claim(id, worker.jobTypes, limit);
    for (const job of claimed) {
      logInfo("job_claimed", {
        requestId: req.requestId,
        jobId: job.id,
        type: job.type,
        workerId: id,
        attempt: job.attemptCount,
        leaseExpiresAt: job.leaseExpiresAt,
      });
    }
    // leaseMs tells the SDK how often it must renew.
    res.json({ jobs: claimed, leaseMs: lifecycle.config.leaseMs });
  });

  router.post("/jobs/:id/heartbeat", async (req, res) => {
    const jobId = parse(jobIdSchema, req.params.id, "job id");
    const { workerId, attempt } = parse(renewSchema, req.body, "lease renewal");
    const job = unwrap(
      await lifecycle.renewLease(jobId, workerId, attempt),
      jobId,
      workerId,
      attempt,
    );
    res.json({ leaseExpiresAt: job.leaseExpiresAt });
  });

  router.post("/jobs/:id/complete", async (req, res) => {
    const jobId = parse(jobIdSchema, req.params.id, "job id");
    const { workerId, attempt } = parse(completeSchema, req.body, "completion");
    const job = unwrap(
      await lifecycle.complete(jobId, workerId, attempt),
      jobId,
      workerId,
      attempt,
    );
    logInfo("job_succeeded", { requestId: req.requestId, jobId, workerId, attempt });
    res.json(job);
  });

  router.post("/jobs/:id/fail", async (req, res) => {
    const jobId = parse(jobIdSchema, req.params.id, "job id");
    const { workerId, attempt, error, retryable } = parse(failSchema, req.body, "failure report");
    const job = unwrap(
      await lifecycle.fail(jobId, workerId, attempt, error, retryable),
      jobId,
      workerId,
      attempt,
    );
    logWarn(job.status === "queued" ? "job_retry_scheduled" : "job_failed_terminally", {
      requestId: req.requestId,
      jobId,
      workerId,
      attempt,
      error,
      nextRunAt: job.status === "queued" ? job.runAt : undefined,
    });
    res.json(job);
  });

  return router;
}
