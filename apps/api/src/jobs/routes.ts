import { Router } from "express";
import { HttpError } from "../http/errors.js";
import { parse } from "../http/validate.js";
import { machineOf, type MachineAuth } from "../keys/auth.js";
import { IDEMPOTENCY_KEY_PATTERN, IdempotencyConflictError } from "./idempotency.js";
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
    const owner = { account: machineOf(req).account, requestId: req.requestId };
    const key = req.header("idempotency-key");
    if (key === undefined) {
      const job = await jobs.create(input, owner);
      res.status(201).location(`/jobs/${job.id}`).json(job);
      return;
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new HttpError(400, "validation_error", "Invalid Idempotency-Key", [
        {
          path: "Idempotency-Key",
          message: "must be 1-128 characters: letters, digits, '.', '_', ':' or '-'",
        },
      ]);
    }
    try {
      const { job, replayed } = await jobs.createIdempotent(input, owner, key);
      // A repeat answers 200 (not 201) with the job as it is NOW, and says so in a header.
      if (replayed) res.setHeader("Idempotent-Replayed", "true");
      res
        .status(replayed ? 200 : 201)
        .location(`/jobs/${job.id}`)
        .json(job);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        throw new HttpError(
          422,
          "idempotency_key_reused",
          "This Idempotency-Key was already used for a different request. Use a new key for a new job.",
        );
      }
      throw err;
    }
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
