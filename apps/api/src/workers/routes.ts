import { Router, type Request } from "express";
import { logInfo, logWarn } from "@workmesh/shared";
import { HttpError } from "../http/errors.js";
import { parse } from "../http/validate.js";
import type { JobLifecycle } from "../jobs/lifecycle.js";
import type { FinishResult } from "../jobs/repository.js";
import { jobIdSchema } from "../jobs/schema.js";
import { machineOf, type MachineAuth } from "../keys/auth.js";
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

/**
 * The worker protocol: register, heartbeat, claim, renew lease, complete, fail.
 *
 * Every route needs a `worker` key. On top of the job-level fencing (worker id + attempt number),
 * a worker id is bound to the key that registered it: knowing someone else's worker id is not
 * enough to heartbeat, claim for, or report for that worker. A worker also only ever receives
 * jobs of its own key's account, and only of the job types its key allows.
 */
export function workerRoutes(
  workers: WorkerRepository,
  lifecycle: JobLifecycle,
  auth: MachineAuth,
): Router {
  const router = Router();
  const worker = auth.require("worker");

  /** For reports about a job: the worker id in the body must belong to the calling key. */
  const assertOwnWorker = async (req: Request, workerId: string): Promise<void> => {
    const caller = machineOf(req);
    if (caller.keyId === null) return; // authentication switched off (tests only)
    if (!(await workers.isOwnedBy(workerId, caller.keyId))) {
      logWarn("worker_not_owned_by_key", {
        requestId: req.requestId,
        workerId,
        actor: caller.actor,
      });
      throw new HttpError(
        403,
        "worker_not_yours",
        `Worker ${workerId} was not registered with this API key`,
      );
    }
  };

  router.post("/workers", worker, async (req, res) => {
    const caller = machineOf(req);
    const input = parse(registerWorkerSchema, req.body, "worker");
    if (caller.jobTypes) {
      const allowed = new Set(caller.jobTypes);
      const refused = input.jobTypes.filter((t) => !allowed.has(t));
      if (refused.length > 0) {
        throw new HttpError(
          403,
          "job_type_not_allowed",
          `This API key may not handle job type(s): ${refused.join(", ")}`,
        );
      }
    }
    const registered = await workers.register(input, {
      account: caller.account,
      apiKeyId: caller.keyId,
    });
    logInfo("worker_registered", {
      requestId: req.requestId,
      workerId: registered.id,
      name: registered.name,
      jobTypes: registered.jobTypes,
      concurrency: registered.concurrency,
      account: registered.account,
      actor: caller.actor,
    });
    res.status(201).location(`/workers/${registered.id}`).json(registered);
  });

  router.post("/workers/:id/heartbeat", worker, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "worker id");
    const found = await workers.heartbeat(id, machineOf(req).keyId);
    if (!found) throw new HttpError(404, "worker_not_found", `Worker ${id} is not registered`);
    res.json({ lastHeartbeatAt: found.lastHeartbeatAt });
  });

  router.post("/workers/:id/claim", worker, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "worker id");
    const { limit } = parse(claimSchema, req.body ?? {}, "claim request");
    // Claiming also proves the worker is alive, so it doubles as a heartbeat. The lookup is
    // bound to the calling key: someone else's worker id answers exactly like an unknown one.
    const found = await workers.heartbeat(id, machineOf(req).keyId);
    if (!found) throw new HttpError(404, "worker_not_found", `Worker ${id} is not registered`);
    const claimed = await lifecycle.claim(id, found.jobTypes, limit, found.account);
    for (const job of claimed) {
      logInfo("job_claimed", {
        requestId: req.requestId,
        jobId: job.id,
        type: job.type,
        workerId: id,
        attempt: job.attemptCount,
        leaseExpiresAt: job.leaseExpiresAt,
        // Lets one search find a job's whole life: the request that enqueued it, then its attempts.
        enqueuedByRequest: job.requestId,
      });
    }
    // leaseMs tells the SDK how often it must renew.
    res.json({ jobs: claimed, leaseMs: lifecycle.config.leaseMs });
  });

  router.post("/jobs/:id/heartbeat", worker, async (req, res) => {
    const jobId = parse(jobIdSchema, req.params.id, "job id");
    const { workerId, attempt } = parse(renewSchema, req.body, "lease renewal");
    await assertOwnWorker(req, workerId);
    const job = unwrap(
      await lifecycle.renewLease(jobId, workerId, attempt),
      jobId,
      workerId,
      attempt,
    );
    res.json({ leaseExpiresAt: job.leaseExpiresAt });
  });

  router.post("/jobs/:id/complete", worker, async (req, res) => {
    const jobId = parse(jobIdSchema, req.params.id, "job id");
    const { workerId, attempt } = parse(completeSchema, req.body, "completion");
    await assertOwnWorker(req, workerId);
    const job = unwrap(
      await lifecycle.complete(jobId, workerId, attempt),
      jobId,
      workerId,
      attempt,
    );
    logInfo("job_succeeded", {
      requestId: req.requestId,
      jobId,
      workerId,
      attempt,
      enqueuedByRequest: job.requestId,
    });
    res.json(job);
  });

  router.post("/jobs/:id/fail", worker, async (req, res) => {
    const jobId = parse(jobIdSchema, req.params.id, "job id");
    const { workerId, attempt, error, retryable } = parse(failSchema, req.body, "failure report");
    await assertOwnWorker(req, workerId);
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
      enqueuedByRequest: job.requestId,
      nextRunAt: job.status === "queued" ? job.runAt : undefined,
    });
    res.json(job);
  });

  return router;
}
