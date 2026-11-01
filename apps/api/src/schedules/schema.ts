import { z } from "zod";
import { jobType, MAX_PAYLOAD_BYTES } from "../jobs/schema.js";
import { describeScheduleProblem } from "./cron.js";

export const createScheduleSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    cron: z.string().min(9).max(100),
    timezone: z.string().min(1).max(64).default("UTC"),
    jobType,
    payload: z
      .record(z.string(), z.unknown())
      .default({})
      .refine((p) => Buffer.byteLength(JSON.stringify(p)) <= MAX_PAYLOAD_BYTES, {
        message: `must serialize to at most ${MAX_PAYLOAD_BYTES} bytes`,
      }),
    priority: z.number().int().min(0).max(100).default(0),
    maxAttempts: z.number().int().min(1).max(20).default(3),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    const problem = describeScheduleProblem(value.cron, value.timezone);
    if (problem) ctx.addIssue({ code: "custom", path: ["cron"], message: problem });
  });
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

export const patchScheduleSchema = z.strictObject({ enabled: z.boolean() });

export const listSchedulesQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
