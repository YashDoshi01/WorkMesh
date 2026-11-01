import { Router } from "express";
import { logInfo, logWarn } from "@workmesh/shared";
import { HttpError } from "../http/errors.js";
import { parse } from "../http/validate.js";
import type { FinishResult, JobRepository } from "../jobs/repository.js";
import { jobIdSchema } from "../jobs/schema.js";
import type { WorkerRepository } from "./repository.js";
import { claimSchema, completeSchema, failSchema, registerWorkerSchema } from "./schema.js";

function unwrap(result: FinishResult, jobId: string, workerId: string) {
  if (result.outcome === "ok") return result.job;
  if (result.outcome === "not_found") {
    throw new HttpError(404, "job_not_found", `Job ${jobId} does not exist`);
  }
  throw new HttpError(409, "job_not_owned", `Job ${jobId} is not running under worker ${workerId}`);
}

/** The worker protocol: register, heartbeat, claim, complete, fail. */
export function workerRoutes(workers: WorkerRepository, jobs: JobRepository): Router {
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
    const claimed = await jobs.claim(id, worker.jobTypes, limit);
    for (const job of claimed) {
      logInfo("job_claimed", {
        requestId: req.requestId,
        jobId: job.id,
        type: job.type,
        workerId: id,
        attempt: job.attemptCount,
      });
    }
    res.json({ jobs: claimed });
  });

  router.post("/jobs/:id/complete", async (req, res) => {
    const jobId = parse(jobIdSchema, req.params.id, "job id");
    const { workerId } = parse(completeSchema, req.body, "completion");
    const job = unwrap(await jobs.complete(jobId, workerId), jobId, workerId);
    logInfo("job_succeeded", { requestId: req.requestId, jobId, workerId });
    res.json(job);
  });

  router.post("/jobs/:id/fail", async (req, res) => {
    const jobId = parse(jobIdSchema, req.params.id, "job id");
    const { workerId, error } = parse(failSchema, req.body, "failure report");
    const job = unwrap(await jobs.fail(jobId, workerId, error), jobId, workerId);
    logWarn("job_failed", { requestId: req.requestId, jobId, workerId, error });
    res.json(job);
  });

  return router;
}
