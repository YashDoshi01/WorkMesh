import { Router } from "express";
import { logInfo } from "@workmesh/shared";
import { HttpError } from "../http/errors.js";
import { parse } from "../http/validate.js";
import { jobIdSchema } from "../jobs/schema.js";
import type { WorkflowRepository } from "./repository.js";
import { createWorkflowSchema, listWorkflowsQuerySchema } from "./schema.js";

export function workflowRoutes(workflows: WorkflowRepository): Router {
  const router = Router();

  router.post("/workflows", async (req, res) => {
    const input = parse(createWorkflowSchema, req.body, "workflow");
    const workflow = await workflows.create(input);
    logInfo("workflow_created", {
      requestId: req.requestId,
      workflowId: workflow.id,
      nodes: workflow.progress.total,
    });
    res.status(201).location(`/workflows/${workflow.id}`).json(workflow);
  });

  router.get("/workflows", async (req, res) => {
    const query = parse(listWorkflowsQuerySchema, req.query, "query parameters");
    res.json({ items: await workflows.list(query) });
  });

  router.get("/workflows/:id", async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "workflow id");
    const workflow = await workflows.findById(id);
    if (!workflow) throw new HttpError(404, "workflow_not_found", `Workflow ${id} does not exist`);
    res.json(workflow);
  });

  router.post("/workflows/:id/cancel", async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "workflow id");
    const result = await workflows.cancel(id);
    if (result.outcome === "not_found") {
      throw new HttpError(404, "workflow_not_found", `Workflow ${id} does not exist`);
    }
    if (result.outcome === "finished") {
      throw new HttpError(
        409,
        "workflow_finished",
        `Workflow ${id} already finished as ${result.status}; nothing to cancel`,
      );
    }
    res.json(result.workflow);
  });

  return router;
}
