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

// `attempt` is the fencing token: the attemptCount the worker received when it claimed the job.
const ownership = { workerId: z.uuid(), attempt: z.number().int().min(1) };

export const completeSchema = z.strictObject(ownership);
export const renewSchema = z.strictObject(ownership);

export const failSchema = z.strictObject({
  ...ownership,
  error: z.string().min(1).max(4000),
  // false = permanent failure: do not retry even if attempts remain.
  retryable: z.boolean().default(true),
});
