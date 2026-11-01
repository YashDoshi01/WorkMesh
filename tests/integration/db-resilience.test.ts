import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPool, withTransaction, type Db } from "@workmesh/api";
import { api, setupTestDb, startApi, stopApi, testDatabaseUrl } from "./helpers.js";

// Regression test for a bug found by the Phase 9 database-outage experiment: when PostgreSQL
// dropped connections, the pool emitted an `error` event nobody listened to, Node treated it as
// fatal, and every API instance exited. `pg_terminate_backend` reproduces what a database
// restart does to the connections, without stopping the shared test database.

const APP = "wm-resilience-test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the connection pool survives the database dropping connections", () => {
  let admin: Db;

  before(async () => {
    admin = await setupTestDb();
  });
  after(() => admin.end());

  const terminateOurBackends = () =>
    admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
      [APP],
    );

  const poolUnderTest = () => {
    const url = new URL(testDatabaseUrl);
    url.searchParams.set("application_name", APP);
    return createPool(url.toString(), 5);
  };

  it("idle connections that are terminated do not crash the process, and the pool recovers", async () => {
    const pool = poolUnderTest();
    try {
      // Several idle connections now sit in the pool.
      await Promise.all(Array.from({ length: 5 }, () => pool.query("SELECT pg_sleep(0.05)")));
      const killed = await terminateOurBackends();
      assert.ok((killed.rowCount ?? 0) >= 1, "there were connections to terminate");
      await sleep(300); // the 'error' events arrive here; unhandled, they would end this process
      assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1, "the next query works");
    } finally {
      await pool.end();
    }
  });

  it("a connection terminated in the middle of a transaction fails that transaction, not the process", async () => {
    const pool = poolUnderTest();
    try {
      await assert.rejects(
        withTransaction(pool, async (tx) => {
          await tx.query("SELECT 1");
          await terminateOurBackends();
          await sleep(200);
          await tx.query("SELECT 2");
        }),
      );
      assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1, "and the pool still works");
    } finally {
      await pool.end();
    }
  });
});

describe("when the database cannot be reached", () => {
  it("a request fails fast with 503 and Retry-After (not a slow 500)", async () => {
    // Nothing listens on port 1, like a database that is down.
    const dead = createPool("postgres://workmesh:workmesh@127.0.0.1:1/none", 2);
    const app = await startApi(dead, {}, null);
    try {
      const started = Date.now();
      const r = await api(app.url, "GET", "/jobs");
      assert.equal(r.status, 503);
      assert.equal(r.body.error.code, "database_unavailable");
      assert.equal(r.headers.get("retry-after"), "5");
      assert.ok(r.body.error.requestId, "still carries the request id");
      assert.ok(!JSON.stringify(r.body).includes("127.0.0.1"), "no connection details in the body");
      assert.ok(Date.now() - started < 3000, "failed within the connection timeout");
      assert.equal(
        (await api(app.url, "GET", "/healthz")).status,
        200,
        "liveness does not need the database",
      );
      assert.equal((await api(app.url, "GET", "/readyz")).status, 503, "readiness says not ready");
    } finally {
      await stopApi(app.server);
      await dead.end();
    }
  });
});
