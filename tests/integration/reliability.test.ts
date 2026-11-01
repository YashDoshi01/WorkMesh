import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { LeaseReaper, type Db } from "@workmesh/api";
import { generateInvoice } from "@workmesh/sample-worker/handlers";
import { PermanentError, Worker } from "@workmesh/worker-sdk";
import {
  api,
  lifecycleFor,
  resetTables,
  setupTestDb,
  startApi,
  stopApi,
  waitFor,
  type Started,
} from "./helpers.js";

const silent = (): void => undefined;
const ghostId = "00000000-0000-4000-8000-000000000000";

/** Drives the protocol by hand so each test controls exactly which worker does what, when. */
class Harness {
  constructor(
    readonly db: Db,
    readonly url: string,
  ) {}

  post = (p: string, body: object) => api(this.url, "POST", p, body);
  get = (p: string) => api(this.url, "GET", p);

  async submit(extra: object = {}, type = "t.a"): Promise<string> {
    const r = await this.post("/jobs", { type, payload: {}, ...extra });
    assert.equal(r.status, 201);
    return r.body.id;
  }

  async register(types = ["t.a"]): Promise<string> {
    return (await this.post("/workers", { name: "w", jobTypes: types, concurrency: 5 })).body.id;
  }

  async claim(workerId: string, limit = 1): Promise<any[]> {
    return (await this.post(`/workers/${workerId}/claim`, { limit })).body.jobs;
  }

  /** Submit one job and have a fresh worker claim it. */
  async claimed(extra: object = {}) {
    const jobId = await this.submit(extra);
    const workerId = await this.register();
    const [job] = await this.claim(workerId);
    assert.equal(job?.id, jobId);
    return { jobId, workerId, attempt: job.attemptCount as number };
  }

  fail = (jobId: string, workerId: string, attempt: number, extra: object = {}) =>
    this.post(`/jobs/${jobId}/fail`, { workerId, attempt, error: "boom", ...extra });
  complete = (jobId: string, workerId: string, attempt: number) =>
    this.post(`/jobs/${jobId}/complete`, { workerId, attempt });
  renew = (jobId: string, workerId: string, attempt: number) =>
    this.post(`/jobs/${jobId}/heartbeat`, { workerId, attempt });

  expireLease = (jobId: string) =>
    this.db.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [
      jobId,
    ]);
  makeDueNow = (jobId: string) =>
    this.db.query("UPDATE jobs SET run_at = now() WHERE id = $1", [jobId]);
  job = async (jobId: string) => (await this.get(`/jobs/${jobId}`)).body;
  attempts = async (jobId: string): Promise<any[]> =>
    (await this.get(`/jobs/${jobId}/attempts`)).body.items;
  /** Milliseconds from now until the job's run_at (negative = already due). */
  async delayMs(jobId: string): Promise<number> {
    const r = await this.db.query(
      "SELECT EXTRACT(EPOCH FROM (run_at - now())) * 1000 AS ms FROM jobs WHERE id = $1",
      [jobId],
    );
    return Number(r.rows[0].ms);
  }
}

describe("retries, leases, fencing and recovery (PostgreSQL)", () => {
  let db: Db;
  let started: Started;
  let h: Harness;
  let reaper: LeaseReaper;

  before(async () => {
    db = await setupTestDb();
    // Small retry delays keep tests fast; the cap (3000) is exercised in the backoff test.
    started = await startApi(db, { retryBaseMs: 1000, retryMaxMs: 3000 });
    h = new Harness(db, started.url);
    reaper = new LeaseReaper(lifecycleFor(db, { retryBaseMs: 1000, retryMaxMs: 3000 }), 60_000);
  });
  beforeEach(() => resetTables(db));
  after(async () => {
    await stopApi(started.server);
    await db.end();
  });

  describe("attempt records", () => {
    it("claim opens an attempt row; completing closes it as succeeded", async () => {
      const { jobId, workerId, attempt } = await h.claimed();
      let rows = await h.attempts(jobId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].attemptNumber, 1);
      assert.equal(rows[0].outcome, "running");
      assert.equal(rows[0].workerId, workerId);

      await h.complete(jobId, workerId, attempt);
      rows = await h.attempts(jobId);
      assert.equal(rows[0].outcome, "succeeded");
      assert.ok(rows[0].finishedAt);
    });

    it("GET /jobs/:id/attempts is 404 for an unknown job", async () => {
      assert.equal((await h.get(`/jobs/${ghostId}/attempts`)).status, 404);
    });

    it("maxAttempts is validated and defaults to 3", async () => {
      assert.equal((await h.job(await h.submit())).maxAttempts, 3);
      assert.equal((await h.job(await h.submit({ maxAttempts: 5 }))).maxAttempts, 5);
      for (const bad of [0, 21, 1.5, "3"]) {
        assert.equal(
          (await h.post("/jobs", { type: "t.a", payload: {}, maxAttempts: bad })).status,
          400,
        );
      }
    });
  });

  describe("retry policy", () => {
    it("a retryable failure re-queues the job with a future run_at and no owner", async () => {
      const { jobId, workerId, attempt } = await h.claimed({ maxAttempts: 3 });
      const r = await h.fail(jobId, workerId, attempt);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "queued");
      assert.equal(r.body.claimedBy, null);
      assert.equal(r.body.leaseExpiresAt, null);
      assert.equal(r.body.lastError, "boom");
      assert.equal(r.body.finishedAt, null);
      assert.ok((await h.delayMs(jobId)) > 0, "retry is scheduled in the future");
      assert.deepEqual(await h.claim(workerId), [], "not claimable before its retry time");
      assert.equal((await h.attempts(jobId))[0].outcome, "failed");
    });

    it("once due, the retry is claimed as attempt 2 (history is kept)", async () => {
      const { jobId, workerId, attempt } = await h.claimed({ maxAttempts: 3 });
      await h.fail(jobId, workerId, attempt);
      await h.makeDueNow(jobId);
      const [again] = await h.claim(workerId);
      assert.equal(again.attemptCount, 2);
      const rows = await h.attempts(jobId);
      assert.deepEqual(
        rows.map((a) => [a.attemptNumber, a.outcome]),
        [
          [1, "failed"],
          [2, "running"],
        ],
      );
    });

    it("exhausting maxAttempts ends in failed (dead letter) and stays there", async () => {
      const jobId = await h.submit({ maxAttempts: 2 });
      const workerId = await h.register();
      for (const expected of ["queued", "failed"]) {
        await h.makeDueNow(jobId);
        const [job] = await h.claim(workerId);
        const r = await h.fail(jobId, workerId, job.attemptCount, {
          error: `err ${job.attemptCount}`,
        });
        assert.equal(r.body.status, expected);
      }
      const final = await h.job(jobId);
      assert.equal(final.status, "failed");
      assert.equal(final.lastError, "err 2");
      assert.ok(final.finishedAt);
      await h.makeDueNow(jobId);
      assert.deepEqual(await h.claim(workerId), [], "a dead-lettered job is never claimed again");
      assert.deepEqual(
        (await h.attempts(jobId)).map((a) => a.outcome),
        ["failed", "failed"],
      );
    });

    it("a permanent failure (retryable:false) is terminal immediately", async () => {
      const { jobId, workerId, attempt } = await h.claimed({ maxAttempts: 5 });
      const r = await h.fail(jobId, workerId, attempt, { retryable: false });
      assert.equal(r.body.status, "failed");
    });

    it("delay doubles each attempt up to the cap, with jitter in [50%, 100%] of the ceiling", async () => {
      // base 1000 ms, cap 3000 ms  =>  ceilings 1000, 2000, 3000, 3000
      const jobId = await h.submit({ maxAttempts: 6 });
      const workerId = await h.register();
      const slack = 150; // ms of clock drift between the UPDATE and our read
      for (const ceiling of [1000, 2000, 3000, 3000]) {
        await h.makeDueNow(jobId);
        const [job] = await h.claim(workerId);
        await h.fail(jobId, workerId, job.attemptCount);
        const delay = await h.delayMs(jobId);
        assert.ok(delay <= ceiling + slack, `attempt ${job.attemptCount}: ${delay} <= ${ceiling}`);
        assert.ok(
          delay >= ceiling / 2 - slack,
          `attempt ${job.attemptCount}: ${delay} >= ${ceiling / 2}`,
        );
      }
    });
  });

  describe("leases", () => {
    it("a claim sets a lease deadline in the future", async () => {
      const { jobId } = await h.claimed();
      const job = await h.job(jobId);
      assert.ok(Date.parse(job.leaseExpiresAt) > Date.now());
    });

    it("the owner can renew; the deadline moves forward", async () => {
      const { jobId, workerId, attempt } = await h.claimed();
      await h.expireLease(jobId);
      const r = await h.renew(jobId, workerId, attempt);
      assert.equal(r.status, 200);
      assert.ok(Date.parse(r.body.leaseExpiresAt) > Date.now());
    });

    it("a non-owner, a wrong attempt, or an unknown job cannot renew", async () => {
      const { jobId, workerId, attempt } = await h.claimed();
      const other = await h.register();
      assert.equal((await h.renew(jobId, other, attempt)).status, 409);
      assert.equal((await h.renew(jobId, workerId, attempt + 1)).status, 409);
      assert.equal((await h.renew(ghostId, workerId, 1)).status, 404);
    });

    it("the database refuses a running job with no lease deadline", async () => {
      const { jobId } = await h.claimed();
      await assert.rejects(
        db.query("UPDATE jobs SET lease_expires_at = NULL WHERE id = $1", [jobId]),
      );
    });
  });

  describe("recovery of expired leases", () => {
    it("an unexpired lease is left alone", async () => {
      const { jobId } = await h.claimed();
      assert.equal(await reaper.runOnce(), 0);
      assert.equal((await h.job(jobId)).status, "running");
    });

    it("an expired lease is recovered: job re-queued, attempt marked lease_expired", async () => {
      const { jobId } = await h.claimed({ maxAttempts: 3 });
      await h.expireLease(jobId);
      assert.equal(await reaper.runOnce(), 1);
      const job = await h.job(jobId);
      assert.equal(job.status, "queued");
      assert.equal(job.claimedBy, null);
      assert.match(job.lastError, /lease expired/);
      assert.equal(job.attemptCount, 1, "the attempt number is kept; the next claim makes it 2");
      assert.ok((await h.delayMs(jobId)) > 0, "recovery also applies backoff");
      const rows = await h.attempts(jobId);
      assert.equal(rows[0].outcome, "lease_expired");
    });

    it("recovery with no attempts left ends in failed", async () => {
      const { jobId } = await h.claimed({ maxAttempts: 1 });
      await h.expireLease(jobId);
      await reaper.runOnce();
      const job = await h.job(jobId);
      assert.equal(job.status, "failed");
      assert.ok(job.finishedAt);
    });

    it("a renewal that lands before the sweep wins; one after it is rejected", async () => {
      const first = await h.claimed();
      await h.expireLease(first.jobId);
      assert.equal((await h.renew(first.jobId, first.workerId, first.attempt)).status, 200);
      assert.equal(await reaper.runOnce(), 0);
      assert.equal((await h.job(first.jobId)).status, "running");

      const second = await h.claimed();
      await h.expireLease(second.jobId);
      assert.equal(await reaper.runOnce(), 1);
      assert.equal((await h.renew(second.jobId, second.workerId, second.attempt)).status, 409);
    });

    it("three sweepers racing over 20 expired jobs recover each job exactly once", async () => {
      const workerId = await h.register();
      for (let i = 0; i < 20; i++) await h.submit({ maxAttempts: 3 });
      const claimed = await h.claim(workerId, 20);
      assert.equal(claimed.length, 20);
      await db.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second'");

      const sweepers = [1, 2, 3].map(
        () => new LeaseReaper(lifecycleFor(db, { retryBaseMs: 1000, retryMaxMs: 3000 }), 60_000),
      );
      const counts = await Promise.all(sweepers.map((s) => s.runOnce()));
      assert.equal(
        counts.reduce((a, b) => a + b, 0),
        20,
      );
      const expired = await db.query(
        "SELECT job_id, count(*)::int AS n FROM job_attempts WHERE outcome = 'lease_expired' GROUP BY job_id",
      );
      assert.equal(expired.rowCount, 20);
      assert.ok(expired.rows.every((r) => r.n === 1));
      const status = await db.query("SELECT DISTINCT status FROM jobs");
      assert.deepEqual(
        status.rows.map((r) => r.status),
        ["queued"],
      );
    });

    it("the background loop recovers jobs, and stop() really stops it", async () => {
      const loop = new LeaseReaper(lifecycleFor(db), 30);
      loop.start();
      try {
        const { jobId } = await h.claimed();
        await h.expireLease(jobId);
        await waitFor(async () => (await h.job(jobId)).status === "queued", "loop to recover job");
      } finally {
        await loop.stop();
      }
      const { jobId: later } = await h.claimed();
      await h.expireLease(later);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal((await h.job(later)).status, "running", "no sweeping after stop()");
    });
  });

  describe("fencing: a stale attempt cannot touch a newer one", () => {
    it("worker A goes silent, B takes over; A's late reports are all rejected", async () => {
      const { jobId, workerId: a, attempt: attemptA } = await h.claimed({ maxAttempts: 3 });
      await h.expireLease(jobId);
      await reaper.runOnce();
      await h.makeDueNow(jobId);

      const b = await h.register();
      const [forB] = await h.claim(b);
      assert.equal(forB.attemptCount, 2);

      // A wakes up (it was only partitioned or paused) and tries everything.
      assert.equal((await h.complete(jobId, a, attemptA)).status, 409);
      assert.equal((await h.fail(jobId, a, attemptA)).status, 409);
      assert.equal((await h.renew(jobId, a, attemptA)).status, 409);
      const mid = await h.job(jobId);
      assert.equal(mid.status, "running");
      assert.equal(mid.claimedBy, b);

      assert.equal((await h.complete(jobId, b, 2)).status, 200);
      assert.equal((await h.complete(jobId, a, attemptA)).status, 409, "still rejected afterwards");
      const done = await h.job(jobId);
      assert.equal(done.status, "succeeded");
      assert.deepEqual(
        (await h.attempts(jobId)).map((x) => [
          x.attemptNumber,
          x.workerId === a ? "A" : "B",
          x.outcome,
        ]),
        [
          [1, "A", "lease_expired"],
          [2, "B", "succeeded"],
        ],
      );
    });

    it("the SAME worker re-claiming the job is also fenced from its own old attempt", async () => {
      const { jobId, workerId, attempt } = await h.claimed({ maxAttempts: 3 });
      await h.expireLease(jobId);
      await reaper.runOnce();
      await h.makeDueNow(jobId);
      const [second] = await h.claim(workerId);
      assert.equal(second.attemptCount, 2);
      assert.equal((await h.complete(jobId, workerId, attempt)).status, 409);
      assert.equal((await h.job(jobId)).status, "running");
      assert.equal((await h.complete(jobId, workerId, 2)).status, 200);
    });
  });

  describe("fault injection: lost acknowledgement", () => {
    it("repeating a completion report (response was lost) is a harmless success", async () => {
      const { jobId, workerId, attempt } = await h.claimed();
      assert.equal((await h.complete(jobId, workerId, attempt)).status, 200);
      const again = await h.complete(jobId, workerId, attempt);
      assert.equal(again.status, 200);
      assert.equal(again.body.status, "succeeded");
      assert.equal((await h.attempts(jobId)).length, 1);
      const other = await h.register();
      assert.equal(
        (await h.complete(jobId, other, attempt)).status,
        409,
        "only the owner may replay",
      );
    });

    it("repeating a failure report does not schedule the retry twice or disturb a newer attempt", async () => {
      const { jobId, workerId, attempt } = await h.claimed({ maxAttempts: 3 });
      const first = await h.fail(jobId, workerId, attempt);
      const replay = await h.fail(jobId, workerId, attempt);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.runAt, first.body.runAt, "run_at not pushed out again");
      assert.equal((await h.attempts(jobId)).length, 1);

      await h.makeDueNow(jobId);
      await h.claim(workerId); // attempt 2 now running
      const lateReplay = await h.fail(jobId, workerId, attempt); // stale duplicate of attempt 1
      assert.equal(lateReplay.status, 200);
      const job = await h.job(jobId);
      assert.equal(job.status, "running", "attempt 2 is untouched by a replayed attempt-1 report");
      assert.equal(job.attemptCount, 2);
    });

    it("SDK: the response to `complete` is dropped once; the worker retries and the job runs once", async () => {
      let dropped = 0;
      const lossy: typeof fetch = async (input, init) => {
        const res = await fetch(input, init);
        if (String(input).endsWith("/complete") && dropped === 0) {
          dropped++;
          await res.text();
          throw new TypeError("fetch failed (simulated: response lost in transit)");
        }
        return res;
      };
      let runs = 0;
      const worker = new Worker({
        apiUrl: started.url,
        pollIntervalMs: 20,
        reportRetryBaseMs: 10,
        log: silent,
        fetch: lossy,
      }).register("t.a", async () => {
        runs++;
      });
      await worker.start();
      try {
        const jobId = await h.submit();
        await waitFor(async () => (await h.job(jobId)).status === "succeeded", "job to succeed");
        assert.equal(dropped, 1, "the fault was actually injected");
        assert.equal(runs, 1, "the handler ran exactly once");
        const rows = await h.attempts(jobId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome, "succeeded");
      } finally {
        await worker.stop();
      }
    });
  });

  describe("fault injection: crash after claim, and duplicate execution", () => {
    let dir: string;
    before(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "workmesh-invoices-"));
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("LIMITATION: a crash after the side effect makes the job run twice; an idempotent handler absorbs it", async () => {
      const jobId = await h.submit({ maxAttempts: 3 });
      // Give it the payload the invoice handler understands.
      await db.query("UPDATE jobs SET payload = $2 WHERE id = $1", [
        jobId,
        JSON.stringify({ customer: "acme", amountCents: 4200 }),
      ]);
      const naiveEffects: string[] = [];
      const workerA = await h.register();
      const [first] = await h.claim(workerA);

      // Attempt 1 performs its side effects, then the worker dies before reporting.
      naiveEffects.push(first.id);
      assert.equal(await generateInvoice(first, dir), "created");

      await h.expireLease(jobId);
      await reaper.runOnce();
      await h.makeDueNow(jobId);

      const workerB = await h.register();
      const [second] = await h.claim(workerB);
      assert.equal(second.attemptCount, 2);
      naiveEffects.push(second.id);
      assert.equal(
        await generateInvoice(second, dir),
        "duplicate",
        "idempotent handler recognised the repeat",
      );
      await h.complete(jobId, workerB, 2);

      assert.equal(naiveEffects.length, 2, "a naive handler would have charged/sent twice");
      assert.equal((await readdir(dir)).filter((f) => f.endsWith(".txt")).length, 1);
      assert.equal(
        (await readdir(dir)).filter((f) => f.includes(".tmp-")).length,
        0,
        "no temp files left",
      );
    });

    it("a worker PROCESS is killed (SIGKILL) mid-job; its lease expires and another worker finishes the job", async () => {
      const api2 = await startApi(db, { leaseMs: 1500, retryBaseMs: 20, retryMaxMs: 50 });
      const sweeper = new LeaseReaper(
        lifecycleFor(db, { leaseMs: 1500, retryBaseMs: 20, retryMaxMs: 50 }),
        60_000,
      );
      const child = spawn(process.execPath, ["--import", "tsx", "apps/sample-worker/src/main.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, WORKMESH_API_URL: api2.url, WORKER_POLL_MS: "50" },
        stdio: "ignore",
      });
      const exited = new Promise((r) => child.once("exit", r));
      let rescuer: Worker | undefined;
      try {
        const post = await api(api2.url, "POST", "/jobs", {
          type: "slow.task",
          payload: { ms: 60_000 },
          maxAttempts: 3,
        });
        const jobId: string = post.body.id;
        const running = await waitFor(
          async () => {
            const j = (await api(api2.url, "GET", `/jobs/${jobId}`)).body;
            return j.status === "running" ? j : false;
          },
          "the child process to claim the job",
          30_000,
        );
        const victim = running.claimedBy;

        child.kill("SIGKILL"); // a crash: no graceful stop, no final report
        await exited;

        // Nothing else happens until the lease runs out; then a sweep recovers it.
        const recovered = await waitFor(
          async () => (await sweeper.runOnce()) > 0,
          "lease to expire",
          15_000,
        );
        assert.ok(recovered);
        assert.equal((await api(api2.url, "GET", `/jobs/${jobId}`)).body.status, "queued");

        rescuer = new Worker({ apiUrl: api2.url, pollIntervalMs: 20, log: silent }).register(
          "slow.task",
          async () => undefined,
        );
        await rescuer.start();
        await waitFor(
          async () => (await api(api2.url, "GET", `/jobs/${jobId}`)).body.status === "succeeded",
          "rescuer to finish the job",
        );
        const rows = (await api(api2.url, "GET", `/jobs/${jobId}/attempts`)).body.items;
        assert.deepEqual(
          rows.map((a: any) => a.outcome),
          ["lease_expired", "succeeded"],
        );
        assert.equal(rows[0].workerId, victim);
        assert.notEqual(rows[1].workerId, victim);
      } finally {
        child.kill("SIGKILL");
        await rescuer?.stop();
        await stopApi(api2.server);
      }
    });
  });
});

describe("worker SDK: lease renewal, lost leases, retries (PostgreSQL)", () => {
  let db: Db;
  let started: Started;
  let h: Harness;
  let reaper: LeaseReaper;
  const cfg = { leaseMs: 600, retryBaseMs: 20, retryMaxMs: 50 };
  const workers: Worker[] = [];

  before(async () => {
    db = await setupTestDb();
    started = await startApi(db, cfg);
    h = new Harness(db, started.url);
    reaper = new LeaseReaper(lifecycleFor(db, cfg), 60_000);
  });
  beforeEach(() => resetTables(db));
  after(async () => {
    await Promise.all(workers.map((w) => w.stop()));
    await stopApi(started.server);
    await db.end();
  });

  const newWorker = (): Worker => {
    const w = new Worker({
      apiUrl: started.url,
      pollIntervalMs: 20,
      reportRetryBaseMs: 10,
      log: silent,
    });
    workers.push(w);
    return w;
  };
  const status = async (id: string) => (await h.job(id)).status;

  it("a handler that throws is retried with backoff until it succeeds", async () => {
    const seen: number[] = [];
    const worker = newWorker().register("t.a", async (job) => {
      seen.push(job.attemptCount);
      if (job.attemptCount < 3) throw new Error("flaky");
    });
    await worker.start();
    const jobId = await h.submit({ maxAttempts: 5 });
    await waitFor(
      async () => (await status(jobId)) === "succeeded",
      "job to succeed after retries",
    );
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual(
      (await h.attempts(jobId)).map((a) => a.outcome),
      ["failed", "failed", "succeeded"],
    );
    await worker.stop();
  });

  it("PermanentError is not retried; a plain Error is", async () => {
    let permanentRuns = 0;
    const worker = newWorker().register("t.a", async () => {
      permanentRuns++;
      throw new PermanentError("bad input, retrying cannot help");
    });
    await worker.start();
    const jobId = await h.submit({ maxAttempts: 5 });
    await waitFor(async () => (await status(jobId)) === "failed", "job to fail terminally");
    assert.equal(permanentRuns, 1);
    assert.match((await h.job(jobId)).lastError, /PermanentError/);
    await worker.stop();
  });

  it("a job without a registered handler... is simply never claimed, so it stays queued", async () => {
    const worker = newWorker().register("t.a", async () => undefined);
    await worker.start();
    const jobId = await h.submit({}, "t.nobody");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await status(jobId), "queued");
    await worker.stop();
  });

  it("a long handler keeps its lease alive by renewing (outlives several lease periods)", async () => {
    const loop = new LeaseReaper(lifecycleFor(db, cfg), 40); // an eager sweeper trying to steal it
    loop.start();
    const worker = newWorker().register("t.a", async () => {
      await new Promise((r) => setTimeout(r, 1800)); // 3x the 600 ms lease
    });
    await worker.start();
    try {
      const jobId = await h.submit({ maxAttempts: 3 });
      await waitFor(
        async () => (await status(jobId)) === "succeeded",
        "long job to finish",
        15_000,
      );
      const job = await h.job(jobId);
      assert.equal(job.attemptCount, 1, "never recovered, never re-run");
    } finally {
      await loop.stop();
      await worker.stop();
    }
  });

  it("graceful stop() keeps renewing leases while it drains in-flight work", async () => {
    const loop = new LeaseReaper(lifecycleFor(db, cfg), 40);
    loop.start();
    let started_ = false;
    const worker = newWorker().register("t.a", async () => {
      started_ = true;
      await new Promise((r) => setTimeout(r, 1500));
    });
    await worker.start();
    try {
      const jobId = await h.submit({ maxAttempts: 3 });
      await waitFor(async () => started_, "handler to start");
      await worker.stop(); // returns only after the handler finished and reported
      const job = await h.job(jobId);
      assert.equal(job.status, "succeeded");
      assert.equal(job.attemptCount, 1);
    } finally {
      await loop.stop();
    }
  });

  it("when the lease is lost the handler's signal aborts, and no stale report is sent", async () => {
    let abortedFirstAttempt = false;
    const worker = newWorker().register("t.a", async (job, ctx) => {
      if (job.attemptCount > 1) return; // the retry just succeeds
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          abortedFirstAttempt = true;
          resolve();
        });
        setTimeout(resolve, 8000); // safety net so a bug cannot hang the test
      });
    });
    await worker.start();
    const jobId = await h.submit({ maxAttempts: 3 });
    await waitFor(async () => (await status(jobId)) === "running", "job to start running");

    // Something external steals the job (e.g. a sweeper after a long pause on the worker).
    await waitFor(async () => {
      await db.query(
        "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE status = 'running'",
      );
      return (await reaper.runOnce()) > 0;
    }, "sweeper to take the job");

    await waitFor(async () => abortedFirstAttempt, "handler to be told its lease was lost", 5_000);
    await waitFor(async () => (await status(jobId)) === "succeeded", "retry to succeed");
    assert.deepEqual(
      (await h.attempts(jobId)).map((a) => a.outcome),
      ["lease_expired", "succeeded"],
    );
    await worker.stop();
  });
});
