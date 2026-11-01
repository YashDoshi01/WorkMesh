import { Router } from "express";
import { HttpError } from "../http/errors.js";
import { parse } from "../http/validate.js";
import type { JobLifecycle } from "./lifecycle.js";
import { InvalidCursorError, type JobRepository } from "./repository.js";
import { createJobSchema, jobIdSchema, listJobsQuerySchema } from "./schema.js";

export function jobRoutes(jobs: JobRepository, lifecycle: JobLifecycle): Router {
  const router = Router();

  router.post("/jobs", async (req, res) => {
    const input = parse(createJobSchema, req.body, "job");
    const job = await jobs.create(input);
    res.status(201).location(`/jobs/${job.id}`).json(job);
  });

  router.get("/jobs/:id", async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    const job = await jobs.findById(id);
    if (!job) throw new HttpError(404, "job_not_found", `Job ${id} does not exist`);
    res.json(job);
  });

  // The audit trail: one entry per execution attempt, oldest first.
  router.get("/jobs/:id/attempts", async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    const attempts = await lifecycle.attempts(id);
    if (!attempts) throw new HttpError(404, "job_not_found", `Job ${id} does not exist`);
    res.json({ items: attempts });
  });

  router.get("/jobs", async (req, res) => {
    const query = parse(listJobsQuerySchema, req.query, "query parameters");
    try {
      res.json(await jobs.list(query));
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
