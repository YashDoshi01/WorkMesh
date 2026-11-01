import os from "node:os";
import { logError, logInfo, logWarn, parseEnv, parseTrustProxy } from "@workmesh/shared";
import { createApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { JobLifecycle } from "./jobs/lifecycle.js";
import { LeaseReaper } from "./jobs/reaper.js";
import { Scheduler } from "./schedules/scheduler.js";
import { gracefulShutdown } from "./shutdown.js";

const env = parseEnv(process.env);
const instance = env.INSTANCE_ID ?? os.hostname();
const db = createPool(env.DATABASE_URL, env.DB_POOL_MAX);

// Several instances may start at the same moment: migrate() takes a PostgreSQL advisory lock,
// so they take turns and each migration runs exactly once.
try {
  const applied = await migrate(db);
  logInfo("migrations_applied", { instance, applied });
} catch (err) {
  logError("migration_failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const lifecycle = new JobLifecycle(db, {
  leaseMs: env.LEASE_MS,
  retryBaseMs: env.RETRY_BASE_MS,
  retryMaxMs: env.RETRY_MAX_MS,
});
// Every instance runs its own reaper and scheduler. That is safe because their correctness comes
// from the database (SKIP LOCKED, conditional updates, a unique index), not from "only one runs".
const reaper = new LeaseReaper(lifecycle, env.REAPER_INTERVAL_MS);
reaper.start();
const scheduler = new Scheduler(db, env.SCHEDULER_INTERVAL_MS);
scheduler.start();

const drain = { draining: false };
const trustProxy = parseTrustProxy(env.TRUST_PROXY);

const server = createApp(
  db,
  lifecycle,
  {
    operatorKey: env.OPERATOR_API_KEY,
    viewerKey: env.VIEWER_API_KEY,
    // Workers and customer clients must present a valid API key. Never switch this off here.
    machineAuth: true,
  },
  {
    // The header naming the instance is opt-in: an explicit INSTANCE_ID, never the hostname.
    ...(env.INSTANCE_ID ? { instanceId: env.INSTANCE_ID } : {}),
    ...(trustProxy ? { trustProxy } : {}),
    drain,
  },
).listen(env.PORT, () => {
  logInfo("api_listening", {
    instance,
    port: env.PORT,
    trustProxy: trustProxy ?? "nobody",
    dbPoolMax: env.DB_POOL_MAX,
    leaseMs: env.LEASE_MS,
    reaperIntervalMs: env.REAPER_INTERVAL_MS,
    schedulerIntervalMs: env.SCHEDULER_INTERVAL_MS,
  });
});

// A gateway keeps connections to us open and reuses them. If WE close an idle one first, the
// gateway can send its next request down a connection that is already gone and the client sees a
// 502. So our idle timeout must be LONGER than the gateway's (NGINX upstream keepalive_timeout:
// 60 s; see infra/nginx/nginx.conf), and headersTimeout longer than keepAliveTimeout.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) {
    logWarn("shutdown_repeated_signal_exiting_now", { instance, signal });
    process.exit(1);
  }
  stopping = true;
  logInfo("shutdown_started", {
    instance,
    signal,
    drainMs: env.SHUTDOWN_DRAIN_MS,
    graceMs: env.SHUTDOWN_GRACE_MS,
  });
  void gracefulShutdown({
    server,
    drain,
    drainMs: env.SHUTDOWN_DRAIN_MS,
    graceMs: env.SHUTDOWN_GRACE_MS,
    cleanup: async () => {
      await Promise.all([reaper.stop(), scheduler.stop()]);
      await db.end();
    },
  }).then(({ forced }) => {
    logInfo("shutdown_complete", { instance, connectionsCut: forced });
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
