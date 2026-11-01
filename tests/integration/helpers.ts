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
  type AppOptions,
  type LifecycleConfig,
  type RuntimeOptions,
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
  await db.query("TRUNCATE jobs, workers, schedules, workflows, audit_log, api_keys CASCADE");
}

/** Operator-plane keys used by the tests. */
export const OPERATOR_KEY = "test-operator-key-0123456789";
export const VIEWER_KEY = "test-viewer-key-abcdefghij";
/** Operator plane on, machine plane OPEN: what the pre-Phase-8 suites were written against. */
export const TEST_AUTH: AppOptions = {
  operatorKey: OPERATOR_KEY,
  viewerKey: VIEWER_KEY,
  machineAuth: false,
};

/** Everything on, as in production: the machine plane needs API keys. */
export const SECURE_AUTH: AppOptions = { ...TEST_AUTH, machineAuth: true };

export interface Started {
  server: Server;
  url: string;
}

export function lifecycleFor(db: Db, config: Partial<LifecycleConfig> = {}): JobLifecycle {
  return new JobLifecycle(db, { ...DEFAULT_LIFECYCLE_CONFIG, ...config });
}

export function startApi(
  db: Db,
  config: Partial<LifecycleConfig> = {},
  /** Pass `null` for an app WITHOUT the operator plane (undefined would select the default keys). */
  options: AppOptions | null = TEST_AUTH,
  runtime: RuntimeOptions = {},
): Promise<Started> {
  return new Promise((resolve) => {
    const server = createApp(db, lifecycleFor(db, config), options ?? undefined, runtime).listen(
      0,
      () => {
        resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      },
    );
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
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  // JSON for the API's own responses; anything else (the Prometheus text format) comes back as text.
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return {
    status: res.status,
    body: text ? (isJson ? JSON.parse(text) : text) : undefined,
    headers: res.headers,
  };
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

/** A connection string for another database on the same server (the tests' own scratch databases). */
export function databaseUrlFor(name: string): string {
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Runs one statement against the server's default database (CREATE/DROP DATABASE need it). */
export async function adminQuery(sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}
