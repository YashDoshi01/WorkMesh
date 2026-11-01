import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Db } from "@workmesh/api";
import { api, resetTables, setupTestDb, startApi, stopApi, type Started } from "./helpers.js";

describe("worker protocol and atomic claiming (PostgreSQL)", () => {
  let db: Db;
  let started: Started;

  before(async () => {
    db = await setupTestDb();
    started = await startApi(db);
  });
  beforeEach(() => resetTables(db));
  after(async () => {
    await stopApi(started.server);
    await db.end();
  });

  const submit = async (type: string, extra: object = {}): Promise<string> =>
    (await api(started.url, "POST", "/jobs", { type, payload: {}, ...extra })).body.id;

  const register = async (jobTypes: string[], concurrency = 1): Promise<string> => {
    const r = await api(started.url, "POST", "/workers", { name: "w", jobTypes, concurrency });
    assert.equal(r.status, 201);
    return r.body.id;
  };

  const claim = async (workerId: string, limit = 1) =>
    (await api(started.url, "POST", `/workers/${workerId}/claim`, { limit })).body.jobs as {
      id: string;
      status: string;
      attemptCount: number;
      claimedBy: string;
    }[];

  it("validates worker registration", async () => {
    for (const body of [
      { name: "", jobTypes: ["a"], concurrency: 1 },
      { name: "w", jobTypes: [], concurrency: 1 },
      { name: "w", jobTypes: ["BAD TYPE"], concurrency: 1 },
      { name: "w", jobTypes: ["a"], concurrency: 0 },
      { name: "w", jobTypes: ["a"], concurrency: 1000 },
    ]) {
      assert.equal((await api(started.url, "POST", "/workers", body)).status, 400);
    }
  });

  it("claim marks the job running, owned by the worker, attempt 1", async () => {
    const jobId = await submit("t.a");
    const workerId = await register(["t.a"]);
    const [job] = await claim(workerId);
    assert.equal(job?.id, jobId);
    assert.equal(job?.status, "running");
    assert.equal(job?.claimedBy, workerId);
    assert.equal(job?.attemptCount, 1);
    assert.deepEqual(await claim(workerId), [], "a running job is not claimable again");
  });

  it("only hands out job types the worker registered for", async () => {
    await submit("t.other");
    const workerId = await register(["t.a"]);
    assert.deepEqual(await claim(workerId), []);
  });

  it("does not claim delayed jobs before run_at, but does after", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const jobId = await submit("t.a", { runAt: future });
    const workerId = await register(["t.a"]);
    assert.deepEqual(await claim(workerId), []);
    await db.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1", [jobId]);
    assert.equal((await claim(workerId))[0]?.id, jobId);
  });

  it("claims oldest first and honours the batch limit", async () => {
    const ids = [await submit("t.a"), await submit("t.a"), await submit("t.a")];
    const workerId = await register(["t.a"], 5);
    assert.deepEqual(
      (await claim(workerId, 2)).map((j) => j.id),
      ids.slice(0, 2),
    );
    assert.deepEqual(
      (await claim(workerId, 2)).map((j) => j.id),
      ids.slice(2),
    );
  });

  it("unknown worker gets 404 on claim and heartbeat", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    assert.equal((await api(started.url, "POST", `/workers/${ghost}/claim`, {})).status, 404);
    assert.equal((await api(started.url, "POST", `/workers/${ghost}/heartbeat`, {})).status, 404);
  });

  it("heartbeat and claim refresh last_heartbeat_at", async () => {
    const workerId = await register(["t.a"]);
    await db.query("UPDATE workers SET last_heartbeat_at = now() - interval '1 hour'");
    const hb = await api(started.url, "POST", `/workers/${workerId}/heartbeat`, {});
    assert.equal(hb.status, 200);
    assert.ok(Date.now() - Date.parse(hb.body.lastHeartbeatAt) < 5_000);
    await db.query("UPDATE workers SET last_heartbeat_at = now() - interval '1 hour'");
    await claim(workerId);
    const row = await db.query(
      "SELECT now() - last_heartbeat_at < interval '5 seconds' AS fresh FROM workers",
    );
    assert.equal(row.rows[0].fresh, true);
  });

  describe("completion and failure", () => {
    it("owner can complete a running job", async () => {
      await submit("t.a");
      const workerId = await register(["t.a"]);
      const [job] = await claim(workerId);
      const r = await api(started.url, "POST", `/jobs/${job!.id}/complete`, { workerId });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "succeeded");
      assert.ok(r.body.finishedAt);
    });

    it("owner can fail a running job and the error is stored", async () => {
      await submit("t.a");
      const workerId = await register(["t.a"]);
      const [job] = await claim(workerId);
      const r = await api(started.url, "POST", `/jobs/${job!.id}/fail`, {
        workerId,
        error: "boom",
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "failed");
      assert.equal(r.body.lastError, "boom");
    });

    it("another worker cannot complete or fail a job it does not own (409)", async () => {
      await submit("t.a");
      const owner = await register(["t.a"]);
      const thief = await register(["t.a"]);
      const [job] = await claim(owner);
      const c = await api(started.url, "POST", `/jobs/${job!.id}/complete`, { workerId: thief });
      assert.equal(c.status, 409);
      const f = await api(started.url, "POST", `/jobs/${job!.id}/fail`, {
        workerId: thief,
        error: "x",
      });
      assert.equal(f.status, 409);
      const still = await api(started.url, "GET", `/jobs/${job!.id}`);
      assert.equal(still.body.status, "running");
    });

    it("finishing twice, or finishing a queued job, is a 409; unknown job is 404", async () => {
      const queuedId = await submit("t.queued");
      await submit("t.a");
      const workerId = await register(["t.a"]);
      const [job] = await claim(workerId);
      assert.equal(
        (await api(started.url, "POST", `/jobs/${job!.id}/complete`, { workerId })).status,
        200,
      );
      assert.equal(
        (await api(started.url, "POST", `/jobs/${job!.id}/complete`, { workerId })).status,
        409,
      );
      assert.equal(
        (await api(started.url, "POST", `/jobs/${queuedId}/complete`, { workerId })).status,
        409,
      );
      const ghost = "00000000-0000-4000-8000-000000000000";
      assert.equal(
        (await api(started.url, "POST", `/jobs/${ghost}/complete`, { workerId })).status,
        404,
      );
    });
  });

  describe("concurrent claims", () => {
    it("ten workers racing for ONE job: exactly one wins", async () => {
      await submit("t.race");
      const workers = await Promise.all(Array.from({ length: 10 }, () => register(["t.race"])));
      const results = await Promise.all(workers.map((w) => claim(w)));
      const winners = results.filter((r) => r.length > 0);
      assert.equal(winners.length, 1);
      assert.equal(results.flat().length, 1);
    });

    it("six workers draining 60 jobs: every job claimed exactly once", async () => {
      const total = 60;
      const submitted = new Set<string>();
      for (let i = 0; i < total; i++) submitted.add(await submit("t.drain"));

      const workers = await Promise.all(Array.from({ length: 6 }, () => register(["t.drain"], 5)));
      const drain = async (workerId: string): Promise<string[]> => {
        const got: string[] = [];
        for (;;) {
          const batch = await claim(workerId, 5);
          if (batch.length === 0) return got;
          got.push(...batch.map((j) => j.id));
        }
      };
      const perWorker = await Promise.all(workers.map(drain));
      const all = perWorker.flat();

      assert.equal(all.length, total, "no job was handed out twice, none was missed");
      assert.deepEqual(new Set(all), submitted);
      const rows = await db.query(
        "SELECT count(*)::int AS n FROM jobs WHERE status = 'running' AND attempt_count = 1",
      );
      assert.equal(rows.rows[0].n, total);
      assert.ok(perWorker.filter((p) => p.length > 0).length > 1, "work was actually shared");
    });
  });

  it("database rejects a running job with no owner", async () => {
    await assert.rejects(
      db.query(`INSERT INTO jobs (type, payload, status) VALUES ('x', '{}', 'running')`),
    );
  });
});
