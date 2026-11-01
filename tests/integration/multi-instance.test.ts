import assert from "node:assert/strict";
import { createServer, request as httpRequest, Agent, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp, createPool, migrate, type Db } from "@workmesh/api";
import { gracefulShutdown } from "../../apps/api/src/shutdown.js";
import {
  OPERATOR_KEY,
  adminQuery,
  api,
  databaseUrlFor,
  lifecycleFor,
  resetTables,
  setupTestDb,
  startApi,
  stopApi,
  type Started,
} from "./helpers.js";

const op = { authorization: `Bearer ${OPERATOR_KEY}` };
const served = (r: { headers: Headers }): string => r.headers.get("x-served-by") ?? "";

describe("two API instances, one database (what a load balancer relies on)", () => {
  let db: Db;
  let a: Started;
  let b: Started;

  before(async () => {
    db = await setupTestDb();
    // Two completely separate app objects (own router, own state) sharing nothing but PostgreSQL.
    a = await startApi(db, {}, undefined, { instanceId: "api-a" });
    b = await startApi(db, {}, undefined, { instanceId: "api-b" });
  });
  beforeEach(() => resetTables(db));
  after(async () => {
    await stopApi(a.server);
    await stopApi(b.server);
    await db.end();
  });

  const post = (s: Started, p: string, body: object, headers: Record<string, string> = {}) =>
    api(s.url, "POST", p, body, headers);
  const get = (s: Started, p: string, headers: Record<string, string> = {}) =>
    api(s.url, "GET", p, undefined, headers);

  it("each response names the instance that produced it", async () => {
    assert.equal(served(await get(a, "/healthz")), "api-a");
    assert.equal(served(await get(b, "/healthz")), "api-b");
  });

  it("state written through one instance is read through the other, immediately", async () => {
    const created = await post(a, "/jobs", { type: "mi.t", payload: { n: 1 } });
    assert.equal(served(created), "api-a");
    const seen = await get(b, `/jobs/${created.body.id}`);
    assert.equal(served(seen), "api-b");
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.body, created.body);

    const w = (await post(b, "/workers", { name: "w", jobTypes: ["mi.t"], concurrency: 1 })).body
      .id;
    const [job] = (await post(a, `/workers/${w}/claim`, { limit: 1 })).body.jobs;
    assert.equal((await get(b, `/jobs/${created.body.id}`)).body.status, "running");
    // claimed through A, lease renewed through B, finished through A: the attempt number is the only identity needed
    assert.equal(
      (await post(b, `/jobs/${job.id}/heartbeat`, { workerId: w, attempt: 1 })).status,
      200,
    );
    assert.equal(
      (await post(a, `/jobs/${job.id}/complete`, { workerId: w, attempt: 1 })).status,
      200,
    );
    assert.equal((await get(b, `/jobs/${job.id}`)).body.status, "succeeded");
  });

  it("concurrent submissions through BOTH instances are all stored exactly once", async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        post(i % 2 === 0 ? a : b, "/jobs", { type: "mi.t", payload: { i } }),
      ),
    );
    assert.ok(results.every((r) => r.status === 201));
    assert.equal(new Set(results.map((r) => r.body.id)).size, 60);
    assert.equal(new Set(results.map(served)).size, 2, "both instances took part");
    for (const s of [a, b]) {
      const page = (await get(s, "/jobs?limit=100")).body;
      assert.equal(page.items.length, 60, `${served(await get(s, "/healthz"))} sees every job`);
    }
  });

  it("concurrent claims through BOTH instances never hand one job to two workers", async () => {
    for (let i = 0; i < 80; i++) await post(a, "/jobs", { type: "mi.claim", payload: { i } });
    const workers = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(i % 2 === 0 ? a : b, "/workers", {
          name: `w${i}`,
          jobTypes: ["mi.claim"],
          concurrency: 5,
        }).then((r) => r.body.id as string),
      ),
    );
    const claimedBy: string[][] = await Promise.all(
      workers.map(async (w, i) => {
        const mine: string[] = [];
        for (let round = 0; ; round++) {
          // alternate instances on every call: successive claims by one worker hit different instances
          const r = await post((i + round) % 2 === 0 ? a : b, `/workers/${w}/claim`, { limit: 5 });
          if (r.body.jobs.length === 0) return mine;
          mine.push(...r.body.jobs.map((j: { id: string }) => j.id));
        }
      }),
    );
    const all = claimedBy.flat();
    assert.equal(all.length, 80, "every job claimed");
    assert.equal(new Set(all).size, 80, "no job claimed twice");
    assert.ok(claimedBy.filter((c) => c.length > 0).length > 1, "work was shared");
  });

  it("a workflow advances correctly when its parents finish through different instances at once", async () => {
    const parents = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const wf = (
      await post(a, "/workflows", {
        nodes: [
          ...parents.map((p) => ({ key: p, type: "mi.wf" })),
          { key: "sink", type: "mi.sink", dependsOn: parents },
        ],
      })
    ).body;
    const w = (
      await post(a, "/workers", { name: "w", jobTypes: ["mi.wf", "mi.sink"], concurrency: 20 })
    ).body.id;
    const jobs = (await post(b, `/workers/${w}/claim`, { limit: 20 })).body.jobs;
    assert.equal(jobs.length, 10);
    const done = await Promise.all(
      jobs.map((j: { id: string; attemptCount: number }, i: number) =>
        post(i % 2 === 0 ? a : b, `/jobs/${j.id}/complete`, {
          workerId: w,
          attempt: j.attemptCount,
        }),
      ),
    );
    assert.ok(done.every((r) => r.status === 200));
    const sink = (await get(b, `/jobs?workflowId=${wf.id}&type=mi.sink`)).body.items;
    assert.equal(sink.length, 1, "the join node was released exactly once");
  });

  it("the operator key is valid on every instance (no sessions to lose), and its audit trail is shared", async () => {
    const submitted = await post(a, "/ops/jobs", { type: "mi.t", payload: {} }, op);
    assert.equal(submitted.status, 201);
    assert.equal((await get(b, "/ops/me", op)).status, 200);
    const cancelled = await post(b, `/ops/jobs/${submitted.body.id}/cancel`, {}, op);
    assert.equal(cancelled.status, 200);
    const audit = (await get(a, "/ops/audit", op)).body.items.map(
      (e: { action: string }) => e.action,
    );
    assert.deepEqual(
      audit,
      ["job.cancel", "job.submit"],
      "actions taken on A and B appear together",
    );
  });

  it("restarting an instance loses nothing: a brand-new instance continues where the old one stopped", async () => {
    const created = await post(a, "/jobs", { type: "mi.t", payload: {} });
    await stopApi(a.server);
    const fresh = await startApi(db, {}, undefined, { instanceId: "api-a2" });
    try {
      const r = await get(fresh, `/jobs/${created.body.id}`);
      assert.equal(r.status, 200);
      assert.equal(served(r), "api-a2");
      assert.equal(
        (await get(fresh, "/ops/me", op)).status,
        200,
        "same key still works, no session needed",
      );
    } finally {
      await stopApi(fresh.server);
      a = await startApi(db, {}, undefined, { instanceId: "api-a" });
    }
  });

  it("with BOTH instances' schedulers and reapers running, a schedule still yields one job per occurrence", async () => {
    const { Scheduler, LeaseReaper } = await import("@workmesh/api");
    const s = (await post(a, "/schedules", { name: "mi", cron: "* * * * *", jobType: "mi.sched" }))
      .body;
    await db.query("UPDATE schedules SET next_run_at = date_trunc('minute', now()) WHERE id = $1", [
      s.id,
    ]);
    const loops = [new Scheduler(db, 25), new Scheduler(db, 25)];
    const reapers = [new LeaseReaper(lifecycleFor(db), 25), new LeaseReaper(lifecycleFor(db), 25)];
    [...loops, ...reapers].forEach((l) => l.start());
    await new Promise((r) => setTimeout(r, 400));
    await Promise.all([...loops, ...reapers].map((l) => l.stop()));
    const n = (await db.query("SELECT count(*)::int AS n FROM jobs WHERE schedule_id = $1", [s.id]))
      .rows[0].n;
    // one occurrence is due (this minute); a second may become due if the minute rolls over during the test
    assert.ok(n >= 1 && n <= 2, `expected 1 job (or 2 across a minute boundary), got ${n}`);
    const dup = await db.query(
      "SELECT scheduled_for, count(*)::int AS n FROM jobs WHERE schedule_id = $1 GROUP BY 1 HAVING count(*) > 1",
      [s.id],
    );
    assert.equal(dup.rowCount, 0, "never two jobs for the same occurrence");
  });
});

describe("starting several instances at the same moment", () => {
  it("migrations run exactly once even when two instances migrate a fresh database concurrently", async () => {
    const name = `workmesh_mig_${Date.now().toString(36)}`;
    await adminQuery(`CREATE DATABASE ${name}`);
    const p1 = createPool(databaseUrlFor(name));
    const p2 = createPool(databaseUrlFor(name));
    try {
      const [first, second] = await Promise.all([migrate(p1), migrate(p2)]);
      const total = (await p1.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n;
      assert.equal(
        first.length + second.length,
        total,
        "each migration was applied by exactly one of them",
      );
      assert.ok(total >= 8);
      assert.deepEqual(
        [...first, ...second].sort(),
        [...new Set([...first, ...second])].sort(),
        "none applied twice",
      );
      const tables = (
        await p1.query(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'jobs'",
        )
      ).rows[0].n;
      assert.equal(tables, 1);
    } finally {
      await p1.end();
      await p2.end();
      await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  });
});

describe("liveness and readiness", () => {
  let db: Db;
  before(async () => {
    db = await setupTestDb();
  });
  after(() => db.end());

  const broken = (query: () => Promise<unknown>): Db => ({ query }) as unknown as Db;

  it("/readyz is 200 and /healthz is 200 when the database is reachable", async () => {
    const s = await startApi(db);
    try {
      assert.deepEqual((await api(s.url, "GET", "/readyz")).body, { status: "ready" });
      assert.deepEqual((await api(s.url, "GET", "/healthz")).body, { status: "ok" });
    } finally {
      await stopApi(s.server);
    }
  });

  it("with the database failing, /readyz is 503 but /healthz stays 200 (restarting the API would not help)", async () => {
    const secret = new Error("connect ECONNREFUSED db.internal.example:5432 password=hunter2");
    const server = createApp(broken(() => Promise.reject(secret))).listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ready = await api(url, "GET", "/readyz");
      assert.equal(ready.status, 503);
      assert.deepEqual(ready.body, { status: "unavailable", reason: "database" });
      assert.ok(
        !JSON.stringify(ready.body).includes("hunter2") &&
          !JSON.stringify(ready.body).includes("db.internal"),
        "no connection details leak",
      );
      assert.equal((await api(url, "GET", "/healthz")).status, 200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("a database that HANGS makes /readyz answer 503 within about 2 seconds instead of hanging too", async () => {
    const server = createApp(broken(() => new Promise(() => undefined))).listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const t = Date.now();
      const r = await api(url, "GET", "/readyz");
      assert.equal(r.status, 503);
      const took = Date.now() - t;
      assert.ok(took >= 1800 && took < 4000, `answered in ${took} ms`);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("while draining: /readyz is 503 'draining', responses ask for the connection to be closed, requests are still served", async () => {
    const drain = { draining: false };
    const s = await startApi(db, {}, undefined, { drain });
    try {
      assert.equal((await api(s.url, "GET", "/readyz")).status, 200);
      drain.draining = true;
      const ready = await api(s.url, "GET", "/readyz");
      assert.equal(ready.status, 503);
      assert.deepEqual(ready.body, { status: "unavailable", reason: "draining" });
      const normal = await api(s.url, "GET", "/healthz");
      assert.equal(normal.status, 200);
      assert.equal(normal.headers.get("connection"), "close");
    } finally {
      await stopApi(s.server);
    }
  });
});

describe("trusting a proxy: who is the client?", () => {
  let db: Db;
  before(async () => {
    db = await setupTestDb();
  });
  beforeEach(() => resetTables(db));
  after(() => db.end());

  /** Performs one operator action with the given X-Forwarded-For and returns the address the audit log recorded. */
  async function recordedAddress(
    trustProxy: string[] | undefined,
    forwardedFor?: string,
  ): Promise<string | null> {
    const s = await startApi(db, {}, undefined, trustProxy ? { trustProxy } : {});
    try {
      const headers: Record<string, string> = {
        ...op,
        ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
      };
      assert.equal(
        (await api(s.url, "POST", "/ops/jobs", { type: "tp.t", payload: {} }, headers)).status,
        201,
      );
      const entry = (await api(s.url, "GET", "/ops/audit?limit=1", undefined, op)).body.items[0];
      await db.query("TRUNCATE audit_log");
      return entry.clientIp;
    } finally {
      await stopApi(s.server);
    }
  }

  it("with no proxy trusted, X-Forwarded-For is IGNORED: a client cannot choose the address that is recorded", async () => {
    assert.equal(await recordedAddress(undefined), "127.0.0.1");
    assert.equal(await recordedAddress(undefined, "6.6.6.6"), "127.0.0.1");
  });

  it("when the connecting address IS the trusted proxy, its X-Forwarded-For is believed", async () => {
    assert.equal(await recordedAddress(["loopback"], "203.0.113.9"), "203.0.113.9");
    assert.equal(await recordedAddress(["127.0.0.1"], "203.0.113.9"), "203.0.113.9");
  });

  it("when the connecting address is NOT the trusted proxy, the header is ignored (an attacker who bypasses the gateway gains nothing)", async () => {
    assert.equal(await recordedAddress(["10.9.9.9"], "203.0.113.9"), "127.0.0.1");
  });

  it("a client cannot prepend a fake address to the chain: the address nearest the proxy wins", async () => {
    // the client claimed "6.6.6.6"; the gateway appended the address it really saw
    assert.equal(await recordedAddress(["loopback"], "6.6.6.6, 203.0.113.9"), "203.0.113.9");
  });

  it("IPv4 addresses are recorded in plain form, never as ::ffff:a.b.c.d", async () => {
    const recorded = await recordedAddress(undefined);
    assert.ok(recorded && !recorded.startsWith("::ffff:"));
  });
});

describe("request ids across a gateway", () => {
  let db: Db;
  let s: Started;
  before(async () => {
    db = await setupTestDb();
    s = await startApi(db);
  });
  after(async () => {
    await stopApi(s.server);
    await db.end();
  });

  it("keeps a well-formed id from the gateway (32 hex, like NGINX's $request_id), so one id spans both logs", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    assert.equal(
      (await api(s.url, "GET", "/healthz", undefined, { "x-request-id": id })).headers.get(
        "x-request-id",
      ),
      id,
    );
  });

  it("replaces a malformed id with a fresh one", async () => {
    const r = await api(s.url, "GET", "/healthz", undefined, {
      "x-request-id": "bad id with spaces & <script>",
    });
    assert.match(r.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  });
});

describe("graceful shutdown (real HTTP server, real connections)", () => {
  let db: Db;
  before(async () => {
    db = await setupTestDb();
  });
  after(() => db.end());

  /** A server whose app is the real API plus two test-only routes: one slow, one that never ends. */
  function build(): { server: Server; drain: { draining: boolean }; url: string } {
    const drain = { draining: false };
    const real = createApp(db, undefined, undefined, { drain });
    const server = createServer((req, res) => {
      if (req.url === "/slow") setTimeout(() => res.end("finished"), 700);
      else if (req.url === "/hang")
        return; // never responds
      else real(req, res);
    });
    server.listen(0);
    return { server, drain, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it("lets an in-flight request finish, keeps serving during the drain, then refuses new connections", async () => {
    const { server, drain, url } = build();
    let cleaned = 0;
    const inFlight = fetch(`${url}/slow`).then(async (r) => ({
      status: r.status,
      text: await r.text(),
    }));
    await new Promise((r) => setTimeout(r, 100)); // make sure it has reached the server

    const stopped = gracefulShutdown({
      server,
      drain,
      drainMs: 300,
      graceMs: 5000,
      cleanup: async () => void cleaned++,
    });
    await new Promise((r) => setTimeout(r, 100)); // inside the drain window
    assert.equal(drain.draining, true);
    assert.equal((await fetch(`${url}/readyz`)).status, 503, "not ready while draining");
    assert.equal((await fetch(`${url}/healthz`)).status, 200, "but still serving");

    const result = await stopped;
    assert.deepEqual(
      await inFlight,
      { status: 200, text: "finished" },
      "the in-flight request was not dropped",
    );
    assert.equal(result.forced, false);
    assert.equal(cleaned, 1);
    await assert.rejects(fetch(`${url}/healthz`), "the port no longer accepts connections");
  });

  it("an idle keep-alive connection (what a gateway leaves open) does not hold shutdown up", async () => {
    const { server, drain, url } = build();
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      httpRequest(`${url}/healthz`, { agent }, (res) => {
        res.resume();
        res.on("end", resolve);
      })
        .on("error", reject)
        .end();
    });
    const t = Date.now();
    const result = await gracefulShutdown({
      server,
      drain,
      drainMs: 0,
      graceMs: 10_000,
      cleanup: async () => undefined,
    });
    agent.destroy();
    assert.equal(result.forced, false);
    assert.ok(Date.now() - t < 2000, `shutdown took ${Date.now() - t} ms`);
  });

  it("a request that never finishes is cut after the grace period, so shutdown cannot hang forever", async () => {
    const { server, drain, url } = build();
    const stuck = fetch(`${url}/hang`).catch(() => "cut");
    await new Promise((r) => setTimeout(r, 100));
    const t = Date.now();
    const result = await gracefulShutdown({
      server,
      drain,
      drainMs: 0,
      graceMs: 400,
      cleanup: async () => undefined,
    });
    assert.equal(result.forced, true);
    assert.ok(Date.now() - t < 2500);
    assert.equal(await stuck, "cut");
  });
});
