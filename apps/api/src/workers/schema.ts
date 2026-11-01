import { z } from "zod";
import { jobType } from "../jobs/schema.js";

export const MAX_CLAIM_BATCH = 100;

export const registerWorkerSchema = z.strictObject({
  name: z.string().min(1).max(100),
  jobTypes: z.array(jobType).min(1).max(50),
  concurrency: z.number().int().min(1).max(100),
});
export type RegisterWorkerInput = z.infer<typeof registerWorkerSchema>;

export const claimSchema = z.strictObject({
  limit: z.number().int().min(1).max(MAX_CLAIM_BATCH).default(1),
});

export const completeSchema = z.strictObject({ workerId: z.uuid() });

export const failSchema = z.strictObject({
  workerId: z.uuid(),
  error: z.string().min(1).max(4000),
});
