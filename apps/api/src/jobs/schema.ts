import { z } from "zod";

export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Lowercase dotted/dashed identifier; mirrors the CHECK constraint in the migration. */
export const jobType = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,99}$/,
    "must be 1-100 chars: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit",
  );

export const createJobSchema = z.strictObject({
  type: jobType,
  payload: z
    .record(z.string(), z.unknown())
    .refine((p) => Buffer.byteLength(JSON.stringify(p)) <= MAX_PAYLOAD_BYTES, {
      message: `must serialize to at most ${MAX_PAYLOAD_BYTES} bytes`,
    }),
  priority: z.number().int().min(0).max(100).default(0),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  runAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const listJobsQuerySchema = z.strictObject({
  status: z.enum(JOB_STATUSES).optional(),
  type: jobType.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const jobIdSchema = z.uuid();
