import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Authenticator } from "../../apps/api/src/ops/auth.js";
import { opsRoutes } from "../../apps/api/src/ops/routes.js";
import type { Db } from "@workmesh/api";
import {
  OPERATOR_KEY,
  VIEWER_KEY,
  api,
  resetTables,
  setupTestDb,
  startApi,
  stopApi,
  type Started,
} from "./helpers.js";

const ghostId = "00000000-0000-4000-8000-000000000000";
const near = (actual: number, expected: number, tolerance = 1e-6): void =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  );

/** Every operator-plane route, with the role it must require. The guard test below fails if the router has a route that is not listed here. */
const ROUTES: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  role: "viewer" | "operator";
  example: string;
}[] = [
  { method: "GET", path: "/me", role: "viewer", example: "/ops/me" },
  { method: "GET", path: "/stats", role: "viewer", example: "/ops/stats" },
  { method: "GET", path: "/workers", role: "viewer", example: "/ops/workers" },
  { method: "GET", path: "/audit", role: "viewer", example: "/ops/audit" },
  { method: "GET", path: "/metrics", role: "viewer", example: "/ops/metrics" },
  { method: "GET", path: "/keys", role: "viewer", example: "/ops/keys" },
  { method: "POST", path: "/keys", role: "operator", example: "/ops/keys" },
  {
    method: "POST",
    path: "/keys/:id/revoke",
    role: "operator",
    example: `/ops/keys/${ghostId}/revoke`,
  },
  { method: "GET", path: "/jobs", role: "viewer", example: "/ops/jobs" },
  { method: "GET", path: "/jobs/:id", role: "viewer", example: `/ops/jobs/${ghostId}` },
  {
    method: "GET",
    path: "/jobs/:id/attempts",
    role: "viewer",
    example: `/ops/jobs/${ghostId}/attempts`,
  },
  { method: "GET", path: "/workflows", role: "viewer", example: "/ops/workflows" },
  { method: "GET", path: "/workflows/:id", role: "viewer", example: `/ops/workflows/${ghostId}` },
  { method: "GET", path: "/schedules", role: "viewer", example: "/ops/schedules" },
  { method: "GET", path: "/schedules/:id", role: "viewer", example: `/ops/schedules/${ghostId}` },
  { method: "POST", path: "/jobs", role: "operator", example: "/ops/jobs" },
  {
    method: "POST",
    path: "/jobs/:id/cancel",
    role: "operator",
    example: `/ops/jobs/${ghostId}/cancel`,
  },
  {
    method: "POST",
    path: "/jobs/:id/retry",
    role: "operator",
    example: `/ops/jobs/${ghostId}/retry`,
  },
  {
    method: "POST",
    path: "/workflows/:id/cancel",
    role: "operator",
    example: `/ops/workflows/${ghostId}/cancel`,
  },
  {
    method: "PATCH",
    path: "/schedules/:id",
    role: "operator",
    example: `/ops/schedules/${ghostId}`,
  },
  {
    method: "DELETE",
    path: "/schedules/:id",
    role: "operator",
    example: `/ops/schedules/${ghostId}`,
  },
];

describe("operator plane (PostgreSQL)", () => {
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

  const as = (key: string | null) => {
    const headers: Record<string, string> = key === null ? {} : { authorization: `Bearer ${key}` };
    return {
      get: (p: string) => api(started.url, "GET", p, undefined, headers),
      post: (p: string, body: object = {}) => api(started.url, "POST", p, body, headers),
      patch: (p: string, body: object = {}) => api(started.url, "PATCH", p, body, headers),
      del: (p: string) => api(started.url, "DELETE", p, undefined, headers),
    };
  };
  const op = as(OPERATOR_KEY);
  const vw = as(VIEWER_KEY);
  const anon = as(null);
  const call = (who: ReturnType<typeof as>, r: (typeof ROUTES)[number]) =>
    r.method === "GET"
      ? who.get(r.example)
      : r.method === "DELETE"
        ? who.del(r.example)
        : r.method === "PATCH"
          ? who.patch(r.example, { enabled: true })
          : who.post(r.example, {});

  const machinePost = (p: string, body: object) => api(started.url, "POST", p, body);
  const submit = async (extra: object = {}, type = "ops.t"): Promise<string> => {
    const r = await machinePost("/jobs", { type, payload: {}, ...extra });
    assert.equal(r.status, 201);
    return r.body.id;
  };
  const registerWorker = async (types = ["ops.t"]): Promise<string> =>
    (await machinePost("/workers", { name: "w", jobTypes: types, concurrency: 5 })).body.id;
  const claim = async (workerId: string): Promise<any[]> =>
    (await machinePost(`/workers/${workerId}/claim`, { limit: 10 })).body.jobs;
  const finish = (workerId: string, job: any, how: "complete" | "fail") =>
    machinePost(
      `/jobs/${job.id}/${how}`,
      how === "complete"
        ? { workerId, attempt: job.attemptCount }
        : { workerId, attempt: job.attemptCount, error: "boom", retryable: false },
    );
  const auditActions = async (): Promise<string[]> =>
    (await op.get("/ops/audit?limit=200")).body.items.map((e: any) => e.action).reverse();

  // ------------------------------------------------------------------ authentication
  describe("authentication and roles", () => {
    it("GUARD: every route on the operator router is in the table above and declares a role", () => {
      const router: any = opsRoutes({
        auth: new Authenticator({ operatorKey: OPERATOR_KEY, viewerKey: VIEWER_KEY }),
      } as any);
      const found: string[] = [];
      for (const layer of router.stack) {
        if (!layer.route) continue;
        const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
        for (const m of methods) found.push(`${m.toUpperCase()} ${layer.route.path}`);
        assert.ok(
          layer.route.stack.length >= 2,
          `${methods} ${layer.route.path} has no role middleware in front of its handler`,
        );
      }
      const listed = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
      assert.deepEqual(
        found.sort(),
        listed,
        "a route was added or removed without updating this table",
      );
    });

    it("no key, a wrong key, or a malformed header is 401 on EVERY route", async () => {
      for (const route of ROUTES) {
        for (const who of [anon, as("definitely-not-a-key-0000")]) {
          const r = await call(who, route);
          assert.equal(r.status, 401, `${route.method} ${route.example}`);
          assert.equal(r.body.error.code, "unauthenticated");
        }
      }
      const noScheme = await api(started.url, "GET", "/ops/me", undefined, {
        authorization: OPERATOR_KEY,
      });
      assert.equal(noScheme.status, 401);
      const basic = await api(started.url, "GET", "/ops/me", undefined, {
        authorization: `Basic ${OPERATOR_KEY}`,
      });
      assert.equal(basic.status, 401);
      assert.match(
        String(anon && (await anon.get("/ops/me")).headers.get("www-authenticate")),
        /Bearer/i,
      );
    });

    it("a viewer can read everything but is 403 on every state-changing route", async () => {
      for (const route of ROUTES) {
        const r = await call(vw, route);
        if (route.role === "operator") {
          assert.equal(r.status, 403, `${route.method} ${route.example}`);
          assert.equal(r.body.error.code, "forbidden");
        } else {
          assert.notEqual(r.status, 401, route.example);
          assert.notEqual(r.status, 403, route.example);
        }
      }
    });

    it("an operator is never refused for authorization reasons", async () => {
      for (const route of ROUTES) {
        const r = await call(op, route);
        assert.ok(
          r.status !== 401 && r.status !== 403,
          `${route.method} ${route.example} -> ${r.status}`,
        );
      }
    });

    it("/ops/me reports the role and an actor fingerprint, never the key", async () => {
      const me = (await op.get("/ops/me")).body;
      assert.equal(me.role, "operator");
      assert.match(me.actor, /^operator:[0-9a-f]{8}$/);
      assert.ok(!JSON.stringify(me).includes(OPERATOR_KEY));
      assert.equal((await vw.get("/ops/me")).body.role, "viewer");
    });

    it("operator responses are marked no-store", async () => {
      assert.equal((await op.get("/ops/me")).headers.get("cache-control"), "no-store");
    });

    it("without keys configured the operator plane is not mounted at all", async () => {
      const bare = await startApi(db, {}, null);
      try {
        const r = await api(bare.url, "GET", "/ops/me", undefined, {
          authorization: `Bearer ${OPERATOR_KEY}`,
        });
        assert.equal(r.status, 404);
      } finally {
        await stopApi(bare.server);
      }
    });

    it("with machine authentication switched off (as in these older tests) the machine plane needs no key", async () => {
      assert.equal((await machinePost("/jobs", { type: "x", payload: {} })).status, 201);
      assert.equal((await api(started.url, "GET", "/healthz")).status, 200);
    });
  });

  // ------------------------------------------------------------------------ reads
  describe("read-only views", () => {
    it("lists and fetches jobs, attempts, workflows and schedules", async () => {
      const id = await submit();
      const w = await registerWorker();
      const [job] = await claim(w);
      await finish(w, job, "complete");

      const list = (await vw.get("/ops/jobs?status=succeeded")).body;
      assert.equal(list.items[0].id, id);
      assert.equal((await vw.get(`/ops/jobs/${id}`)).body.status, "succeeded");
      assert.equal((await vw.get(`/ops/jobs/${id}/attempts`)).body.items[0].outcome, "succeeded");
      assert.equal((await vw.get(`/ops/jobs/${ghostId}`)).status, 404);
      assert.equal((await vw.get("/ops/jobs/nope")).status, 400);
      assert.equal((await vw.get("/ops/jobs?limit=0")).status, 400);

      const wf = (await machinePost("/workflows", { nodes: [{ key: "a", type: "ops.t" }] })).body;
      assert.equal((await vw.get(`/ops/workflows/${wf.id}`)).body.id, wf.id);
      assert.equal((await vw.get("/ops/workflows")).body.items.length, 1);

      const sch = (
        await machinePost("/schedules", { name: "s", cron: "*/5 * * * *", jobType: "ops.t" })
      ).body;
      assert.equal((await vw.get(`/ops/schedules/${sch.id}`)).body.name, "s");
      assert.equal((await vw.get("/ops/schedules")).body.items.length, 1);
      assert.equal((await vw.get(`/ops/schedules/${ghostId}`)).status, 404);
    });
  });

  // ------------------------------------------------------------ job submission
  describe("submitting a job", () => {
    it("creates the job and an audit record that contains NO payload", async () => {
      const r = await op.post("/ops/jobs", {
        type: "ops.t",
        payload: { password: "hunter2" },
        priority: 7,
      });
      assert.equal(r.status, 201);
      assert.equal(r.headers.get("location"), `/ops/jobs/${r.body.id}`);
      const entries = (await op.get("/ops/audit")).body.items;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, "job.submit");
      assert.equal(entries[0].targetId, r.body.id);
      assert.equal(entries[0].role, "operator");
      assert.match(entries[0].actor, /^operator:/);
      assert.match(entries[0].requestId, /./);
      const everything = JSON.stringify(entries);
      assert.ok(!everything.includes("hunter2"), "payloads must never reach the audit log");
      assert.ok(!everything.includes(OPERATOR_KEY), "keys must never reach the audit log");
    });

    it("validates input exactly like the machine API, and records nothing when rejected", async () => {
      const r = await op.post("/ops/jobs", { type: "BAD TYPE", payload: [] });
      assert.equal(r.status, 400);
      assert.equal((await op.get("/ops/audit")).body.items.length, 0);
    });

    it("job and audit record are ONE transaction: if the audit insert fails, no job exists", async () => {
      await db.query(`
        CREATE OR REPLACE FUNCTION reject_audit() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'audit refused'; END
        $$ LANGUAGE plpgsql`);
      await db.query(
        "CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_audit()",
      );
      try {
        const r = await op.post("/ops/jobs", { type: "ops.t", payload: {} });
        assert.equal(r.status, 500);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n, 0);
      } finally {
        await db.query("DROP TRIGGER IF EXISTS reject_audit ON audit_log");
        await db.query("DROP FUNCTION IF EXISTS reject_audit()");
      }
    });
  });

  // ------------------------------------------------------------------ cancelling
  describe("cancelling a job (unsafe transitions are refused by the server)", () => {
    it("withdraws a queued job, which can then never be claimed", async () => {
      const id = await submit();
      const r = await op.post(`/ops/jobs/${id}/cancel`);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "cancelled");
      assert.ok(r.body.finishedAt);
      assert.deepEqual(await claim(await registerWorker()), []);
      assert.deepEqual(await auditActions(), ["job.cancel"]);
    });

    it("refuses a RUNNING job: it cannot be stopped safely", async () => {
      const id = await submit();
      const w = await registerWorker();
      await claim(w);
      const r = await op.post(`/ops/jobs/${id}/cancel`);
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "job_not_cancellable");
      assert.match(r.body.error.message, /running/);
      assert.equal((await op.get(`/ops/jobs/${id}`)).body.status, "running", "untouched");
      assert.deepEqual(await auditActions(), [], "a refused action leaves no record of success");
    });

    it("refuses finished and already-cancelled jobs, and unknown ids", async () => {
      const done = await submit();
      const w = await registerWorker();
      const [job] = await claim(w);
      await finish(w, job, "complete");
      assert.equal((await op.post(`/ops/jobs/${done}/cancel`)).status, 409);

      const again = await submit();
      await op.post(`/ops/jobs/${again}/cancel`);
      assert.equal((await op.post(`/ops/jobs/${again}/cancel`)).status, 409);

      assert.equal((await op.post(`/ops/jobs/${ghostId}/cancel`)).status, 404);
      assert.equal((await op.post("/ops/jobs/nope/cancel")).status, 400);
    });

    it("refuses a job that belongs to a workflow and points at the workflow instead", async () => {
      const wf = (await machinePost("/workflows", { nodes: [{ key: "a", type: "ops.t" }] })).body;
      const r = await op.post(`/ops/jobs/${wf.nodes[0].jobId}/cancel`);
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "job_in_workflow");
      assert.match(r.body.error.message, /cancel the workflow/);
    });

    it("cancel racing a claim: exactly one wins, never both (20 rounds)", async () => {
      const w = await registerWorker();
      for (let round = 0; round < 20; round++) {
        const id = await submit();
        const [cancelled, claimed] = await Promise.all([
          op.post(`/ops/jobs/${id}/cancel`),
          claim(w),
        ]);
        const finalStatus = (await op.get(`/ops/jobs/${id}`)).body.status;
        if (cancelled.status === 200) {
          assert.equal(finalStatus, "cancelled", `round ${round}`);
          assert.equal(claimed.length, 0, `round ${round}: a cancelled job was also claimed`);
        } else {
          assert.equal(cancelled.status, 409, `round ${round}`);
          assert.equal(finalStatus, "running", `round ${round}`);
          assert.equal(claimed.length, 1, `round ${round}`);
        }
      }
    });

    it("the action and its audit record are ONE transaction: if the audit insert fails, the job is untouched", async () => {
      const id = await submit();
      await db.query(`
        CREATE OR REPLACE FUNCTION reject_audit() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'audit refused'; END
        $$ LANGUAGE plpgsql`);
      await db.query(
        "CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_audit()",
      );
      try {
        assert.equal((await op.post(`/ops/jobs/${id}/cancel`)).status, 500);
        assert.equal(
          (await op.get(`/ops/jobs/${id}`)).body.status,
          "queued",
          "the cancel was rolled back",
        );
      } finally {
        await db.query("DROP TRIGGER IF EXISTS reject_audit ON audit_log");
        await db.query("DROP FUNCTION IF EXISTS reject_audit()");
      }
    });
  });

  // ------------------------------------------------------------------- retrying
  describe("retrying a failed job", () => {
    const failedJob = async (extra: object = {}) => {
      const id = await submit({ maxAttempts: 1, ...extra });
      const w = await registerWorker();
      const [job] = await claim(w);
      await finish(w, job, "fail");
      assert.equal((await op.get(`/ops/jobs/${id}`)).body.status, "failed");
      return { id, w, firstAttempt: job.attemptCount as number };
    };

    it("re-queues it with more attempts, keeps the history, and a worker can finish it", async () => {
      const { id, w } = await failedJob();
      const r = await op.post(`/ops/jobs/${id}/retry`, { attempts: 2 });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "queued");
      assert.equal(r.body.attemptCount, 1, "attempt_count is NOT reset (it is the fencing token)");
      assert.equal(r.body.maxAttempts, 3, "budget = attempts so far (1) + granted (2)");
      assert.equal(r.body.claimedBy, null);
      assert.equal(r.body.finishedAt, null);
      assert.ok(r.body.lastError, "the previous error stays visible until it succeeds");

      const [again] = await claim(w);
      assert.equal(again.id, id);
      assert.equal(again.attemptCount, 2);
      assert.equal((await finish(w, again, "complete")).status, 200);
      const done = (await op.get(`/ops/jobs/${id}`)).body;
      assert.equal(done.status, "succeeded");
      assert.equal(done.lastError, null);
      const attempts = (await op.get(`/ops/jobs/${id}/attempts`)).body.items;
      assert.deepEqual(
        attempts.map((a: any) => [a.attemptNumber, a.outcome]),
        [
          [1, "failed"],
          [2, "succeeded"],
        ],
      );
      assert.deepEqual(await auditActions(), ["job.retry"]);
      const entry = (await op.get("/ops/audit")).body.items[0];
      assert.equal(entry.details.attemptsGranted, 2);
    });

    it("defaults to one extra attempt", async () => {
      const { id } = await failedJob();
      const r = await op.post(`/ops/jobs/${id}/retry`);
      assert.equal(r.body.maxAttempts, 2);
    });

    it("a late report from the FIRST attempt is still rejected after a retry (fencing survives)", async () => {
      const { id, w, firstAttempt } = await failedJob();
      await op.post(`/ops/jobs/${id}/retry`);
      const [second] = await claim(w);
      const stale = await machinePost(`/jobs/${id}/complete`, {
        workerId: w,
        attempt: firstAttempt,
      });
      assert.equal(stale.status, 409);
      assert.equal((await finish(w, second, "complete")).status, 200);
    });

    it("refuses anything that is not failed", async () => {
      const queued = await submit();
      assert.equal(
        (await op.post(`/ops/jobs/${queued}/retry`)).body.error.code,
        "job_not_retryable",
      );

      const running = await submit();
      const w = await registerWorker();
      const [job] = (await claim(w)).filter((j) => j.id === running);
      assert.ok(job);
      assert.equal((await op.post(`/ops/jobs/${running}/retry`)).status, 409);

      await finish(w, job, "complete");
      assert.equal((await op.post(`/ops/jobs/${running}/retry`)).status, 409, "succeeded");

      const cancelled = await submit();
      await op.post(`/ops/jobs/${cancelled}/cancel`);
      assert.equal((await op.post(`/ops/jobs/${cancelled}/retry`)).status, 409, "cancelled");

      assert.equal((await op.post(`/ops/jobs/${ghostId}/retry`)).status, 404);
      assert.deepEqual(await auditActions(), ["job.cancel"], "only the cancel succeeded");
    });

    it("refuses a failed job that belongs to a workflow", async () => {
      const wf = (
        await machinePost("/workflows", { nodes: [{ key: "a", type: "ops.t", maxAttempts: 1 }] })
      ).body;
      const w = await registerWorker();
      const [job] = await claim(w);
      await finish(w, job, "fail");
      const r = await op.post(`/ops/jobs/${wf.nodes[0].jobId}/retry`);
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "job_in_workflow");
    });

    it("bounds the number of extra attempts and the total budget", async () => {
      const { id } = await failedJob();
      for (const attempts of [0, 21, 1.5, "2"]) {
        assert.equal(
          (await op.post(`/ops/jobs/${id}/retry`, { attempts })).status,
          400,
          String(attempts),
        );
      }
      assert.equal((await op.post(`/ops/jobs/${id}/retry`, { surprise: 1 })).status, 400);
      await db.query("UPDATE jobs SET attempt_count = 999, max_attempts = 999 WHERE id = $1", [id]);
      const r = await op.post(`/ops/jobs/${id}/retry`, { attempts: 5 });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "retry_budget_exhausted");
      assert.equal((await op.get(`/ops/jobs/${id}`)).body.status, "failed");
    });
  });

  // -------------------------------------------------------- workflows & schedules
  describe("workflow and schedule controls", () => {
    it("cancelling a workflow is audited; finished and unknown workflows are refused", async () => {
      const wf = (
        await machinePost("/workflows", {
          nodes: [
            { key: "a", type: "ops.t" },
            { key: "b", type: "ops.t", dependsOn: ["a"] },
          ],
        })
      ).body;
      const r = await op.post(`/ops/workflows/${wf.id}/cancel`);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "cancelled");
      assert.deepEqual(await auditActions(), ["workflow.cancel"]);
      assert.equal(
        (await op.post(`/ops/workflows/${wf.id}/cancel`)).status,
        200,
        "idempotent while cancelled",
      );

      const done = (await machinePost("/workflows", { nodes: [{ key: "x", type: "ops.t" }] })).body;
      const w = await registerWorker();
      const [job] = await claim(w);
      await finish(w, job, "complete");
      const refused = await op.post(`/ops/workflows/${done.id}/cancel`);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, "workflow_finished");
      assert.equal((await op.post(`/ops/workflows/${ghostId}/cancel`)).status, 404);
    });

    it("enabling, disabling and deleting a schedule are audited", async () => {
      const sch = (
        await machinePost("/schedules", { name: "nightly", cron: "0 3 * * *", jobType: "ops.t" })
      ).body;
      const off = await op.patch(`/ops/schedules/${sch.id}`, { enabled: false });
      assert.equal(off.body.enabled, false);
      const on = await op.patch(`/ops/schedules/${sch.id}`, { enabled: true });
      assert.equal(on.body.enabled, true);
      assert.equal((await op.del(`/ops/schedules/${sch.id}`)).status, 204);
      assert.deepEqual(await auditActions(), [
        "schedule.disable",
        "schedule.enable",
        "schedule.delete",
      ]);
      assert.equal((await op.del(`/ops/schedules/${sch.id}`)).status, 404);
      assert.equal((await op.patch(`/ops/schedules/${ghostId}`, { enabled: true })).status, 404);
      assert.equal((await op.patch(`/ops/schedules/${sch.id}`, { enabled: "yes" })).status, 400);
    });
  });

  // ------------------------------------------------------------------- audit log
  describe("audit log", () => {
    it("is newest first, paginates with `before`, and validates its parameters", async () => {
      for (let i = 0; i < 5; i++) await op.post("/ops/jobs", { type: "ops.t", payload: { i } });
      const first = (await vw.get("/ops/audit?limit=2")).body;
      assert.equal(first.items.length, 2);
      assert.ok(first.nextBefore);
      const second = (await vw.get(`/ops/audit?limit=2&before=${first.nextBefore}`)).body;
      assert.equal(second.items.length, 2);
      const third = (await vw.get(`/ops/audit?limit=2&before=${second.nextBefore}`)).body;
      assert.equal(third.items.length, 1);
      assert.equal(third.nextBefore, null);
      const ids = [...first.items, ...second.items, ...third.items].map((e: any) => BigInt(e.id));
      assert.deepEqual(
        [...ids].sort((a, b) => (a > b ? -1 : 1)),
        ids,
        "strictly newest first, no repeats",
      );
      assert.equal(new Set(ids).size, 5);
      for (const qs of ["limit=0", "limit=201", "before=abc", "before=-1"]) {
        assert.equal((await vw.get(`/ops/audit?${qs}`)).status, 400, qs);
      }
    });
  });

  // ---------------------------------------------------------------------- workers
  describe("workers", () => {
    it("shows health, job types, concurrency and how many jobs each worker is running", async () => {
      const busy = await registerWorker(["ops.t", "ops.u"]);
      const idle = (
        await machinePost("/workers", { name: "idle", jobTypes: ["x.y"], concurrency: 1 })
      ).body.id;
      await submit();
      await submit();
      await claim(busy);

      const r = (await vw.get("/ops/workers")).body;
      assert.equal(r.staleAfterMs, 30_000);
      const byId = new Map<string, any>(r.items.map((w: any) => [w.id, w]));
      assert.equal(byId.get(busy).runningJobs, 2);
      assert.deepEqual(byId.get(busy).jobTypes, ["ops.t", "ops.u"]);
      assert.equal(byId.get(busy).concurrency, 5);
      assert.equal(byId.get(idle).runningJobs, 0);
      assert.equal(byId.get(idle).health, "alive");
    });

    it("marks a worker stale once its heartbeat is older than the threshold, and hides very old ones", async () => {
      const fresh = await registerWorker();
      const stale = await registerWorker();
      const ancient = await registerWorker();
      await db.query(
        "UPDATE workers SET last_heartbeat_at = now() - interval '2 minutes' WHERE id = $1",
        [stale],
      );
      await db.query(
        "UPDATE workers SET last_heartbeat_at = now() - interval '25 hours' WHERE id = $1",
        [ancient],
      );

      const items = (await vw.get("/ops/workers")).body.items;
      const health = Object.fromEntries(items.map((w: any) => [w.id, w.health]));
      assert.equal(health[fresh], "alive");
      assert.equal(health[stale], "stale");
      assert.ok(!(ancient in health), "workers silent for more than 24 h are not listed");
      near(items.find((w: any) => w.id === stale).lastHeartbeatAgeSeconds, 120, 5);
      assert.equal(items[0].id, fresh, "most recently seen first");
      assert.equal((await vw.get("/ops/workers?limit=1")).body.items.length, 1);
      assert.equal((await vw.get("/ops/workers?limit=0")).status, 400);
    });
  });

  // ------------------------------------------------------------------------ stats
  describe("statistics are computed from real rows", () => {
    it("an empty system reports zeros and nulls, not invented numbers", async () => {
      const s = (await vw.get("/ops/stats")).body;
      assert.deepEqual(s.queue, {
        queued: 0,
        ready: 0,
        scheduled: 0,
        running: 0,
        oldestReadyAgeSeconds: null,
      });
      assert.equal(s.window.succeeded, 0);
      assert.equal(s.window.executionSeconds, null);
      assert.equal(s.window.waitSeconds, null);
      assert.equal(s.window.throughputPerMinute, 0);
      assert.deepEqual(s.workers, { alive: 0, stale: 0 });
      assert.ok(s.series.length >= 60);
      assert.ok(s.series.every((b: any) => b.succeeded === 0 && b.failed === 0));
    });

    it("matches a hand-built fixture exactly", async () => {
      const worker = (
        await db.query(
          "INSERT INTO workers (name, job_types, concurrency) VALUES ('w', ARRAY['s.t'], 1) RETURNING id",
        )
      ).rows[0].id;
      const addJob = async (
        status: string,
        finishedAgo: string | null,
        extra: { runAt?: string } = {},
      ): Promise<string> =>
        (
          await db.query(
            `INSERT INTO jobs (type, payload, status, claimed_by, finished_at, attempt_count, lease_expires_at, run_at, scheduled_for)
             VALUES ('s.t', '{}', $1, $2, ${finishedAgo ? `now() - interval '${finishedAgo}'` : "NULL"}, 1,
                     ${status === "running" ? "now() + interval '1 minute'" : "NULL"},
                     ${extra.runAt ? `now() + interval '${extra.runAt}'` : "now()"}, ${extra.runAt ? `now() + interval '${extra.runAt}'` : "now()"})
             RETURNING id`,
            [status, status === "queued" || status === "cancelled" ? null : worker],
          )
        ).rows[0].id;
      const addAttempt = (
        job: string,
        n: number,
        outcome: string,
        startedAgo: string,
        seconds: number,
        waitSeconds: number,
      ) =>
        db
          .query(
            `INSERT INTO job_attempts (job_id, attempt_number, worker_id, outcome, started_at, finished_at)
           VALUES ($1, $2, $3, $4, now() - interval '${startedAgo}', now() - interval '${startedAgo}' + ($5 * interval '1 second'))`,
            [job, n, worker, outcome, seconds],
          )
          .then(() =>
            db.query(
              "UPDATE jobs SET scheduled_for = (SELECT started_at FROM job_attempts WHERE job_id = $1 AND attempt_number = 1) - ($2 * interval '1 second') WHERE id = $1",
              [job, waitSeconds],
            ),
          );

      // 4 successes in the last hour: ran 2,4,6,8 s; waited 1,3,5,7 s
      for (const [i, run] of [2, 4, 6, 8].entries()) {
        const id = await addJob("succeeded", "5 minutes");
        await addAttempt(id, 1, "succeeded", `${5 + run / 60 + 0.001 * i} minutes`, run, 1 + 2 * i);
      }
      // 2 failures: F1 tried 3 times (2 retries), F2 lost its lease once
      const f1 = await addJob("failed", "10 minutes");
      await addAttempt(f1, 1, "failed", "20 minutes", 1, 0);
      await addAttempt(f1, 2, "failed", "15 minutes", 1, 0);
      await addAttempt(f1, 3, "failed", "10 minutes", 1, 0);
      const f2 = await addJob("failed", "8 minutes");
      await addAttempt(f2, 1, "lease_expired", "9 minutes", 60, 0);
      // 1 cancelled
      await addJob("cancelled", "3 minutes");
      // an old success (61 min ago) with a retry 90 min ago: outside a 60 minute window
      const old = await addJob("succeeded", "61 minutes");
      await addAttempt(old, 1, "succeeded", "100 minutes", 5, 0);
      await addAttempt(old, 2, "succeeded", "90 minutes", 5, 0);
      // right now: 3 ready (oldest 10 min), 2 scheduled for later, 2 running
      await db.query(
        "INSERT INTO jobs (type, payload, run_at, scheduled_for) VALUES ('q.t','{}', now() - interval '10 minutes', now() - interval '10 minutes'), ('q.t','{}', now() - interval '1 minute', now() - interval '1 minute'), ('q.t','{}', now() - interval '1 second', now() - interval '1 second'), ('q.t','{}', now() + interval '1 hour', now() + interval '1 hour'), ('q.t','{}', now() + interval '2 hours', now() + interval '2 hours')",
      );
      await addJob("running", null);
      await addJob("running", null);

      const s = (await vw.get("/ops/stats?windowMinutes=60")).body;
      assert.deepEqual(
        { ...s.queue, oldestReadyAgeSeconds: null },
        { queued: 5, ready: 3, scheduled: 2, running: 2, oldestReadyAgeSeconds: null },
      );
      near(s.queue.oldestReadyAgeSeconds, 600, 5);
      assert.equal(s.window.succeeded, 4, "the 61-minute-old success is outside the window");
      assert.equal(s.window.failed, 2);
      assert.equal(s.window.cancelled, 1);
      assert.equal(s.window.retries, 2, "attempts beyond the first that started inside the window");
      assert.equal(s.window.leaseExpirations, 1);
      near(s.window.throughputPerMinute, 4 / 60);
      near(s.window.executionSeconds.p50, 5);
      near(s.window.executionSeconds.p95, 7.7);
      near(s.window.executionSeconds.max, 8);
      // first attempts that started in the window: waits [1,3,5,7] plus F1 and F2 at 0 -> p50 2, p95 6.5
      near(s.window.waitSeconds.p50, 2);
      near(s.window.waitSeconds.p95, 6.5);
      near(s.window.waitSeconds.max, 7);
      assert.equal(
        s.series.reduce((n: number, b: any) => n + b.succeeded, 0),
        4,
      );
      assert.equal(
        s.series.reduce((n: number, b: any) => n + b.failed, 0),
        2,
      );

      const wide = (await vw.get("/ops/stats?windowMinutes=120")).body;
      assert.equal(wide.window.succeeded, 5, "the older success is inside a 120-minute window");
      assert.equal(wide.window.retries, 3);
      assert.equal(
        wide.series.reduce((n: number, b: any) => n + b.succeeded, 0),
        5,
      );
    });

    it("chart buckets are evenly spaced, ascending, and sized so that any window has about 60 of them", async () => {
      for (const [windowMinutes, bucketMinutes] of [
        [5, 1],
        [60, 1],
        [240, 4],
        [1440, 24],
      ] as const) {
        const s = (await vw.get(`/ops/stats?windowMinutes=${windowMinutes}`)).body;
        assert.equal(s.bucketMinutes, bucketMinutes);
        assert.ok(
          s.series.length >= windowMinutes / bucketMinutes &&
            s.series.length <= windowMinutes / bucketMinutes + 2,
          `${windowMinutes}: ${s.series.length} buckets`,
        );
        for (let i = 1; i < s.series.length; i++) {
          assert.equal(
            Date.parse(s.series[i].start) - Date.parse(s.series[i - 1].start),
            bucketMinutes * 60_000,
          );
        }
      }
    });

    it("validates the window", async () => {
      for (const qs of ["windowMinutes=0", "windowMinutes=1441", "windowMinutes=abc", "other=1"]) {
        assert.equal((await vw.get(`/ops/stats?${qs}`)).status, 400, qs);
      }
    });

    it("counts live workers", async () => {
      const a = await registerWorker();
      await registerWorker();
      await db.query(
        "UPDATE workers SET last_heartbeat_at = now() - interval '5 minutes' WHERE id = $1",
        [a],
      );
      assert.deepEqual((await vw.get("/ops/stats")).body.workers, { alive: 1, stale: 1 });
    });
  });
});
