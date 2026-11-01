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

/** How long /readyz waits for the database before saying "not ready". */
const READINESS_TIMEOUT_MS = 2000;

export interface RuntimeOptions {
  /** Names this instance in logs and in the X-Served-By response header. */
  instanceId?: string;
  /**
   * Addresses allowed to set X-Forwarded-For (already validated; see TRUST_PROXY). Unset = trust
   * nobody: req.ip is then always the socket's peer and the header is ignored.
   */
  trustProxy?: string[];
  /** Flipped to `draining: true` by the shutdown sequence. */
  drain?: { draining: boolean };
}

export function createApp(
  db: Db,
  lifecycle: JobLifecycle = new JobLifecycle(db, DEFAULT_LIFECYCLE_CONFIG),
  options?: AppOptions,
  runtime: RuntimeOptions = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  if (runtime.trustProxy) app.set("trust proxy", runtime.trustProxy);
  app.use(requestContext(runtime.instanceId));
  // While shutting down, tell the peer not to reuse this connection (a gateway keeps upstream
  // connections open and would otherwise send its next request down one we are about to close).
  app.use((_req, res, next) => {
    if (runtime.drain?.draining) res.setHeader("Connection", "close");
    next();
  });
  app.use(express.json({ limit: "128kb" }));
  // Liveness: "the process is up and answering". Deliberately does NOT touch the database: if
  // the database is down, restarting every API instance would not help.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  // Readiness: "send me traffic". False while draining or if the database does not answer in
  // time. The body says why in one word and never includes error text or connection details.
  app.get("/readyz", async (_req, res) => {
    if (runtime.drain?.draining) {
      res.status(503).json({ status: "unavailable", reason: "draining" });
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        db.query("SELECT 1"),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), READINESS_TIMEOUT_MS);
        }),
      ]);
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable", reason: "database" });
    } finally {
      clearTimeout(timer);
    }
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
