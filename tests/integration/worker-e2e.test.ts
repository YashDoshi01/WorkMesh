import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Db } from "@workmesh/api";
import { Worker } from "@workmesh/worker-sdk";
import {
  api,
  resetTables,
  setupTestDb,
  startApi,
  stopApi,
  waitFor,
  type Started,
} from "./helpers.js";

const silent = (): void => undefined;

describe("submit -> claim -> execute -> complete (SDK worker, real PostgreSQL)", () => {
  let db: Db;
  let started: Started;
  const workers: Worker[] = [];

  before(async () => {
    db = await setupTestDb();
    started = await startApi(db);
  });
  beforeEach(() => resetTables(db));
  after(async () => {
    await Promise.all(workers.map((w) => w.stop()));
    await stopApi(started.server);
    await db.end();
  });

  const newWorker = (concurrency = 2): Worker => {
    const w = new Worker({
      apiUrl: started.url,
      concurrency,
      pollIntervalMs: 30,
      log: silent,
    });
    workers.push(w);
    return w;
  };

  const submit = async (type: string, payload: object = {}): Promise<string> =>
    (await api(started.url, "POST", "/jobs", { type, payload })).body.id;

  const statusOf = async (id: string): Promise<any> =>
    (await api(started.url, "GET", `/jobs/${id}`)).body;

  const untilStatus = (id: string, status: string) =>
    waitFor(async () => {
      const job = await statusOf(id);
      return job.status === status ? job : false;
    }, `job ${id} to be ${status}`);

  it("a handler receives the payload and the job ends up succeeded", async () => {
    const seen: unknown[] = [];
    const worker = newWorker().register("e2e.ok", async (job) => {
      seen.push(job.payload);
    });
    await worker.start();
    const id = await submit("e2e.ok", { hello: "world" });
    const job = await untilStatus(id, "succeeded");
    assert.deepEqual(seen, [{ hello: "world" }]);
    assert.equal(job.claimedBy, worker.id);
    assert.equal(job.attemptCount, 1);
    await worker.stop();
  });

  it("a throwing handler marks the job failed with the error message", async () => {
    const worker = newWorker().register("e2e.bad", async () => {
      throw new Error("handler exploded");
    });
    await worker.start();
    const job = await untilStatus(await submit("e2e.bad"), "failed");
    assert.match(job.lastError, /handler exploded/);
    await worker.stop();
  });

  it("job types without a handler stay queued", async () => {
    const worker = newWorker().register("e2e.ok", async () => undefined);
    await worker.start();
    const stranger = await submit("e2e.unhandled");
    const handled = await submit("e2e.ok");
    await untilStatus(handled, "succeeded");
    assert.equal((await statusOf(stranger)).status, "queued");
    await worker.stop();
  });

  it("never runs more handlers at once than its concurrency", async () => {
    let active = 0;
    let peak = 0;
    const worker = newWorker(2).register("e2e.slow", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 120));
      active--;
    });
    await worker.start();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await submit("e2e.slow"));
    for (const id of ids) await untilStatus(id, "succeeded");
    assert.equal(peak, 2);
    await worker.stop();
  });

  it("two workers share a backlog without running any job twice", async () => {
    const runs = new Map<string, number>();
    const handler = async (job: { id: string }): Promise<void> => {
      runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 20));
    };
    const a = newWorker(3).register("e2e.share", handler);
    const b = newWorker(3).register("e2e.share", handler);
    await a.start();
    await b.start();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await submit("e2e.share"));
    for (const id of ids) await untilStatus(id, "succeeded");
    assert.equal(runs.size, 20);
    assert.ok([...runs.values()].every((n) => n === 1));
    const owners = await db.query("SELECT DISTINCT claimed_by FROM jobs");
    assert.equal(owners.rowCount, 2, "both workers did some of the work");
    await Promise.all([a.stop(), b.stop()]);
  });

  it("stop() lets an in-flight job finish and report before returning", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started_ = false;
    const worker = newWorker(1).register("e2e.gate", async () => {
      started_ = true;
      await gate;
    });
    await worker.start();
    const id = await submit("e2e.gate");
    await waitFor(async () => started_, "handler to start");

    const stopping = worker.stop();
    setTimeout(release, 100);
    await stopping;
    assert.equal((await statusOf(id)).status, "succeeded");

    const later = await submit("e2e.gate");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await statusOf(later)).status, "queued", "a stopped worker claims nothing");
  });

  it("the sample worker runs as a SEPARATE OS process", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/sample-worker/src/main.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, WORKMESH_API_URL: started.url, WORKER_POLL_MS: "50" },
      stdio: "ignore",
    });
    try {
      const ok = await submit("email.send", { to: "a@b.c" });
      const bad = await submit("report.build", { shouldFail: true });
      const okJob = await waitFor(
        async () => {
          const j = await statusOf(ok);
          return j.status === "succeeded" ? j : false;
        },
        "sample worker to finish email.send",
        20_000,
      );
      const badJob = await untilStatus(bad, "failed");
      assert.match(badJob.lastError, /report generation failed/);
      const owner = await db.query("SELECT name FROM workers WHERE id = $1", [okJob.claimedBy]);
      assert.equal(owner.rows[0].name, "sample-worker");
      assert.notEqual(child.pid, process.pid);
    } finally {
      child.kill();
    }
  });
});
