import express, { type Express } from "express";
import type { Db } from "./db/pool.js";
import { errorHandler, notFound, requestContext } from "./http/middleware.js";
import { DEFAULT_LIFECYCLE_CONFIG, JobLifecycle, type LifecycleConfig } from "./jobs/lifecycle.js";
import { JobRepository } from "./jobs/repository.js";
import { jobRoutes } from "./jobs/routes.js";
import { ScheduleRepository } from "./schedules/repository.js";
import { scheduleRoutes } from "./schedules/routes.js";
import { WorkflowRepository } from "./workflows/repository.js";
import { workflowRoutes } from "./workflows/routes.js";
import { WorkerRepository } from "./workers/repository.js";
import { workerRoutes } from "./workers/routes.js";

export function createApp(
  db: Db,
  lifecycle: JobLifecycle = new JobLifecycle(db, DEFAULT_LIFECYCLE_CONFIG),
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(express.json({ limit: "128kb" }));
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use(jobRoutes(new JobRepository(db), lifecycle));
  app.use(scheduleRoutes(new ScheduleRepository(db)));
  app.use(workflowRoutes(new WorkflowRepository(db)));
  app.use(workerRoutes(new WorkerRepository(db), lifecycle));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export type { LifecycleConfig };
