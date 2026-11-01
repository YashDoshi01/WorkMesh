import { z } from "zod";
import { jobType } from "../jobs/schema.js";

/** An account is a label that groups what belongs together; mirrors the CHECK constraints. */
export const accountSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,49}$/,
    "must be 1-50 chars: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit",
  );

export const createKeySchema = z
  .strictObject({
    kind: z.enum(["client", "worker"]),
    account: accountSchema.default("default"),
    name: z.string().min(1).max(100),
    /** Worker keys only: the job types the key may handle. Omit for any type in its account. */
    jobTypes: z.array(jobType).min(1).max(50).optional(),
    /** The key stops working after this many days. Omit for no expiry. */
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  })
  .refine((k) => k.kind === "worker" || k.jobTypes === undefined, {
    message: "jobTypes only applies to worker keys",
    path: ["jobTypes"],
  });
export type CreateKeyInput = z.infer<typeof createKeySchema>;
