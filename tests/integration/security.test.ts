import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Scheduler, type Db } from "@workmesh/api";
import { ApiError, Worker } from "@workmesh/worker-sdk";
import { MachineAuth } from "../../apps/api/src/keys/auth.js";
import { parseKey } from "../../apps/api/src/keys/keys.js";
import { ApiKeyRepository } from "../../apps/api/src/keys/repository.js";
import { jobRoutes } from "../../apps/api/src/jobs/routes.js";
import { scheduleRoutes } from "../../apps/api/src/schedules/routes.js";
import { workerRoutes } from "../../apps/api/src/workers/routes.js";
import { workflowRoutes } from "../../apps/api/src/workflows/routes.js";
import {
  OPERATOR_KEY,
  SECURE_AUTH,
  VIEWER_KEY,
  api,
  resetTables,
  setupTestDb,
  startApi,
  stopApi,
  waitFor,
  type Started,
} from "./helpers.js";

const ghostId = "00000000-0000-4000-8000-000000000000";
const op = { authorization: `Bearer ${OPERATOR_KEY}` };
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

interface Issued {
  id: string;
  prefix: string;
  secret: string;
  kind: string;
  account: string;
}

describe("machine-plane security (PostgreSQL)", () => {
  let db: Db;
  let a: Started;
  let b: Started;

  before(async () => {
    db = await setupTestDb();
    // Two instances: a key checked or revoked through one must behave the same through the other.
    a = await startApi(db, {}, SECURE_AUTH);
    b = await startApi(db, {}, SECURE_AUTH);
  });
  beforeEach(() => resetTables(db));
  after(async () => {
    await stopApi(a.server);
    await stopApi(b.server);
    await db.end();
  });

  const issue = async (
    kind: "client" | "worker",
    account = "default",
    extra: Record<string, unknown> = {},
  ): Promise<Issued> => {
    const r = await api(
      a.url,
      "POST",
      "/ops/keys",
      { kind, account, name: `${kind}-${account}`, ...extra },
      op,
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const call = (
    s: Started,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    key: string | null,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => api(s.url, method, path, body, { ...(key ? bearer(key) : {}), ...headers });

  /** Captures everything the process writes to the console while `fn` runs. */
  const captureLogs = async <T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> => {
    const lines: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    const grab = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    console.log = grab;
    console.warn = grab;
    console.error = grab;
    try {
      return { result: await fn(), text: lines.join("\n") };
    } finally {
      Object.assign(console, originals);
    }
  };

  // ------------------------------------------------------------------ key lifecycle
  describe("API key lifecycle", () => {
    it("the secret is shown once, and never stored or listed", async () => {
      const k = await issue("client");
      assert.match(k.secret, /^wm_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/);
      assert.equal(k.secret.slice(3, 11), k.prefix);

      const list = await api(a.url, "GET", "/ops/keys", undefined, op);
      assert.equal(list.status, 200);
      const text = JSON.stringify(list.body);
      assert.ok(!text.includes(k.secret), "the list never contains the key");
      assert.ok(!text.includes(k.secret.slice(12)), "nor its secret part");
      assert.ok(!/secret/i.test(text.replace(/"secret"/g, "")) || !text.includes('"secret"'));
      assert.equal(list.body.items[0].prefix, k.prefix);
      assert.equal(list.body.items[0].status, "active");

      const stored = await db.query(
        `SELECT encode(secret_hash, 'escape') AS raw, length(secret_hash) AS len FROM api_keys`,
      );
      assert.equal(stored.rows[0].len, 32, "a SHA-256 digest, not the key");
      assert.ok(!String(stored.rows[0].raw).includes(k.secret.slice(12)));
    });

    it("a viewer may list keys but not create or revoke them", async () => {
      const viewer = { authorization: `Bearer ${VIEWER_KEY}` };
      assert.equal((await api(a.url, "GET", "/ops/keys", undefined, viewer)).status, 200);
      const create = await api(a.url, "POST", "/ops/keys", { kind: "client", name: "x" }, viewer);
      assert.equal(create.status, 403);
      const k = await issue("client");
      assert.equal((await api(a.url, "POST", `/ops/keys/${k.id}/revoke`, {}, viewer)).status, 403);
    });

    it("an unknown, malformed, or wrong key is 401 on every machine route and says nothing about why", async () => {
      const real = await issue("client");
      const wrongSecret = `wm_${real.prefix}_${"A".repeat(43)}`;
      const unknownPrefix = `wm_deadbeef_${"B".repeat(43)}`;
      for (const key of [null, "garbage", wrongSecret, unknownPrefix, OPERATOR_KEY, VIEWER_KEY]) {
        const r = await call(a, "GET", "/jobs", key);
        assert.equal(r.status, 401, String(key));
        assert.equal(r.body.error.code, "unauthenticated");
        assert.match(String(r.headers.get("www-authenticate")), /Bearer/i);
      }
      const bodies = await Promise.all(
        [wrongSecret, unknownPrefix].map((k) => call(a, "GET", "/jobs", k)),
      );
      assert.equal(
        bodies[0]!.body.error.message,
        bodies[1]!.body.error.message,
        "a wrong secret and an unknown key look identical",
      );
    });

    it("a client key cannot use worker routes and a worker key cannot use client routes (403)", async () => {
      const client = await issue("client");
      const worker = await issue("worker");
      const asClient = await call(a, "POST", "/workers", client.secret, {
        name: "w",
        jobTypes: ["x"],
        concurrency: 1,
      });
      assert.equal(asClient.status, 403);
      assert.equal(asClient.body.error.code, "forbidden");
      const asWorker = await call(a, "POST", "/jobs", worker.secret, { type: "x", payload: {} });
      assert.equal(asWorker.status, 403);
    });

    it("a machine key cannot reach the operator plane", async () => {
      const client = await issue("client");
      const r = await call(a, "GET", "/ops/me", client.secret);
      assert.equal(r.status, 401);
    });

    it("revocation takes effect immediately, on every instance", async () => {
      const k = await issue("client");
      assert.equal((await call(a, "GET", "/jobs", k.secret)).status, 200);
      assert.equal((await call(b, "GET", "/jobs", k.secret)).status, 200);
      const revoked = await api(a.url, "POST", `/ops/keys/${k.id}/revoke`, {}, op);
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.status, "revoked");
      assert.equal((await call(a, "GET", "/jobs", k.secret)).status, 401);
      assert.equal((await call(b, "GET", "/jobs", k.secret)).status, 401, "the other instance too");
      assert.equal(
        (await call(b, "POST", "/jobs", k.secret, { type: "x", payload: {} })).status,
        401,
      );
    });

    it("revoking twice is harmless and keeps the first revoker and time", async () => {
      const k = await issue("client");
      const first = await api(a.url, "POST", `/ops/keys/${k.id}/revoke`, {}, op);
      const second = await api(a.url, "POST", `/ops/keys/${k.id}/revoke`, {}, op);
      assert.equal(second.status, 200);
      assert.equal(second.body.revokedAt, first.body.revokedAt);
      const audit = await api(a.url, "GET", "/ops/audit", undefined, op);
      assert.equal(audit.body.items.filter((e: any) => e.action === "key.revoke").length, 1);
      assert.equal((await api(a.url, "POST", `/ops/keys/${ghostId}/revoke`, {}, op)).status, 404);
    });

    it("a key stops working when it expires, without anyone revoking it", async () => {
      const k = await issue("client", "default", { expiresInDays: 1 });
      assert.ok(k.secret);
      assert.equal((await call(a, "GET", "/jobs", k.secret)).status, 200);
      await db.query(
        `UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = '${k.id}'`,
      );
      assert.equal((await call(a, "GET", "/jobs", k.secret)).status, 401);
      const list = await api(a.url, "GET", "/ops/keys", undefined, op);
      assert.equal(list.body.items[0].status, "expired");
    });

    it("rotation: a new key works alongside the old one, then the old one is revoked", async () => {
      const oldKey = await issue("client", "acme");
      const newKey = await issue("client", "acme");
      const job = await call(a, "POST", "/jobs", oldKey.secret, { type: "x", payload: {} });
      assert.equal(job.status, 201);
      assert.equal(
        (await call(a, "GET", "/jobs", newKey.secret)).status,
        200,
        "both valid at once",
      );
      await api(a.url, "POST", `/ops/keys/${oldKey.id}/revoke`, {}, op);
      assert.equal((await call(a, "GET", "/jobs", oldKey.secret)).status, 401);
      const still = await call(a, "GET", `/jobs/${job.body.id}`, newKey.secret);
      assert.equal(still.status, 200, "the same account's data survives the rotation");
    });

    it("records last use, but at most once a minute per key", async () => {
      const k = await issue("client");
      await call(a, "GET", "/jobs", k.secret);
      const first = (await db.query(`SELECT last_used_at FROM api_keys`)).rows[0].last_used_at;
      assert.ok(first, "set on first use");
      await call(a, "GET", "/jobs", k.secret);
      const second = (await db.query(`SELECT last_used_at FROM api_keys`)).rows[0].last_used_at;
      assert.equal(second.getTime(), first.getTime(), "not rewritten on every request");
      await db.query(`UPDATE api_keys SET last_used_at = now() - interval '2 minutes'`);
      await call(a, "GET", "/jobs", k.secret);
      const third = (await db.query(`SELECT last_used_at FROM api_keys`)).rows[0].last_used_at;
      assert.ok(third.getTime() > Date.now() - 60_000, "refreshed once stale");
    });

    it("authentication costs one statement per request; the last-use write happens once a minute, not on every request", async () => {
      const k = await issue("client");
      const seen: string[] = [];
      const spy = {
        query: (sql: string, params?: unknown[]) => (
          seen.push(sql),
          (db.query as any)(sql, params)
        ),
      } as unknown as Db;
      const repo = new ApiKeyRepository(spy);
      const parsed = parseKey(k.secret)!;
      for (let i = 0; i < 5; i++) assert.equal((await repo.authenticate(parsed)).ok, true);
      const selects = seen.filter((q) => /^\s*SELECT/i.test(q)).length;
      const updates = seen.filter((q) => /UPDATE api_keys/i.test(q)).length;
      assert.equal(selects, 5, "one lookup per request");
      assert.equal(updates, 1, "the first use writes last_used_at; the next four do not");
    });

    it("key creation and revocation are audited, with the key's identity but never its secret", async () => {
      const k = await issue("worker", "acme", { jobTypes: ["email.send"] });
      await api(a.url, "POST", `/ops/keys/${k.id}/revoke`, {}, op);
      const audit = await api(a.url, "GET", "/ops/audit", undefined, op);
      const actions = audit.body.items.map((e: any) => e.action);
      assert.ok(actions.includes("key.create") && actions.includes("key.revoke"));
      const entry = audit.body.items.find((e: any) => e.action === "key.create");
      assert.equal(entry.details.prefix, k.prefix);
      assert.equal(entry.details.account, "acme");
      const text = JSON.stringify(audit.body);
      assert.ok(!text.includes(k.secret) && !text.includes(k.secret.slice(12)));
    });

    it("rejects malformed key requests", async () => {
      const bad: object[] = [
        { kind: "admin", name: "x" },
        { kind: "client", name: "" },
        { kind: "client", name: "x", account: "Has Spaces" },
        { kind: "client", name: "x", jobTypes: ["a"] },
        { kind: "worker", name: "x", jobTypes: [] },
        { kind: "client", name: "x", expiresInDays: 0 },
        { kind: "client", name: "x", extra: true },
      ];
      for (const body of bad) {
        const r = await api(a.url, "POST", "/ops/keys", body, op);
        assert.equal(r.status, 400, JSON.stringify(body));
      }
    });
  });

  // ---------------------------------------------------- every machine route is guarded
  describe("coverage", () => {
    it("GUARD: every route on the machine routers is 401 without a key", async () => {
      const auth = new MachineAuth(null);
      const routers = [
        jobRoutes({} as any, {} as any, auth),
        scheduleRoutes({} as any, auth),
        workflowRoutes({} as any, auth),
        workerRoutes({} as any, {} as any, auth),
      ];
      const found: string[] = [];
      for (const router of routers as any[]) {
        for (const layer of router.stack) {
          if (!layer.route) continue;
          for (const method of Object.keys(layer.route.methods)) {
            found.push(`${method.toUpperCase()} ${layer.route.path}`);
            const path = String(layer.route.path).replace(/:\w+/g, ghostId);
            const r = await api(
              a.url,
              method.toUpperCase() as "GET",
              path,
              method === "get" ? undefined : {},
            );
            assert.equal(
              r.status,
              401,
              `${method.toUpperCase()} ${layer.route.path} is reachable without a key`,
            );
          }
        }
      }
      assert.ok(
        found.length >= 19,
        `expected the whole machine plane, found ${found.length} routes`,
      );
    });

    it("GUARD: the real server switches machine authentication on", () => {
      const source = readFileSync(new URL("../../apps/api/src/server.ts", import.meta.url), "utf8");
      assert.match(source, /machineAuth:\s*true/);
    });
  });

  // ------------------------------------------------------------ authorization: isolation
  describe("accounts are isolated from each other", () => {
    it("a client never sees, reads, or lists another account's jobs", async () => {
      const acme = await issue("client", "acme");
      const globex = await issue("client", "globex");
      const mine = await call(a, "POST", "/jobs", acme.secret, {
        type: "email.send",
        payload: { secret: 1 },
      });
      const theirs = await call(a, "POST", "/jobs", globex.secret, {
        type: "email.send",
        payload: {},
      });
      assert.equal(mine.body.account, "acme");

      for (const path of [`/jobs/${mine.body.id}`, `/jobs/${mine.body.id}/attempts`]) {
        const r = await call(a, "GET", path, globex.secret);
        assert.equal(r.status, 404, path);
        assert.equal(r.body.error.code, "job_not_found");
      }
      const ghost = await call(a, "GET", `/jobs/${ghostId}`, globex.secret);
      assert.deepEqual(
        (await call(a, "GET", `/jobs/${mine.body.id}`, globex.secret)).body.error.message.replace(
          mine.body.id,
          "ID",
        ),
        ghost.body.error.message.replace(ghostId, "ID"),
        "a foreign job and a missing job answer identically",
      );
      const list = await call(a, "GET", "/jobs", globex.secret);
      assert.deepEqual(
        list.body.items.map((j: any) => j.id),
        [theirs.body.id],
      );
      assert.equal((await call(a, "GET", `/jobs/${mine.body.id}`, acme.secret)).status, 200);
    });

    it("workflows: other accounts cannot read, list, or cancel them", async () => {
      const acme = await issue("client", "acme");
      const globex = await issue("client", "globex");
      const wf = await call(a, "POST", "/workflows", acme.secret, {
        name: "w",
        nodes: [{ key: "a", type: "step.one", payload: {}, dependsOn: [] }],
      });
      assert.equal(wf.status, 201, JSON.stringify(wf.body));
      assert.equal((await call(a, "GET", `/workflows/${wf.body.id}`, globex.secret)).status, 404);
      assert.equal(
        (await call(a, "POST", `/workflows/${wf.body.id}/cancel`, globex.secret, {})).status,
        404,
      );
      assert.deepEqual((await call(a, "GET", "/workflows", globex.secret)).body.items, []);
      assert.equal((await call(a, "GET", "/workflows", acme.secret)).body.items.length, 1);
      assert.equal(
        (await call(a, "POST", `/workflows/${wf.body.id}/cancel`, acme.secret, {})).status,
        200,
      );
    });

    it("schedules: names are per account, and other accounts cannot read, change or delete them", async () => {
      const acme = await issue("client", "acme");
      const globex = await issue("client", "globex");
      const body = { name: "nightly", cron: "0 3 * * *", jobType: "report.build", payload: {} };
      const mine = await call(a, "POST", "/schedules", acme.secret, body);
      assert.equal(mine.status, 201);
      assert.equal(
        (await call(a, "POST", "/schedules", globex.secret, body)).status,
        201,
        "the same name in another account is fine and reveals nothing",
      );
      assert.equal((await call(a, "POST", "/schedules", acme.secret, body)).status, 409);
      for (const [method, payload] of [
        ["GET", undefined],
        ["PATCH", { enabled: false }],
        ["DELETE", undefined],
      ] as const) {
        const r = await call(a, method, `/schedules/${mine.body.id}`, globex.secret, payload);
        assert.equal(r.status, 404, method);
      }
      const still = await call(a, "GET", `/schedules/${mine.body.id}`, acme.secret);
      assert.equal(still.body.enabled, true, "untouched by the other account's attempts");
      assert.equal((await call(a, "GET", "/schedules", globex.secret)).body.items.length, 1);
    });

    it("a worker only ever receives jobs of its own account", async () => {
      const cA = await issue("client", "acme");
      const cG = await issue("client", "globex");
      const wA = await issue("worker", "acme");
      const wG = await issue("worker", "globex");
      const jobA = (await call(a, "POST", "/jobs", cA.secret, { type: "email.send", payload: {} }))
        .body;
      const jobG = (await call(a, "POST", "/jobs", cG.secret, { type: "email.send", payload: {} }))
        .body;
      const regA = (
        await call(a, "POST", "/workers", wA.secret, {
          name: "a",
          jobTypes: ["email.send"],
          concurrency: 5,
        })
      ).body;
      const regG = (
        await call(a, "POST", "/workers", wG.secret, {
          name: "g",
          jobTypes: ["email.send"],
          concurrency: 5,
        })
      ).body;
      const gotG = await call(b, "POST", `/workers/${regG.id}/claim`, wG.secret, { limit: 10 });
      assert.deepEqual(
        gotG.body.jobs.map((j: any) => j.id),
        [jobG.id],
        "globex's worker gets only globex's job",
      );
      const gotA = await call(b, "POST", `/workers/${regA.id}/claim`, wA.secret, { limit: 10 });
      assert.deepEqual(
        gotA.body.jobs.map((j: any) => j.id),
        [jobA.id],
      );
    });

    it("jobs created by workflows and schedules inherit the owner's account", async () => {
      const cA = await issue("client", "acme");
      const wG = await issue("worker", "globex");
      const wA = await issue("worker", "acme");
      const wf = await call(a, "POST", "/workflows", cA.secret, {
        name: "w",
        nodes: [{ key: "first", type: "step.one", payload: {}, dependsOn: [] }],
      });
      assert.equal(wf.status, 201);
      await call(a, "POST", "/schedules", cA.secret, {
        name: "tick",
        cron: "* * * * *",
        jobType: "tick.job",
        payload: {},
      });
      await new Scheduler(db, 60_000).runOnce(new Date(Date.now() + 120_000));
      // The scheduler stamps run_at with the (simulated future) tick time; make it eligible now.
      await db.query(`UPDATE jobs SET run_at = now() WHERE type = 'tick.job'`);

      const rows = await db.query(`SELECT type, account FROM jobs ORDER BY type`);
      assert.deepEqual(
        rows.rows.map((r: any) => `${r.type}:${r.account}`),
        ["step.one:acme", "tick.job:acme"],
      );

      const regG = (
        await call(a, "POST", "/workers", wG.secret, {
          name: "g",
          jobTypes: ["step.one", "tick.job"],
          concurrency: 5,
        })
      ).body;
      const regA = (
        await call(a, "POST", "/workers", wA.secret, {
          name: "a",
          jobTypes: ["step.one", "tick.job"],
          concurrency: 5,
        })
      ).body;
      assert.equal(
        (await call(a, "POST", `/workers/${regG.id}/claim`, wG.secret, { limit: 10 })).body.jobs
          .length,
        0,
      );
      assert.equal(
        (await call(a, "POST", `/workers/${regA.id}/claim`, wA.secret, { limit: 10 })).body.jobs
          .length,
        2,
      );
    });

    it("operators see every account and can submit into one", async () => {
      const cA = await issue("client", "acme");
      await call(a, "POST", "/jobs", cA.secret, { type: "x.y", payload: {} });
      const all = await api(a.url, "GET", "/ops/jobs", undefined, op);
      assert.equal(all.body.items.length, 1);
      const submitted = await api(
        a.url,
        "POST",
        "/ops/jobs",
        { type: "x.y", payload: {}, account: "acme" },
        op,
      );
      assert.equal(submitted.status, 201);
      assert.equal(submitted.body.account, "acme");
      assert.equal((await call(a, "GET", "/jobs", cA.secret)).body.items.length, 2);
    });
  });

  // ------------------------------------------------------------ authorization: workers
  describe("workers", () => {
    const setup = async () => {
      const client = await issue("client", "acme");
      const k1 = await issue("worker", "acme");
      const k2 = await issue("worker", "acme");
      const w1 = (
        await call(a, "POST", "/workers", k1.secret, {
          name: "w1",
          jobTypes: ["job.a"],
          concurrency: 5,
        })
      ).body;
      const w2 = (
        await call(a, "POST", "/workers", k1.secret, {
          name: "w2",
          jobTypes: ["job.a"],
          concurrency: 5,
        })
      ).body;
      const job = (await call(a, "POST", "/jobs", client.secret, { type: "job.a", payload: {} }))
        .body;
      return { client, k1, k2, w1, w2, job };
    };

    it("a key limited to certain job types cannot register a worker for others", async () => {
      const limited = await issue("worker", "acme", { jobTypes: ["email.send"] });
      const refused = await call(a, "POST", "/workers", limited.secret, {
        name: "w",
        jobTypes: ["email.send", "billing.charge"],
        concurrency: 1,
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error.code, "job_type_not_allowed");
      assert.match(refused.body.error.message, /billing\.charge/);
      const ok = await call(a, "POST", "/workers", limited.secret, {
        name: "w",
        jobTypes: ["email.send"],
        concurrency: 1,
      });
      assert.equal(ok.status, 201);
    });

    it("knowing a worker id is not enough: another key cannot heartbeat, claim, or report as it", async () => {
      const { k1, k2, w1, job } = await setup();
      assert.equal(
        (await call(a, "POST", `/workers/${w1.id}/heartbeat`, k2.secret, {})).status,
        404,
      );
      assert.equal(
        (await call(a, "POST", `/workers/${w1.id}/claim`, k2.secret, { limit: 1 })).status,
        404,
      );
      const claimed = await call(a, "POST", `/workers/${w1.id}/claim`, k1.secret, { limit: 1 });
      assert.equal(claimed.body.jobs[0].id, job.id, "the real owner can");

      for (const [path, extra] of [
        [`/jobs/${job.id}/complete`, {}],
        [`/jobs/${job.id}/heartbeat`, {}],
        [`/jobs/${job.id}/fail`, { error: "x" }],
      ] as const) {
        const r = await call(b, "POST", path, k2.secret, { workerId: w1.id, attempt: 1, ...extra });
        assert.equal(r.status, 403, path);
        assert.equal(r.body.error.code, "worker_not_yours");
      }
      const row = (await db.query(`SELECT status FROM jobs`)).rows[0];
      assert.equal(row.status, "running", "the impostor changed nothing");
    });

    it("a cached ownership answer is per key: after the owner reported, an impostor on the SAME instance is still refused", async () => {
      const { k1, k2, w1, job } = await setup();
      await call(a, "POST", `/workers/${w1.id}/claim`, k1.secret, { limit: 1 });
      // The owner's report makes this instance remember "k1 owns w1".
      const own = await call(a, "POST", `/jobs/${job.id}/heartbeat`, k1.secret, {
        workerId: w1.id,
        attempt: 1,
      });
      assert.equal(own.status, 200);
      // The impostor asks the very same instance.
      const impostor = await call(a, "POST", `/jobs/${job.id}/complete`, k2.secret, {
        workerId: w1.id,
        attempt: 1,
      });
      assert.equal(impostor.status, 403);
      assert.equal(impostor.body.error.code, "worker_not_yours");
    });

    it("a worker cannot complete a job it does not hold, nor a stale attempt", async () => {
      const { k1, w1, w2, job } = await setup();
      await call(a, "POST", `/workers/${w1.id}/claim`, k1.secret, { limit: 1 });
      const other = await call(a, "POST", `/jobs/${job.id}/complete`, k1.secret, {
        workerId: w2.id,
        attempt: 1,
      });
      assert.equal(other.status, 409, "same key, different worker: the job is not theirs");
      assert.equal(other.body.error.code, "job_not_owned");
      const stale = await call(a, "POST", `/jobs/${job.id}/complete`, k1.secret, {
        workerId: w1.id,
        attempt: 7,
      });
      assert.equal(stale.status, 409);
      const ok = await call(a, "POST", `/jobs/${job.id}/complete`, k1.secret, {
        workerId: w1.id,
        attempt: 1,
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.status, "succeeded");
    });

    it("a revoked worker key stops claiming at once", async () => {
      const { k1, w1 } = await setup();
      assert.equal(
        (await call(a, "POST", `/workers/${w1.id}/claim`, k1.secret, { limit: 1 })).status,
        200,
      );
      await api(a.url, "POST", `/ops/keys/${k1.id}/revoke`, {}, op);
      assert.equal(
        (await call(b, "POST", `/workers/${w1.id}/claim`, k1.secret, { limit: 1 })).status,
        401,
      );
    });
  });

  // ------------------------------------------------------------------------ validation
  describe("input validation", () => {
    it("refuses bad job types, oversized payloads and unknown fields", async () => {
      const c = await issue("client");
      const cases: [string, object][] = [
        ["uppercase type", { type: "Email.Send", payload: {} }],
        ["type with a slash", { type: "a/b", payload: {} }],
        ["101-char type", { type: "a".repeat(101), payload: {} }],
        ["empty type", { type: "", payload: {} }],
        ["payload over 64 KiB", { type: "x", payload: { blob: "x".repeat(70_000) } }],
        ["payload not an object", { type: "x", payload: "text" }],
        ["unknown field", { type: "x", payload: {}, account: "someone-else" }],
        ["priority out of range", { type: "x", payload: {}, priority: 1000 }],
      ];
      for (const [label, body] of cases) {
        const r = await call(a, "POST", "/jobs", c.secret, body);
        assert.equal(r.status, 400, label);
        assert.equal(r.body.error.code, "validation_error", label);
      }
    });

    it("a client cannot choose its account: the account always comes from the key", async () => {
      const c = await issue("client", "acme");
      const r = await call(a, "POST", "/jobs", c.secret, {
        type: "x",
        payload: {},
        account: "globex",
      });
      assert.equal(r.status, 400);
      const ok = await call(a, "POST", "/jobs", c.secret, { type: "x", payload: {} });
      assert.equal(ok.body.account, "acme");
    });

    it("bodies over 128 KiB are refused before parsing; workflow and schedule payloads are bounded too", async () => {
      const c = await issue("client");
      const huge = { type: "x", payload: { blob: "x".repeat(200_000) } };
      assert.equal((await call(a, "POST", "/jobs", c.secret, huge)).status, 413);
      const wf = await call(a, "POST", "/workflows", c.secret, {
        name: "w",
        nodes: [{ key: "a", type: "x", payload: { blob: "x".repeat(70_000) }, dependsOn: [] }],
      });
      assert.equal(wf.status, 400);
      const sch = await call(a, "POST", "/schedules", c.secret, {
        name: "s",
        cron: "* * * * *",
        jobType: "x",
        payload: { blob: "x".repeat(70_000) },
      });
      assert.equal(sch.status, 400);
      const ops = await api(
        a.url,
        "POST",
        "/ops/jobs",
        { type: "x", payload: { blob: "x".repeat(70_000) } },
        op,
      );
      assert.equal(ops.status, 400);
    });

    it("a worker's failure message is bounded", async () => {
      const k = await issue("worker");
      const w = (
        await call(a, "POST", "/workers", k.secret, { name: "w", jobTypes: ["x"], concurrency: 1 })
      ).body;
      const r = await call(a, "POST", `/jobs/${ghostId}/fail`, k.secret, {
        workerId: w.id,
        attempt: 1,
        error: "e".repeat(5000),
      });
      assert.equal(r.status, 400);
    });
  });

  // ------------------------------------------------------------------------- the SDK
  describe("the worker SDK with API keys", () => {
    it("a worker with a valid key runs a job end to end", async () => {
      const client = await issue("client", "acme");
      const key = await issue("worker", "acme");
      const done: unknown[] = [];
      const worker = new Worker({
        apiUrl: b.url,
        apiKey: key.secret,
        pollIntervalMs: 30,
        log: () => undefined,
      }).register("sdk.job", async (job) => void done.push(job.payload));
      await worker.start();
      try {
        const job = (
          await call(a, "POST", "/jobs", client.secret, { type: "sdk.job", payload: { n: 1 } })
        ).body;
        await waitFor(async () => {
          const r = await call(a, "GET", `/jobs/${job.id}`, client.secret);
          return r.body.status === "succeeded" ? r.body : false;
        }, "job to succeed");
        assert.deepEqual(done, [{ n: 1 }]);
      } finally {
        await worker.stop();
      }
    });

    it("start() fails fast with a clear error for a missing, wrong, or revoked key", async () => {
      const key = await issue("worker");
      const make = (apiKey?: string) =>
        new Worker({ apiUrl: a.url, ...(apiKey ? { apiKey } : {}), log: () => undefined }).register(
          "x",
          async () => undefined,
        );
      await assert.rejects(
        make().start(),
        (e: unknown) => e instanceof ApiError && e.status === 401,
      );
      await assert.rejects(
        make(`wm_${key.prefix}_${"Z".repeat(43)}`).start(),
        (e: unknown) => e instanceof ApiError && e.status === 401,
      );
      await api(a.url, "POST", `/ops/keys/${key.id}/revoke`, {}, op);
      await assert.rejects(
        make(key.secret).start(),
        (e: unknown) => e instanceof ApiError && e.status === 401,
      );
    });

    it("a client key is refused as a worker key (403, not a silent failure)", async () => {
      const client = await issue("client");
      const w = new Worker({ apiUrl: a.url, apiKey: client.secret, log: () => undefined }).register(
        "x",
        async () => undefined,
      );
      await assert.rejects(w.start(), (e: unknown) => e instanceof ApiError && e.status === 403);
    });
  });

  // ---------------------------------------------------------------------- logs and tracing
  describe("logs and correlation", () => {
    it("no credential and no job payload ever reaches the logs, yet failures stay diagnosable", async () => {
      const client = await issue("client", "acme");
      const worker = await issue("worker", "acme");
      const SECRET_PAYLOAD = "ssn-123-45-6789-do-not-log";
      const { text } = await captureLogs(async () => {
        const created = await call(a, "POST", "/jobs", client.secret, {
          type: "job.a",
          payload: { note: SECRET_PAYLOAD },
        });
        const w = (
          await call(a, "POST", "/workers", worker.secret, {
            name: "w",
            jobTypes: ["job.a"],
            concurrency: 1,
          })
        ).body;
        const claim = await call(a, "POST", `/workers/${w.id}/claim`, worker.secret, { limit: 1 });
        await call(a, "POST", `/jobs/${created.body.id}/fail`, worker.secret, {
          workerId: w.id,
          attempt: 1,
          error: `handler crashed using ${client.secret}`,
        });
        assert.equal(claim.body.jobs.length, 1);
        await call(a, "GET", "/jobs", `wm_${client.prefix}_${"C".repeat(43)}`); // right prefix, wrong secret
        await call(a, "GET", "/jobs", "wm_garbage");
        await call(a, "GET", "/jobs", null);
        await api(a.url, "GET", "/ops/me", undefined, { authorization: `Bearer ${OPERATOR_KEY}` });
        await api(a.url, "POST", `/ops/keys/${client.id}/revoke`, {}, op);
      });
      for (const [label, value] of [
        ["client key", client.secret],
        ["client secret part", client.secret.slice(12)],
        ["worker key", worker.secret],
        ["worker secret part", worker.secret.slice(12)],
        ["operator key", OPERATOR_KEY],
        ["viewer key", VIEWER_KEY],
        ["job payload", SECRET_PAYLOAD],
        ["wrong-secret probe", "C".repeat(43)],
      ] as const) {
        assert.ok(!text.includes(value), `the logs contain the ${label}`);
      }
      assert.match(text, /"auth_failed"/);
      assert.match(text, /"reason":"bad_secret"/, "a wrong secret is distinguishable in the logs");
      assert.match(text, /"reason":"malformed_key"/);
      assert.match(text, /"reason":"missing_key"/);
      assert.ok(
        text.includes(`"keyPrefix":"${client.prefix}"`),
        "the log says WHICH key (by its public prefix)",
      );
    });

    it("a revoked key being used is visible in the logs with its prefix", async () => {
      const k = await issue("client");
      await api(a.url, "POST", `/ops/keys/${k.id}/revoke`, {}, op);
      const { text } = await captureLogs(() => call(a, "GET", "/jobs", k.secret));
      assert.match(text, /"reason":"revoked"/);
      assert.ok(text.includes(k.prefix));
      assert.ok(!text.includes(k.secret));
    });

    it("a job can be traced from the request that created it to its claim and result", async () => {
      const client = await issue("client", "acme");
      const worker = await issue("worker", "acme");
      const created = await call(
        a,
        "POST",
        "/jobs",
        client.secret,
        { type: "job.a", payload: {} },
        { "x-request-id": "trace-me-123" },
      );
      assert.equal(created.body.requestId, "trace-me-123");
      const fetched = await call(a, "GET", `/jobs/${created.body.id}`, client.secret);
      assert.equal(fetched.body.requestId, "trace-me-123", "stored with the job");

      const { text } = await captureLogs(async () => {
        const w = (
          await call(a, "POST", "/workers", worker.secret, {
            name: "w",
            jobTypes: ["job.a"],
            concurrency: 1,
          })
        ).body;
        await call(a, "POST", `/workers/${w.id}/claim`, worker.secret, { limit: 1 });
        await call(a, "POST", `/jobs/${created.body.id}/complete`, worker.secret, {
          workerId: w.id,
          attempt: 1,
        });
      });
      const lines = text
        .split("\n")
        .filter((l) => l.includes(created.body.id) && /"msg":"job_(claimed|succeeded)"/.test(l));
      assert.equal(lines.length, 2, "claim and completion both mention the job");
      assert.ok(lines.every((l) => l.includes('"enqueuedByRequest":"trace-me-123"')));
    });
  });

  // -------------------------------------------------------------------------- metrics
  describe("metrics", () => {
    it("exposes queue depth, latency, duration, retries, failures, workers and expired leases", async () => {
      const client = await issue("client", "acme");
      const worker = await issue("worker", "acme");
      for (let i = 0; i < 3; i++)
        await call(a, "POST", "/jobs", client.secret, { type: "m.job", payload: { n: i } });
      const w = (
        await call(a, "POST", "/workers", worker.secret, {
          name: "w",
          jobTypes: ["m.job"],
          concurrency: 5,
        })
      ).body;
      const claimed = (await call(a, "POST", `/workers/${w.id}/claim`, worker.secret, { limit: 2 }))
        .body.jobs;
      await call(a, "POST", `/jobs/${claimed[0].id}/complete`, worker.secret, {
        workerId: w.id,
        attempt: 1,
      });
      await call(a, "POST", `/jobs/${claimed[1].id}/fail`, worker.secret, {
        workerId: w.id,
        attempt: 1,
        error: "boom",
        retryable: false,
      });

      const r = await api(a.url, "GET", "/ops/metrics", undefined, {
        authorization: `Bearer ${VIEWER_KEY}`,
      });
      assert.equal(r.status, 200);
      assert.match(String(r.headers.get("content-type")), /text\/plain; version=0\.0\.4/);
      const text: string = r.body;
      for (const name of [
        "workmesh_queue_jobs",
        "workmesh_queue_oldest_ready_age_seconds",
        "workmesh_workers",
        "workmesh_window_jobs_finished",
        "workmesh_window_retries",
        "workmesh_window_lease_expirations",
        "workmesh_window_throughput_per_minute",
        "workmesh_window_execution_seconds",
        "workmesh_window_wait_seconds",
      ]) {
        assert.match(text, new RegExp(`# HELP ${name} `), name);
        assert.match(text, new RegExp(`# TYPE ${name} gauge`), name);
      }
      assert.match(text, /workmesh_queue_jobs\{state="ready"\} 1\n/);
      assert.match(text, /workmesh_queue_jobs\{state="running"\} 0\n/);
      assert.match(
        text,
        /workmesh_window_jobs_finished\{window_minutes="15",outcome="succeeded"\} 1\n/,
      );
      assert.match(
        text,
        /workmesh_window_jobs_finished\{window_minutes="15",outcome="failed"\} 1\n/,
      );
      assert.match(text, /workmesh_workers\{health="alive"\} 1\n/);
      assert.match(text, /workmesh_window_wait_seconds\{window_minutes="15",quantile="0\.95"\}/);
      assert.ok(!/"n":|payload/.test(text), "no job data in the metrics");
      for (const line of text.trim().split("\n")) {
        assert.ok(
          /^(#|[a-z_]+(\{[^}]*\})? -?[0-9.e+-]+$)/.test(line),
          `not valid exposition text: ${line}`,
        );
      }
    });

    it("needs an operator-plane key: no key, or a machine key, is refused", async () => {
      const client = await issue("client");
      assert.equal((await call(a, "GET", "/ops/metrics", null)).status, 401);
      assert.equal((await call(a, "GET", "/ops/metrics", client.secret)).status, 401);
      assert.equal(
        (await api(a.url, "GET", "/ops/metrics?windowMinutes=0", undefined, op)).status,
        400,
      );
    });

    it("gives the same numbers whichever instance answers", async () => {
      const client = await issue("client");
      for (let i = 0; i < 4; i++)
        await call(a, "POST", "/jobs", client.secret, { type: "m.job", payload: {} });
      const fromA = await api(a.url, "GET", "/ops/metrics", undefined, op);
      const fromB = await api(b.url, "GET", "/ops/metrics", undefined, op);
      const pick = (t: string) => t.split("\n").filter((l) => l.startsWith("workmesh_queue_jobs"));
      assert.deepEqual(pick(fromA.body), pick(fromB.body));
    });
  });
});
