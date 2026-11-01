import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { LeaseReaper, createPool, type Db } from "@workmesh/api";
import { PermanentError, Worker } from "@workmesh/worker-sdk";
import {
  api,
  lifecycleFor,
  resetTables,
  setupTestDb,
  startApi,
  stopApi,
  testDatabaseUrl,
  waitFor,
  type Started,
} from "./helpers.js";

const ghostId = "00000000-0000-4000-8000-000000000000";

/** A node whose job type is `wf.<key>`, so a test can register a worker for exactly the nodes it wants to run. */
const node = (key: string, dependsOn: string[] = [], extra: object = {}) => ({
  key,
  type: `wf.${key}`,
  dependsOn,
  ...extra,
});

describe("workflows: DAGs of dependent jobs (PostgreSQL)", () => {
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

  const post = (p: string, body: object = {}) => api(started.url, "POST", p, body);
  const get = (p: string) => api(started.url, "GET", p);

  const create = async (nodes: object[], name = "wf") => {
    const r = await post("/workflows", { name, nodes });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as Detail;
  };
  const detail = async (id: string): Promise<Detail> => (await get(`/workflows/${id}`)).body;
  const stateOf = (d: Detail, key: string): string => d.nodes.find((n) => n.key === key)!.state;
  const states = (d: Detail): Record<string, string> =>
    Object.fromEntries(d.nodes.map((n) => [n.key, n.state]));
  const jobCount = async (workflowId: string): Promise<number> =>
    (await db.query("SELECT count(*)::int AS n FROM jobs WHERE workflow_id = $1", [workflowId]))
      .rows[0].n;

  const register = async (keys: string[]): Promise<string> =>
    (
      await post("/workers", {
        name: "w",
        jobTypes: keys.map((k) => `wf.${k}`),
        concurrency: 20,
      })
    ).body.id;
  const claim = async (workerId: string, limit = 20): Promise<any[]> =>
    (await post(`/workers/${workerId}/claim`, { limit })).body.jobs;
  const complete = (workerId: string, job: any) =>
    post(`/jobs/${job.id}/complete`, { workerId, attempt: job.attemptCount });
  const failPermanently = (workerId: string, job: any) =>
    post(`/jobs/${job.id}/fail`, {
      workerId,
      attempt: job.attemptCount,
      error: "nope",
      retryable: false,
    });

  /** Claim and complete exactly the job of this node. */
  const run = async (workflowId: string, key: string): Promise<void> => {
    const w = await register([key]);
    const jobs = await claim(w);
    const job = jobs.find((j) => j.type === `wf.${key}` && j.workflowId === workflowId);
    assert.ok(job, `node ${key} should be claimable`);
    assert.equal((await complete(w, job)).status, 200);
  };

  interface Detail {
    id: string;
    status: string;
    cancelRequested: boolean;
    finishedAt: string | null;
    progress: {
      total: number;
      waiting: number;
      queued: number;
      running: number;
      succeeded: number;
      failed: number;
      cancelled: number;
      skipped: number;
    };
    nodes: {
      key: string;
      state: string;
      dependsOn: string[];
      jobId: string | null;
      attemptCount: number | null;
      lastError: string | null;
    }[];
  }

  // ------------------------------------------------------------ definition
  describe("definition validation", () => {
    const bad = async (nodes: object[]) => {
      const r = await post("/workflows", { nodes });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error.code, "validation_error");
      const none = await db.query(
        "SELECT (SELECT count(*) FROM workflows)::int AS w, (SELECT count(*) FROM jobs)::int AS j",
      );
      assert.deepEqual(none.rows[0], { w: 0, j: 0 }, "a rejected definition persists nothing");
      return r.body.error.details as { path: string; message: string }[];
    };

    it("rejects a dependency cycle and names it", async () => {
      const details = await bad([node("a", ["c"]), node("b", ["a"]), node("c", ["b"])]);
      assert.match(details[0]!.message, /dependency cycle: .*->.*/);
      for (const k of ["a", "b", "c"]) assert.ok(details[0]!.message.includes(k));
    });

    it("rejects a node that depends on itself", async () => {
      const details = await bad([node("a", ["a"])]);
      assert.match(details[0]!.message, /dependency cycle: a -> a/);
    });

    it("rejects a cycle hidden inside an otherwise valid graph, without blaming innocent nodes", async () => {
      const details = await bad([
        node("root"),
        node("ok", ["root"]),
        node("x", ["y"]),
        node("y", ["x"]),
        node("after", ["x"]),
      ]);
      assert.ok(!details[0]!.message.includes("after"));
      assert.ok(!details[0]!.message.includes("root"));
    });

    it("rejects unknown dependencies with a precise path", async () => {
      const details = await bad([node("a"), node("b", ["a", "ghost"])]);
      assert.equal(details[0]!.path, "nodes.1.dependsOn.1");
      assert.match(details[0]!.message, /unknown dependency "ghost"/);
    });

    it("rejects duplicate keys, bad keys, empty or oversized workflows and unknown fields", async () => {
      await bad([node("a"), node("a")]);
      await bad([node("Bad Key")]);
      await bad([]);
      await bad(Array.from({ length: 101 }, (_, i) => node(`n${i}`)));
      await bad([{ ...node("a"), surprise: true }]);
      await bad([node("a", ["b", "b"]), node("b")]);
    });

    it("rejects too many dependencies per node and too many in total", async () => {
      const wide = [
        ...Array.from({ length: 21 }, (_, i) => node(`p${i}`)),
        node(
          "sink",
          Array.from({ length: 21 }, (_, i) => `p${i}`),
        ),
      ];
      await bad(wide); // 21 > 20 per node
      // a valid DAG with 800 edges in total (node i depends on the 20 before it)
      const dense = Array.from({ length: 60 }, (_, i) =>
        node(`n${i}`, i < 20 ? [] : Array.from({ length: 20 }, (_, j) => `n${i - 1 - j}`)),
      );
      await bad(dense);
    });

    it("accepts a single-node workflow and applies defaults", async () => {
      const d = await create([{ key: "only", type: "wf.only" }]);
      assert.equal(d.nodes[0]!.state, "queued");
      const job = (await get(`/jobs/${d.nodes[0]!.jobId}`)).body;
      assert.equal(job.priority, 0);
      assert.equal(job.maxAttempts, 3);
      assert.deepEqual(job.payload, {});
    });
  });

  // ---------------------------------------------------------- atomic creation
  describe("creation is transactional", () => {
    it("if anything fails part-way, NOTHING is left behind", async () => {
      await db.query(`
        CREATE OR REPLACE FUNCTION reject_edge() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'edge insert refused'; END
        $$ LANGUAGE plpgsql`);
      await db.query(
        "CREATE TRIGGER reject_edge BEFORE INSERT ON workflow_edges FOR EACH ROW EXECUTE FUNCTION reject_edge()",
      );
      try {
        const r = await post("/workflows", { nodes: [node("a"), node("b", ["a"])] });
        assert.equal(r.status, 500);
        const left = await db.query(`SELECT
          (SELECT count(*) FROM workflows)::int AS workflows,
          (SELECT count(*) FROM workflow_nodes)::int AS nodes,
          (SELECT count(*) FROM workflow_edges)::int AS edges,
          (SELECT count(*) FROM jobs)::int AS jobs`);
        assert.deepEqual(left.rows[0], { workflows: 0, nodes: 0, edges: 0, jobs: 0 });
      } finally {
        await db.query("DROP TRIGGER IF EXISTS reject_edge ON workflow_edges");
        await db.query("DROP FUNCTION IF EXISTS reject_edge()");
      }
    });

    it("only nodes without dependencies get a job at creation", async () => {
      const d = await create([node("a"), node("b", ["a"]), node("c", ["a"]), node("x")]);
      assert.deepEqual(states(d), { a: "queued", b: "waiting", c: "waiting", x: "queued" });
      assert.equal(await jobCount(d.id), 2);
      assert.equal(d.status, "running");
      assert.deepEqual(d.progress, {
        total: 4,
        waiting: 2,
        queued: 2,
        running: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
      });
    });
  });

  // ------------------------------------------------------- dependency ordering
  describe("a node never starts before its dependencies succeed", () => {
    it("a chain advances one step at a time", async () => {
      const d = await create([node("a"), node("b", ["a"]), node("c", ["b"])]);
      const w = await register(["a", "b", "c"]);

      let jobs = await claim(w);
      assert.deepEqual(
        jobs.map((j) => j.type),
        ["wf.a"],
        "only the root is claimable",
      );
      assert.deepEqual(await claim(w), [], "b cannot be claimed while a is merely running");

      await complete(w, jobs[0]);
      assert.deepEqual(states(await detail(d.id)), { a: "succeeded", b: "queued", c: "waiting" });
      jobs = await claim(w);
      assert.deepEqual(
        jobs.map((j) => j.type),
        ["wf.b"],
      );
      await complete(w, jobs[0]);
      jobs = await claim(w);
      assert.deepEqual(
        jobs.map((j) => j.type),
        ["wf.c"],
      );
      await complete(w, jobs[0]);

      const done = await detail(d.id);
      assert.equal(done.status, "succeeded");
      assert.ok(done.finishedAt);
      assert.deepEqual(states(done), { a: "succeeded", b: "succeeded", c: "succeeded" });
    });

    it("a child's job is created in the same instant its parent finished, never earlier", async () => {
      const d = await create([node("a"), node("b", ["a"])]);
      await run(d.id, "a");
      const rows = await db.query(
        `SELECT j.type, j.created_at, j.finished_at FROM jobs j WHERE j.workflow_id = $1`,
        [d.id],
      );
      const a = rows.rows.find((r) => r.type === "wf.a");
      const b = rows.rows.find((r) => r.type === "wf.b");
      assert.ok(b.created_at >= a.finished_at, "b did not exist before a finished");
    });

    it("the job of a waiting node does not exist at all, so it cannot be fetched or finished", async () => {
      const d = await create([node("a"), node("b", ["a"])]);
      const reserved = (
        await db.query("SELECT job_id FROM workflow_nodes WHERE workflow_id = $1 AND key = 'b'", [
          d.id,
        ])
      ).rows[0].job_id;
      assert.equal((await get(`/jobs/${reserved}`)).status, 404);
      const w = await register(["a", "b"]);
      assert.equal(
        (await post(`/jobs/${reserved}/complete`, { workerId: w, attempt: 1 })).status,
        404,
      );
      assert.equal(
        d.nodes.find((n) => n.key === "b")!.jobId,
        null,
        "the API does not even reveal it",
      );
    });

    it("a diamond: the join node waits for BOTH branches", async () => {
      const d = await create([
        node("a"),
        node("b", ["a"]),
        node("c", ["a"]),
        node("d", ["b", "c"]),
      ]);
      await run(d.id, "a");
      assert.deepEqual(states(await detail(d.id)), {
        a: "succeeded",
        b: "queued",
        c: "queued",
        d: "waiting",
      });
      await run(d.id, "b");
      assert.equal(stateOf(await detail(d.id), "d"), "waiting", "one branch is not enough");
      assert.equal(await jobCount(d.id), 3);
      await run(d.id, "c");
      assert.equal(stateOf(await detail(d.id), "d"), "queued");
      await run(d.id, "d");
      assert.equal((await detail(d.id)).status, "succeeded");
    });

    it("fan-out releases every branch at once", async () => {
      const kids = ["k1", "k2", "k3", "k4", "k5"];
      const d = await create([node("root"), ...kids.map((k) => node(k, ["root"]))]);
      await run(d.id, "root");
      const after = await detail(d.id);
      for (const k of kids) assert.equal(stateOf(after, k), "queued");
    });

    it("node settings reach the job; separate workflows do not interfere", async () => {
      const one = await create([
        node("a", [], { priority: 42, maxAttempts: 7, payload: { x: 1 } }),
      ]);
      const two = await create([node("a")]);
      const job = (await get(`/jobs/${one.nodes[0]!.jobId}`)).body;
      assert.equal(job.priority, 42);
      assert.equal(job.maxAttempts, 7);
      assert.deepEqual(job.payload, { x: 1 });
      assert.equal(job.workflowId, one.id);
      await run(one.id, "a");
      assert.equal((await detail(two.id)).status, "running", "the other workflow is untouched");
    });

    it("GET /jobs?workflowId lists only that workflow's jobs", async () => {
      const a = await create([node("a"), node("b", ["a"])]);
      await create([node("a")]);
      await run(a.id, "a");
      const jobs = (await get(`/jobs?workflowId=${a.id}`)).body.items;
      assert.deepEqual(jobs.map((j: any) => j.type).sort(), ["wf.a", "wf.b"]);
      assert.equal((await get("/jobs?workflowId=nope")).status, 400);
    });
  });

  describe("job completion and child release are ONE atomic step", () => {
    it("if releasing the child fails, the parent's completion is rolled back with it", async () => {
      await db.query(`
        CREATE OR REPLACE FUNCTION reject_boom() RETURNS trigger AS $$
        BEGIN IF NEW.type = 'boom.job' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END
        $$ LANGUAGE plpgsql`);
      await db.query(
        "CREATE TRIGGER reject_boom BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_boom()",
      );
      try {
        // the child's job cannot be inserted, so releasing it fails when the parent completes
        const d = await create([node("a"), { key: "b", type: "boom.job", dependsOn: ["a"] }]);
        const w = await register(["a"]);
        const [a] = await claim(w);
        const r = await complete(w, a);
        assert.equal(r.status, 500, "the report failed, so the worker will retry it");

        const job = (await get(`/jobs/${a.id}`)).body;
        assert.equal(job.status, "running", "a was NOT left half-finished as 'succeeded'");
        const attempts = (await get(`/jobs/${a.id}/attempts`)).body.items;
        assert.equal(attempts[0].outcome, "running");
        assert.equal(stateOf(await detail(d.id), "b"), "waiting", "b was not half-released");
      } finally {
        await db.query("DROP TRIGGER IF EXISTS reject_boom ON jobs");
        await db.query("DROP FUNCTION IF EXISTS reject_boom()");
      }
    });
  });

  describe("concurrent completions (the lost wake-up race)", () => {
    it("ten parents finishing at the SAME moment release their child exactly once, 15 times over", async () => {
      const parents = Array.from({ length: 10 }, (_, i) => `p${i}`);
      for (let round = 0; round < 15; round++) {
        const d = await create([...parents.map((p) => node(p)), node("sink", parents)]);
        const w = await register(parents);
        const jobs = await claim(w, 10);
        assert.equal(jobs.length, 10);

        const results = await Promise.all(jobs.map((j) => complete(w, j)));
        assert.ok(results.every((r) => r.status === 200));

        const sinkJobs = await db.query(
          `SELECT count(*)::int AS n FROM jobs WHERE workflow_id = $1 AND type = 'wf.sink'`,
          [d.id],
        );
        assert.equal(sinkJobs.rows[0].n, 1, `round ${round}: sink released exactly once`);
        await run(d.id, "sink");
        assert.equal((await detail(d.id)).status, "succeeded", `round ${round}: workflow finished`);
      }
    });
  });

  describe("retries inside a workflow", () => {
    it("a parent that fails and is retried keeps its child waiting until it finally succeeds", async () => {
      const d = await create([node("a", [], { maxAttempts: 3 }), node("b", ["a"])]);
      const w = await register(["a"]);
      const [first] = await claim(w);
      const failed = await post(`/jobs/${first.id}/fail`, {
        workerId: w,
        attempt: first.attemptCount,
        error: "flaky",
      });
      assert.equal(failed.body.status, "queued", "scheduled for retry");
      let now = await detail(d.id);
      assert.deepEqual(states(now), { a: "queued", b: "waiting" });
      assert.equal(now.status, "running");
      assert.equal(await jobCount(d.id), 1, "the child still has no job");

      await db.query("UPDATE jobs SET run_at = now() WHERE id = $1", [first.id]);
      const [second] = await claim(w);
      assert.equal(second.attemptCount, 2);
      await complete(w, second);
      now = await detail(d.id);
      assert.equal(stateOf(now, "b"), "queued");
      assert.equal(now.nodes.find((n) => n.key === "a")!.attemptCount, 2);
    });
  });

  // ---------------------------------------------------------- failure semantics
  describe("failure semantics", () => {
    it("a failed node skips its descendants; independent branches still run; the workflow ends failed", async () => {
      //  a -> b -> c      a -> d
      const d = await create([
        node("a"),
        node("b", ["a"], { maxAttempts: 1 }),
        node("c", ["b"]),
        node("d", ["a"]),
      ]);
      await run(d.id, "a");
      const wb = await register(["b"]);
      const [jb] = await claim(wb);
      assert.equal((await failPermanently(wb, jb)).status, 200);

      let now = await detail(d.id);
      assert.deepEqual(states(now), { a: "succeeded", b: "failed", c: "skipped", d: "queued" });
      assert.equal(now.status, "running", "d is still pending, so the workflow is not over");

      await run(d.id, "d");
      now = await detail(d.id);
      assert.equal(now.status, "failed");
      assert.ok(now.finishedAt);
      assert.deepEqual(states(now), { a: "succeeded", b: "failed", c: "skipped", d: "succeeded" });
      assert.equal(now.progress.failed, 1);
      assert.equal(now.progress.skipped, 1);
      assert.equal(now.progress.succeeded, 2);
      assert.equal(await jobCount(d.id), 3, "the skipped node never got a job");
      assert.equal(now.nodes.find((n) => n.key === "b")!.lastError, "nope");
    });

    it("a failed root skips the entire downstream graph at once (cascade) and ends the workflow", async () => {
      const d = await create([
        node("a", [], { maxAttempts: 1 }),
        node("b", ["a"]),
        node("c", ["b"]),
        node("d", ["c"]),
        node("e", ["b", "d"]),
      ]);
      const w = await register(["a"]);
      const [job] = await claim(w);
      await failPermanently(w, job);
      const now = await detail(d.id);
      assert.deepEqual(states(now), {
        a: "failed",
        b: "skipped",
        c: "skipped",
        d: "skipped",
        e: "skipped",
      });
      assert.equal(now.status, "failed");
      assert.equal(await jobCount(d.id), 1);
    });

    it("only an EXHAUSTED job counts as failed: earlier failures are retries", async () => {
      const d = await create([node("a", [], { maxAttempts: 2 }), node("b", ["a"])]);
      const w = await register(["a"]);
      const [one] = await claim(w);
      await post(`/jobs/${one.id}/fail`, { workerId: w, attempt: 1, error: "x" });
      assert.equal(stateOf(await detail(d.id), "b"), "waiting");
      await db.query("UPDATE jobs SET run_at = now() WHERE id = $1", [one.id]);
      const [two] = await claim(w);
      await post(`/jobs/${two.id}/fail`, { workerId: w, attempt: 2, error: "x" });
      const now = await detail(d.id);
      assert.deepEqual(states(now), { a: "failed", b: "skipped" });
      assert.equal(now.status, "failed");
    });

    it("in a diamond, one failed branch dooms the join but the other branch still runs", async () => {
      const d = await create([
        node("a"),
        node("b", ["a"], { maxAttempts: 1 }),
        node("c", ["a"]),
        node("d", ["b", "c"]),
      ]);
      await run(d.id, "a");
      const wb = await register(["b"]);
      const [jb] = await claim(wb);
      await failPermanently(wb, jb);
      assert.equal(stateOf(await detail(d.id), "d"), "skipped");
      assert.equal(
        stateOf(await detail(d.id), "c"),
        "queued",
        "the healthy branch is not cancelled",
      );
      await run(d.id, "c");
      const now = await detail(d.id);
      assert.equal(now.status, "failed");
      assert.equal(stateOf(now, "c"), "succeeded");
    });

    it("a job lost to an expired lease with no attempts left also fails the workflow downstream", async () => {
      const d = await create([node("a", [], { maxAttempts: 1 }), node("b", ["a"])]);
      const w = await register(["a"]);
      const [job] = await claim(w);
      await db.query(
        "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [job.id],
      );
      const reaper = new LeaseReaper(lifecycleFor(db), 60_000);
      assert.equal(await reaper.runOnce(), 1);
      const now = await detail(d.id);
      assert.deepEqual(states(now), { a: "failed", b: "skipped" });
      assert.equal(now.status, "failed");
    });

    it("a lease expiry that only schedules a retry leaves the workflow waiting, not failed", async () => {
      const d = await create([node("a", [], { maxAttempts: 3 }), node("b", ["a"])]);
      const w = await register(["a"]);
      const [job] = await claim(w);
      await db.query(
        "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [job.id],
      );
      await new LeaseReaper(lifecycleFor(db), 60_000).runOnce();
      assert.deepEqual(states(await detail(d.id)), { a: "queued", b: "waiting" });
      assert.equal((await detail(d.id)).status, "running");
    });
  });

  // ---------------------------------------------------------------- cancellation
  describe("cancellation semantics", () => {
    //  roots a, b ; c waits on a ; d waits on b
    const setup = () => create([node("a"), node("b"), node("c", ["a"]), node("d", ["b"])]);

    it("skips waiting nodes, withdraws queued jobs, lets RUNNING jobs finish, then ends cancelled", async () => {
      const d = await setup();
      const w = await register(["a"]); // only a is claimed -> a running, b stays queued
      const [a] = await claim(w);

      const r = await post(`/workflows/${d.id}/cancel`);
      assert.equal(r.status, 200);
      assert.equal(r.body.cancelRequested, true);
      assert.equal(r.body.status, "running", "a is still executing, so not 'cancelled' yet");
      assert.deepEqual(states(r.body), {
        a: "running",
        b: "cancelled",
        c: "skipped",
        d: "skipped",
      });

      // the withdrawn job really cannot be claimed
      assert.deepEqual(await claim(await register(["b"])), []);

      // the running job finishes normally; its result is recorded but releases nothing
      assert.equal((await complete(w, a)).status, 200);
      const done = await detail(d.id);
      assert.equal(done.status, "cancelled");
      assert.ok(done.finishedAt);
      assert.deepEqual(states(done), {
        a: "succeeded",
        b: "cancelled",
        c: "skipped",
        d: "skipped",
      });
      assert.equal(await jobCount(d.id), 2, "c was never released");
    });

    it("with nothing running, cancellation finishes immediately", async () => {
      const d = await setup();
      const r = await post(`/workflows/${d.id}/cancel`);
      assert.equal(r.body.status, "cancelled");
      assert.deepEqual(states(r.body), {
        a: "cancelled",
        b: "cancelled",
        c: "skipped",
        d: "skipped",
      });
    });

    it("is idempotent", async () => {
      const d = await setup();
      const first = await post(`/workflows/${d.id}/cancel`);
      const second = await post(`/workflows/${d.id}/cancel`);
      assert.equal(second.status, 200);
      assert.deepEqual(second.body.progress, first.body.progress);
    });

    it("a running job that fails and would be RETRIED is cancelled instead of re-queued", async () => {
      const d = await create([node("a", [], { maxAttempts: 5 }), node("b", ["a"])]);
      const w = await register(["a"]);
      const [a] = await claim(w);
      await post(`/workflows/${d.id}/cancel`);
      const failed = await post(`/jobs/${a.id}/fail`, { workerId: w, attempt: 1, error: "x" });
      assert.equal(failed.status, 200);
      assert.equal(failed.body.status, "cancelled", "no retry after cancellation");
      const done = await detail(d.id);
      assert.equal(done.status, "cancelled");
      assert.deepEqual(await claim(w), []);
    });

    it("a running job lost to an expired lease is not retried after cancellation", async () => {
      const d = await create([node("a", [], { maxAttempts: 5 })]);
      const w = await register(["a"]);
      const [a] = await claim(w);
      await post(`/workflows/${d.id}/cancel`);
      await db.query(
        "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [a.id],
      );
      await new LeaseReaper(lifecycleFor(db), 60_000).runOnce();
      assert.equal((await detail(d.id)).status, "cancelled");
      assert.equal((await get(`/jobs/${a.id}`)).body.status, "cancelled");
    });

    it("cancelling a finished workflow is a 409; unknown is 404; malformed id is 400", async () => {
      const ok = await create([node("a")]);
      await run(ok.id, "a");
      const r = await post(`/workflows/${ok.id}/cancel`);
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "workflow_finished");

      const bad = await create([node("a", [], { maxAttempts: 1 })]);
      const w = await register(["a"]);
      const [job] = await claim(w);
      await failPermanently(w, job);
      assert.equal((await post(`/workflows/${bad.id}/cancel`)).status, 409);

      assert.equal((await post(`/workflows/${ghostId}/cancel`)).status, 404);
      assert.equal((await post("/workflows/not-a-uuid/cancel")).status, 400);
    });
  });

  // ---------------------------------------------------- progress and durability
  describe("progress and durability", () => {
    it("progress counts always add up to the total and match the node states", async () => {
      const d = await create([
        node("a"),
        node("b", ["a"]),
        node("c", ["a"]),
        node("d", ["b", "c"]),
      ]);
      for (const key of ["a", "b"]) {
        await run(d.id, key);
        const now = await detail(d.id);
        const p = now.progress;
        assert.equal(
          p.waiting + p.queued + p.running + p.succeeded + p.failed + p.cancelled + p.skipped,
          p.total,
        );
        for (const [state, count] of Object.entries(p)) {
          if (state !== "total") {
            assert.equal(now.nodes.filter((n) => n.state === state).length, count, state);
          }
        }
      }
    });

    it("progress survives an API restart and the workflow continues", async () => {
      const d = await create([node("a"), node("b", ["a"]), node("c", ["b"])]);
      await run(d.id, "a");
      const before = await detail(d.id);

      // "restart": throw away the server and the connection pool, start fresh ones
      await stopApi(started.server);
      await db.end();
      db = createPool(testDatabaseUrl);
      started = await startApi(db);

      assert.deepEqual(await detail(d.id), before, "state is read back identically");
      await run(d.id, "b");
      assert.equal(stateOf(await detail(d.id), "c"), "queued", "the restarted server released c");
      await run(d.id, "c");
      assert.equal((await detail(d.id)).status, "succeeded");
    });

    it("lists workflows newest first, filtered by status, with bounded limits", async () => {
      const first = await create([node("a")], "first");
      const second = await create([node("a")], "second");
      await run(second.id, "a");
      const all = (await get("/workflows")).body.items;
      assert.deepEqual(
        all.map((w: any) => w.name),
        ["second", "first"],
      );
      const running = (await get("/workflows?status=running")).body.items;
      assert.deepEqual(
        running.map((w: any) => w.id),
        [first.id],
      );
      assert.equal((await get("/workflows?status=succeeded")).body.items[0].id, second.id);
      assert.equal((await get("/workflows?limit=1")).body.items.length, 1);
      for (const qs of ["limit=0", "limit=101", "status=bogus"]) {
        assert.equal((await get(`/workflows?${qs}`)).status, 400, qs);
      }
    });

    it("unknown or malformed workflow ids", async () => {
      assert.equal((await get(`/workflows/${ghostId}`)).status, 404);
      assert.equal((await get("/workflows/nope")).status, 400);
    });
  });

  describe("database invariants", () => {
    it("rejects an edge from a node to itself, duplicate edges, and a running workflow with a finish time", async () => {
      const d = await create([node("a"), node("b", ["a"])]);
      const ids = (
        await db.query("SELECT id, key FROM workflow_nodes WHERE workflow_id = $1", [d.id])
      ).rows;
      const a = ids.find((r) => r.key === "a").id;
      const b = ids.find((r) => r.key === "b").id;
      await assert.rejects(db.query("INSERT INTO workflow_edges VALUES ($1, $2, $2)", [d.id, a]));
      await assert.rejects(
        db.query("INSERT INTO workflow_edges VALUES ($1, $2, $3)", [d.id, b, a]),
      );
      await assert.rejects(
        db.query("UPDATE workflows SET finished_at = now() WHERE id = $1", [d.id]),
      );
    });

    it("a cancelled job needs no owner, but a succeeded job still does", async () => {
      await db.query("INSERT INTO jobs (type, payload, status) VALUES ('x', '{}', 'cancelled')");
      await assert.rejects(
        db.query("INSERT INTO jobs (type, payload, status) VALUES ('x', '{}', 'succeeded')"),
      );
    });
  });

  // -------------------------------------------------------- real workers, end to end
  describe("end to end with SDK workers", () => {
    const silent = (): void => undefined;
    const workers: Worker[] = [];
    after(async () => {
      await Promise.all(workers.map((w) => w.stop()));
    });

    it("a diamond executes in dependency order with real handlers", async () => {
      const log: { key: string; event: "start" | "end"; at: number }[] = [];
      const worker = new Worker({
        apiUrl: started.url,
        concurrency: 4,
        pollIntervalMs: 20,
        log: silent,
      });
      workers.push(worker);
      for (const key of ["a", "b", "c", "d"]) {
        worker.register(`wf.${key}`, async () => {
          log.push({ key, event: "start", at: performance.now() });
          await new Promise((r) => setTimeout(r, 60));
          log.push({ key, event: "end", at: performance.now() });
        });
      }
      await worker.start();
      const d = await create([
        node("a"),
        node("b", ["a"]),
        node("c", ["a"]),
        node("d", ["b", "c"]),
      ]);
      await waitFor(
        async () => (await detail(d.id)).status === "succeeded",
        "workflow to finish",
        15_000,
      );

      const at = (key: string, event: "start" | "end") =>
        log.find((l) => l.key === key && l.event === event)!.at;
      assert.ok(at("b", "start") >= at("a", "end"), "b started after a ended");
      assert.ok(at("c", "start") >= at("a", "end"), "c started after a ended");
      assert.ok(
        at("d", "start") >= Math.max(at("b", "end"), at("c", "end")),
        "d started after BOTH ended",
      );
      await worker.stop();
    });

    it("a handler throwing PermanentError fails its branch, skips the rest, and the workflow ends failed", async () => {
      const ran: string[] = [];
      const worker = new Worker({
        apiUrl: started.url,
        concurrency: 4,
        pollIntervalMs: 20,
        log: silent,
      });
      workers.push(worker);
      worker
        .register("wf.a", async () => void ran.push("a"))
        .register("wf.b", async () => {
          ran.push("b");
          throw new PermanentError("cannot be done");
        })
        .register("wf.c", async () => void ran.push("c"))
        .register("wf.d", async () => void ran.push("d"));
      await worker.start();
      const d = await create([node("a"), node("b", ["a"]), node("c", ["b"]), node("d", ["a"])]);
      await waitFor(
        async () => (await detail(d.id)).status === "failed",
        "workflow to fail",
        15_000,
      );
      assert.deepEqual([...ran].sort(), ["a", "b", "d"], "c never ran");
      assert.deepEqual(states(await detail(d.id)), {
        a: "succeeded",
        b: "failed",
        c: "skipped",
        d: "succeeded",
      });
      await worker.stop();
    });
  });
});
