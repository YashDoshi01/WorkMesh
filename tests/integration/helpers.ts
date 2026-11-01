import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import {
  createApp,
  createPool,
  DEFAULT_LIFECYCLE_CONFIG,
  JobLifecycle,
  migrate,
  type Db,
  type LifecycleConfig,
} from "@workmesh/api";

// Real PostgreSQL, never a mock. A dedicated database keeps tests away from dev data.
const baseUrl = process.env.DATABASE_URL ?? "postgres://workmesh:workmesh@localhost:5432/workmesh";
const TEST_DB = "workmesh_test";

export const testDatabaseUrl = ((): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
})();

export async function setupTestDb(): Promise<Db> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DB]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  const db = createPool(testDatabaseUrl);
  await migrate(db);
  return db;
}

export async function resetTables(db: Db): Promise<void> {
  await db.query("TRUNCATE jobs, workers, schedules CASCADE");
}

export interface Started {
  server: Server;
  url: string;
}

export function lifecycleFor(db: Db, config: Partial<LifecycleConfig> = {}): JobLifecycle {
  return new JobLifecycle(db, { ...DEFAULT_LIFECYCLE_CONFIG, ...config });
}

export function startApi(db: Db, config: Partial<LifecycleConfig> = {}): Promise<Started> {
  return new Promise((resolve) => {
    const server = createApp(db, lifecycleFor(db, config)).listen(0, () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

export function stopApi(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function api(
  base: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
