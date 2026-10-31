import express, { type Express } from "express";
import type { Db } from "./db/pool.js";
import { errorHandler, notFound, requestContext } from "./http/middleware.js";
import { JobRepository } from "./jobs/repository.js";
import { jobRoutes } from "./jobs/routes.js";

export function createApp(db: Db): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(express.json({ limit: "128kb" }));
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use(jobRoutes(new JobRepository(db)));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
