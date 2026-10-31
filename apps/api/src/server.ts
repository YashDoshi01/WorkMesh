import { logError, logInfo, parseEnv } from "@workmesh/shared";
import { createApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";

const env = parseEnv(process.env);
const db = createPool(env.DATABASE_URL);

try {
  const applied = await migrate(db);
  logInfo("migrations_applied", { applied });
} catch (err) {
  logError("migration_failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const server = createApp(db).listen(env.PORT, () => {
  logInfo("api_listening", { port: env.PORT });
});

// Graceful shutdown: stop accepting connections, let in-flight requests finish, close the pool.
function shutdown(signal: string): void {
  logInfo("shutdown_started", { signal });
  server.close(() => {
    void db.end().then(() => process.exit(0));
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
