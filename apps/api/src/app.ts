import express, { type Express } from "express";
import type { Db } from "./db/pool.js";
import { errorHandler, notFound, requestContext } from "./http/middleware.js";
import { DEFAULT_LIFECYCLE_CONFIG, JobLifecycle, type LifecycleConfig } from "./jobs/lifecycle.js";
import { JobRepository } from "./jobs/repository.js";
import { jobRoutes } from "./jobs/routes.js";
import { OpsActions } from "./ops/actions.js";
import { AuditRepository } from "./ops/audit.js";
import { Authenticator } from "./ops/auth.js";
import { OpsQueries } from "./ops/queries.js";
import { opsRoutes } from "./ops/routes.js";
import { ScheduleRepository } from "./schedules/repository.js";
import { scheduleRoutes } from "./schedules/routes.js";
import { WorkflowRepository } from "./workflows/repository.js";
import { workflowRoutes } from "./workflows/routes.js";
import { WorkerRepository } from "./workers/repository.js";
import { workerRoutes } from "./workers/routes.js";

export interface AppOptions {
  /** Keys for the operator plane (/ops/*). Without them the operator plane is not mounted. */
  operatorKey: string;
  viewerKey: string;
}

export function createApp(
  db: Db,
  lifecycle: JobLifecycle = new JobLifecycle(db, DEFAULT_LIFECYCLE_CONFIG),
  options?: AppOptions,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(express.json({ limit: "128kb" }));
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  const jobs = new JobRepository(db);
  const workflows = new WorkflowRepository(db);
  const schedules = new ScheduleRepository(db);

  // Machine plane: workers and programmatic clients. Not authenticated until Phase 8.
  app.use(jobRoutes(jobs, lifecycle));
  app.use(scheduleRoutes(schedules));
  app.use(workflowRoutes(workflows));
  app.use(workerRoutes(new WorkerRepository(db), lifecycle));

  // Operator plane: the dashboard. Every route needs an API key (see ops/routes.ts).
  if (options) {
    const audit = new AuditRepository(db);
    app.use(
      "/ops",
      opsRoutes({
        auth: new Authenticator(options),
        actions: new OpsActions(db, jobs, workflows, schedules, audit),
        audit,
        queries: new OpsQueries(db),
        jobs,
        lifecycle,
        workflows,
        schedules,
      }),
    );
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export type { LifecycleConfig };
