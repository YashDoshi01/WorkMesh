import { Router } from "express";
import { HttpError } from "../http/errors.js";
import { parse } from "../http/validate.js";
import { machineOf, type MachineAuth } from "../keys/auth.js";
import type { JobLifecycle } from "./lifecycle.js";
import { InvalidCursorError, type JobRepository } from "./repository.js";
import { createJobSchema, jobIdSchema, listJobsQuerySchema } from "./schema.js";

/**
 * Customer-facing job routes. They need a `client` key, and a client only ever sees its own
 * account's jobs. A job in another account answers exactly like a job that does not exist (404),
 * so ids cannot be probed for existence.
 */
export function jobRoutes(jobs: JobRepository, lifecycle: JobLifecycle, auth: MachineAuth): Router {
  const router = Router();
  const client = auth.require("client");

  router.post("/jobs", client, async (req, res) => {
    const input = parse(createJobSchema, req.body, "job");
    const job = await jobs.create(input, {
      account: machineOf(req).account,
      requestId: req.requestId,
    });
    res.status(201).location(`/jobs/${job.id}`).json(job);
  });

  router.get("/jobs/:id", client, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    const job = await jobs.findById(id);
    if (!job || job.account !== machineOf(req).account) {
      throw new HttpError(404, "job_not_found", `Job ${id} does not exist`);
    }
    res.json(job);
  });

  // The audit trail: one entry per execution attempt, oldest first.
  router.get("/jobs/:id/attempts", client, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    const job = await jobs.findById(id);
    if (!job || job.account !== machineOf(req).account) {
      throw new HttpError(404, "job_not_found", `Job ${id} does not exist`);
    }
    const attempts = await lifecycle.attempts(id);
    if (!attempts) throw new HttpError(404, "job_not_found", `Job ${id} does not exist`);
    res.json({ items: attempts });
  });

  router.get("/jobs", client, async (req, res) => {
    const query = parse(listJobsQuerySchema, req.query, "query parameters");
    try {
      res.json(await jobs.list({ ...query, account: machineOf(req).account }));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        throw new HttpError(400, "validation_error", "Invalid query parameters", [
          { path: "cursor", message: err.message },
        ]);
      }
      throw err;
    }
  });

  return router;
}
