import { z } from "zod";

// These mirror the operator-plane responses. They are checked at RUNTIME: a TypeScript type
// disappears when the code runs in the browser, so without this a reply of an unexpected shape
// would crash a component instead of becoming an error message.

const iso = z.string();
const nullableIso = z.string().nullable();

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: jobStatusSchema,
  priority: z.number(),
  runAt: iso,
  scheduledFor: iso,
  scheduleId: z.string().nullable(),
  workflowId: z.string().nullable(),
  attemptCount: z.number(),
  maxAttempts: z.number(),
  leaseExpiresAt: nullableIso,
  claimedBy: z.string().nullable(),
  startedAt: nullableIso,
  finishedAt: nullableIso,
  lastError: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export type Job = z.infer<typeof jobSchema>;

export const jobPageSchema = z.object({
  items: z.array(jobSchema),
  nextCursor: z.string().nullable(),
});
export type JobPage = z.infer<typeof jobPageSchema>;

export const attemptSchema = z.object({
  attemptNumber: z.number(),
  workerId: z.string(),
  outcome: z.enum(["running", "succeeded", "failed", "lease_expired"]),
  error: z.string().nullable(),
  startedAt: iso,
  finishedAt: nullableIso,
});
export type Attempt = z.infer<typeof attemptSchema>;
export const attemptsSchema = z.object({ items: z.array(attemptSchema) });

const progressSchema = z.object({
  total: z.number(),
  waiting: z.number(),
  queued: z.number(),
  running: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  cancelled: z.number(),
  skipped: z.number(),
});
export type Progress = z.infer<typeof progressSchema>;

export const NODE_STATES = [
  "waiting",
  "skipped",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const workflowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  cancelRequested: z.boolean(),
  createdAt: iso,
  finishedAt: nullableIso,
  progress: progressSchema,
});
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;
export const workflowListSchema = z.object({ items: z.array(workflowSummarySchema) });

export const workflowDetailSchema = workflowSummarySchema.extend({
  nodes: z.array(
    z.object({
      key: z.string(),
      type: z.string(),
      state: z.enum(NODE_STATES),
      dependsOn: z.array(z.string()),
      jobId: z.string().nullable(),
      attemptCount: z.number().nullable(),
      lastError: z.string().nullable(),
    }),
  ),
});
export type WorkflowDetail = z.infer<typeof workflowDetailSchema>;

export const scheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  jobType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  priority: z.number(),
  maxAttempts: z.number(),
  enabled: z.boolean(),
  lastError: z.string().nullable(),
  nextRunAt: iso,
  lastRunAt: nullableIso,
  createdAt: iso,
  updatedAt: iso,
});
export type Schedule = z.infer<typeof scheduleSchema>;
export const scheduleListSchema = z.object({ items: z.array(scheduleSchema) });

export const workerSchema = z.object({
  id: z.string(),
  name: z.string(),
  jobTypes: z.array(z.string()),
  concurrency: z.number(),
  registeredAt: iso,
  lastHeartbeatAt: iso,
  lastHeartbeatAgeSeconds: z.number(),
  health: z.enum(["alive", "stale"]),
  runningJobs: z.number(),
});
export type Worker = z.infer<typeof workerSchema>;
export const workerListSchema = z.object({
  staleAfterMs: z.number(),
  items: z.array(workerSchema),
});
export type WorkerList = z.infer<typeof workerListSchema>;

const distributionSchema = z
  .object({ p50: z.number(), p95: z.number(), max: z.number() })
  .nullable();

export const statsSchema = z.object({
  generatedAt: iso,
  windowMinutes: z.number(),
  bucketMinutes: z.number(),
  queue: z.object({
    queued: z.number(),
    ready: z.number(),
    scheduled: z.number(),
    running: z.number(),
    oldestReadyAgeSeconds: z.number().nullable(),
  }),
  window: z.object({
    succeeded: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    retries: z.number(),
    leaseExpirations: z.number(),
    throughputPerMinute: z.number(),
    executionSeconds: distributionSchema,
    waitSeconds: distributionSchema,
  }),
  series: z.array(z.object({ start: iso, succeeded: z.number(), failed: z.number() })),
  workers: z.object({ alive: z.number(), stale: z.number() }),
});
export type Stats = z.infer<typeof statsSchema>;

export const auditEntrySchema = z.object({
  id: z.string(),
  at: iso,
  actor: z.string(),
  role: z.enum(["viewer", "operator", "admin"]),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  details: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
  clientIp: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditPageSchema = z.object({
  items: z.array(auditEntrySchema),
  nextBefore: z.string().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

export const roleSchema = z.enum(["admin", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const memberSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  createdAt: iso,
  lastLoginAt: nullableIso,
});
export type Member = z.infer<typeof memberSchema>;
export const memberListSchema = z.object({ items: z.array(memberSchema) });

/** Who is signed in, and which organisation they belong to. */
export const meSchema = z.object({
  user: memberSchema,
  account: z.object({ slug: z.string(), name: z.string() }),
});
export type Me = z.infer<typeof meSchema>;

export const keySchema = z.object({
  id: z.string(),
  prefix: z.string(),
  kind: z.enum(["client", "worker"]),
  account: z.string(),
  name: z.string(),
  jobTypes: z.array(z.string()).nullable(),
  createdAt: iso,
  createdBy: z.string(),
  expiresAt: nullableIso,
  revokedAt: nullableIso,
  revokedBy: z.string().nullable(),
  lastUsedAt: nullableIso,
  status: z.enum(["active", "revoked", "expired"]),
});
export type ApiKey = z.infer<typeof keySchema>;
export const keyListSchema = z.object({ items: z.array(keySchema) });
/** Returned once, when a key is created: the only time its secret is ever shown. */
export const createdKeySchema = keySchema.extend({ secret: z.string() });
export type CreatedKey = z.infer<typeof createdKeySchema>;

export const inviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  invitedBy: z.string().nullable(),
  createdAt: iso,
  expiresAt: iso,
  status: z.enum(["open", "accepted", "revoked", "expired"]),
});
export type Invite = z.infer<typeof inviteSchema>;
export const inviteListSchema = z.object({ items: z.array(inviteSchema) });
export const createdInviteSchema = inviteSchema.extend({ token: z.string() });
export type CreatedInvite = z.infer<typeof createdInviteSchema>;
export const inviteInfoSchema = z.object({
  email: z.string(),
  role: roleSchema,
  accountName: z.string(),
});
export type InviteInfo = z.infer<typeof inviteInfoSchema>;

export const okSchema = z.object({ ok: z.boolean() });
/** The answer to "who am I?": the identity, or null for a visitor. */
export const sessionSchema = z.object({ me: meSchema.nullable() });
