import { z } from "zod";
import { jobType, MAX_PAYLOAD_BYTES } from "../jobs/schema.js";
import { analyzeGraph, validateDefinition } from "./graph.js";

export const MAX_NODES = 100;
export const MAX_DEPENDENCIES_PER_NODE = 20;
export const MAX_EDGES = 500;

const nodeKey = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,49}$/,
    "must be 1-50 chars: lowercase letters, digits, '_' or '-', starting with a letter or digit",
  );

const nodeSchema = z.strictObject({
  key: nodeKey,
  type: jobType,
  payload: z
    .record(z.string(), z.unknown())
    .default({})
    .refine((p) => Buffer.byteLength(JSON.stringify(p)) <= MAX_PAYLOAD_BYTES, {
      message: `must serialize to at most ${MAX_PAYLOAD_BYTES} bytes`,
    }),
  priority: z.number().int().min(0).max(100).default(0),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  dependsOn: z.array(nodeKey).max(MAX_DEPENDENCIES_PER_NODE).default([]),
});

export const createWorkflowSchema = z
  .strictObject({
    name: z.string().trim().max(200).default(""),
    nodes: z.array(nodeSchema).min(1).max(MAX_NODES),
  })
  .superRefine((value, ctx) => {
    const edges = value.nodes.reduce((sum, n) => sum + n.dependsOn.length, 0);
    if (edges > MAX_EDGES) {
      ctx.addIssue({
        code: "custom",
        path: ["nodes"],
        message: `at most ${MAX_EDGES} dependencies in total (got ${edges})`,
      });
      return;
    }
    const structural = validateDefinition(value.nodes);
    for (const issue of structural) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
    if (structural.length > 0) return; // cycle analysis needs a structurally sound graph
    const analysis = analyzeGraph(value.nodes);
    if (!analysis.ok) {
      ctx.addIssue({
        code: "custom",
        path: ["nodes"],
        message: `dependency cycle: ${analysis.cycle.join(" -> ")} (each node depends on the next)`,
      });
    }
  });
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

export const WORKFLOW_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;

export const listWorkflowsQuerySchema = z.strictObject({
  status: z.enum(WORKFLOW_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
