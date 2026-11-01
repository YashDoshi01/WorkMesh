import { z } from "zod";

export const envSchema = z.object({
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
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  return envSchema.parse(source);
}
