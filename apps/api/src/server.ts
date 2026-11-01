import { logError, logInfo, parseEnv } from "@workmesh/shared";
import { createApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { JobLifecycle } from "./jobs/lifecycle.js";
import { LeaseReaper } from "./jobs/reaper.js";
import { Scheduler } from "./schedules/scheduler.js";

const env = parseEnv(process.env);
const db = createPool(env.DATABASE_URL);

try {
  const applied = await migrate(db);
  logInfo("migrations_applied", { applied });
} catch (err) {
  logError("migration_failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const lifecycle = new JobLifecycle(db, {
  leaseMs: env.LEASE_MS,
  retryBaseMs: env.RETRY_BASE_MS,
  retryMaxMs: env.RETRY_MAX_MS,
});
const reaper = new LeaseReaper(lifecycle, env.REAPER_INTERVAL_MS);
reaper.start();
const scheduler = new Scheduler(db, env.SCHEDULER_INTERVAL_MS);
scheduler.start();

const server = createApp(db, lifecycle).listen(env.PORT, () => {
  logInfo("api_listening", {
    port: env.PORT,
    leaseMs: env.LEASE_MS,
    reaperIntervalMs: env.REAPER_INTERVAL_MS,
    schedulerIntervalMs: env.SCHEDULER_INTERVAL_MS,
  });
});

// Graceful shutdown: stop accepting connections, let in-flight requests finish,
// stop the reaper, close the pool.
function shutdown(signal: string): void {
  logInfo("shutdown_started", { signal });
  server.close(() => {
    void Promise.all([reaper.stop(), scheduler.stop()])
      .then(() => db.end())
      .then(() => process.exit(0));
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
