import { z } from "zod";
import { parseTrustProxy } from "./trustProxy.js";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    // How long a claimed job stays owned without a renewal (heartbeat) before it can be recovered.
    LEASE_MS: z.coerce.number().int().min(1000).max(3_600_000).default(30_000),
    // Retry delay = min(RETRY_MAX_MS, RETRY_BASE_MS * 2^(attempt-1)), with jitter.
    RETRY_BASE_MS: z.coerce.number().int().min(1).max(3_600_000).default(1000),
    RETRY_MAX_MS: z.coerce.number().int().min(1).max(86_400_000).default(300_000),
    // How often each API instance sweeps for expired leases.
    REAPER_INTERVAL_MS: z.coerce.number().int().min(100).max(600_000).default(5000),
    // How often each API instance checks for recurring schedules that are due.
    SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
    // Names this API instance (logs, and the X-Served-By response header when set). Useful to prove
    // which instance answered when several run behind a load balancer.
    INSTANCE_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/, "INSTANCE_ID must be 1-64 of letters, digits, '.', '_', '-'")
      .optional(),
    // Which proxy addresses may set X-Forwarded-For (see packages/shared/src/trustProxy.ts).
    TRUST_PROXY: z.string().optional(),
    // On SIGTERM: report "not ready" for this long while still serving, so a load balancer can stop
    // choosing this instance; then stop accepting connections and finish in-flight requests.
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(3000),
    // Hard deadline for in-flight requests after the drain; remaining connections are then closed.
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
    // Connections this instance may hold to PostgreSQL. N instances hold N times this many.
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    // Customer sign-in (Phase 10). How long a login stays valid, in hours.
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    // May anyone create a new organisation? "false" makes the deployment invitation-only.
    PUBLIC_SIGNUP: z.enum(["true", "false"]).default("true"),
    // Send the session cookie with the Secure flag. It MUST be "true" once the site is served over
    // HTTPS; browsers do not send Secure cookies over plain http, so the default for local use is false.
    COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
    // Operator API keys for the dashboard / operator plane (/ops/*). There are deliberately NO
    // defaults: a server that silently falls back to a known key is worse than one that refuses
    // to start. `viewer` can read; `operator` can read and change things.
    OPERATOR_API_KEY: z
      .string()
      .min(16, "OPERATOR_API_KEY must be at least 16 characters")
      .max(200),
    VIEWER_API_KEY: z.string().min(16, "VIEWER_API_KEY must be at least 16 characters").max(200),
  })
  .superRefine((env, ctx) => {
    try {
      parseTrustProxy(env.TRUST_PROXY);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        path: ["TRUST_PROXY"],
        message: err instanceof Error ? err.message : "invalid TRUST_PROXY",
      });
    }
    if (env.OPERATOR_API_KEY === env.VIEWER_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["VIEWER_API_KEY"],
        message:
          "VIEWER_API_KEY must differ from OPERATOR_API_KEY (otherwise viewers would be operators)",
      });
    }
    if (env.NODE_ENV === "production") {
      for (const name of ["OPERATOR_API_KEY", "VIEWER_API_KEY"] as const) {
        if (/change-?me/i.test(env[name])) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: `${name} still looks like the placeholder from .env.example; generate a real one`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  return envSchema.parse(source);
}
