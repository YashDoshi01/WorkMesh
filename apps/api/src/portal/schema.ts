import { z } from "zod";
import { jobType } from "../jobs/schema.js";
import { PASSWORD_MAX } from "./passwords.js";

const email = z.string().trim().max(254).pipe(z.email());
const person = z.string().trim().min(1).max(100);
// Length is checked here (to bound the work a request can cause); strength is checked in passwordProblem.
const password = z.string().min(1).max(PASSWORD_MAX);

export const signupSchema = z.strictObject({
  orgName: person,
  name: person,
  email,
  password,
});

export const loginSchema = z.strictObject({ email, password });

export const acceptInviteSchema = z.strictObject({
  token: z.string().min(20).max(100),
  name: person,
  password,
});

export const inviteTokenSchema = z.strictObject({ token: z.string().min(20).max(100) });

export const changePasswordSchema = z.strictObject({
  currentPassword: password,
  newPassword: password,
});

export const createInviteSchema = z.strictObject({
  email,
  role: z.enum(["admin", "viewer"]),
});

export const changeRoleSchema = z.strictObject({ role: z.enum(["admin", "viewer"]) });

/** The account comes from the signed-in user, never from the request. */
export const createAppKeySchema = z
  .strictObject({
    kind: z.enum(["client", "worker"]),
    name: person,
    jobTypes: z.array(jobType).min(1).max(50).optional(),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  })
  .refine((k) => k.kind === "worker" || k.jobTypes === undefined, {
    message: "jobTypes only applies to worker keys",
    path: ["jobTypes"],
  });

export const overviewQuerySchema = z.strictObject({
  windowMinutes: z.coerce.number().int().min(1).max(1440).default(60),
});
export const workersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const auditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z
    .string()
    .regex(/^\d{1,18}$/, "must be an audit entry id")
    .optional(),
});
export const retryBodySchema = z.strictObject({
  attempts: z.number().int().min(1).max(20).default(1),
});
