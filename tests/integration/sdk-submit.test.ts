import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Db } from "@workmesh/api";
import { ApiError, Worker, WorkMesh } from "@workmesh/worker-sdk";
import {
  OPERATOR_KEY,
  SECURE_AUTH,
  api,
  resetTables,
  setupTestDb,
  startApi,
  stopApi,
  waitFor,
  type Started,
} from "./helpers.js";

const op = { authorization: `Bearer ${OPERATOR_KEY}` };

describe("the SDK client: submitting jobs from application code (real API, real PostgreSQL)", () => {
  let db: Db;
  let server: Started;

  before(async () => {
    db = await setupTestDb();
    server = await startApi(db, {}, SECURE_AUTH);
  });
  beforeEach(() => resetTables(db));
  after(async () => {
    await stopApi(server.server);
    await db.end();
  });

  const newKey = async (kind: "client" | "worker", account = "acme"): Promise<string> =>
    (await api(server.url, "POST", "/ops/keys", { kind, account, name: "k" }, op)).body.secret;
  const rows = async (): Promise<number> =>
    (await db.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n;

  /** Wraps fetch to count calls and optionally break specific ones. */
  function flaky(plan: (call: number, real: () => Promise<Response>) => Promise<Response>) {
    let calls = 0;
    const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls++;
      return plan(calls, () => fetch(input, init));
    }) as typeof fetch;
    return { impl, calls: () => calls };
  }
  const client = async (extra: Partial<ConstructorParameters<typeof WorkMesh>[0]> = {}) =>
    new WorkMesh({ apiUrl: server.url, apiKey: await newKey("client"), maxRetries: 3, ...extra });

  it("the whole flow: the application submits, a worker registered by name runs it", async () => {
    const workmesh = await client();
    const seen: unknown[] = [];
    const worker = new Worker({
      apiUrl: server.url,
      apiKey: await newKey("worker"),
      pollIntervalMs: 30,
      log: () => undefined,
    }).register("generate-invoice", async (job) => void seen.push(job.payload));
    await worker.start();
    try {
      const submitted = await workmesh.jobs.submit({
        type: "generate-invoice",
        payload: { orderId: "ORD-1024" },
      });
      assert.equal(submitted.status, "queued", "saved, not yet run");
      assert.equal(submitted.replayed, false);
      assert.equal(submitted.payload.orderId, "ORD-1024");

      const done = await waitFor(async () => {
        const job = await workmesh.jobs.get(submitted.id);
        return job.status === "succeeded" ? job : false;
      }, "the job to succeed");
      assert.equal(done.attemptCount, 1);
      assert.deepEqual(seen, [{ orderId: "ORD-1024" }], "the handler received exactly the payload");
    } finally {
      await worker.stop();
    }
  });

  it("passes priority, attempts and a future run time through", async () => {
    const workmesh = await client();
    const at = new Date(Date.now() + 3_600_000);
    const job = await workmesh.jobs.submit({ type: "t.x", priority: 7, maxAttempts: 5, runAt: at });
    assert.equal(job.priority, 7);
    assert.equal(job.maxAttempts, 5);
    assert.equal(new Date(job.runAt).getTime(), at.getTime());
    assert.equal(job.status, "queued");
  });

  it("an idempotencyKey makes a repeat return the SAME job", async () => {
    const workmesh = await client();
    const one = await workmesh.jobs.submit({
      type: "t.x",
      payload: { n: 1 },
      idempotencyKey: "invoice-ORD-1",
    });
    const two = await workmesh.jobs.submit({
      type: "t.x",
      payload: { n: 1 },
      idempotencyKey: "invoice-ORD-1",
    });
    assert.equal(one.replayed, false);
    assert.equal(two.replayed, true);
    assert.equal(two.id, one.id);
    assert.equal(await rows(), 1);
  });

  it("the same key for a different job is an error, not a silent wrong answer", async () => {
    const workmesh = await client();
    await workmesh.jobs.submit({ type: "t.x", payload: { n: 1 }, idempotencyKey: "k" });
    const err = (await workmesh.jobs
      .submit({ type: "t.x", payload: { n: 2 }, idempotencyKey: "k" })
      .catch((e) => e)) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.deepEqual([err.status, err.code], [422, "idempotency_key_reused"]);
    assert.equal(await rows(), 1);
  });

  it("LOST RESPONSE with a key: the job was created but the answer never arrived; the retry returns it, no duplicate", async () => {
    const f = flaky(async (call, real) => {
      const res = await real(); // the server really handled it...
      if (call === 1) {
        await res.arrayBuffer();
        throw new TypeError("connection reset before the response arrived"); // ...but we never saw the answer
      }
      return res;
    });
    const workmesh = await client({ fetch: f.impl });
    const job = await workmesh.jobs.submit({
      type: "t.x",
      payload: { n: 1 },
      idempotencyKey: "order-7",
    });
    assert.equal(f.calls(), 2, "retried once automatically");
    assert.equal(job.replayed, true, "the retry found the job the first attempt had created");
    assert.equal(await rows(), 1, "exactly one job");
  });

  it("LOST RESPONSE without a key: no automatic retry, and the error says the job may exist", async () => {
    const f = flaky(async (_call, real) => {
      const res = await real();
      await res.arrayBuffer();
      throw new TypeError("connection reset before the response arrived");
    });
    const workmesh = await client({ fetch: f.impl });
    const err = (await workmesh.jobs
      .submit({ type: "t.x", payload: {} })
      .catch((e) => e)) as ApiError;
    assert.equal(f.calls(), 1, "never repeated on its own: that could create a second job");
    assert.equal(err.code, "network");
    assert.match(err.message, /MAY have been created/);
    assert.match(err.message, /idempotencyKey/);
    assert.equal(
      await rows(),
      1,
      "and the job does exist, which is exactly why it is not repeated",
    );
  });

  it("a busy or failing server is retried with a key (503, then 429), and honours Retry-After", async () => {
    const f = flaky(async (call, real) => {
      if (call === 1)
        return new Response(
          JSON.stringify({ error: { code: "database_unavailable", message: "later" } }),
          { status: 503, headers: { "retry-after": "0", "content-type": "application/json" } },
        );
      if (call === 2)
        return new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow" } }), {
          status: 429,
          headers: { "retry-after": "0", "content-type": "application/json" },
        });
      return real();
    });
    const workmesh = await client({ fetch: f.impl });
    const job = await workmesh.jobs.submit({ type: "t.x", idempotencyKey: "k503" });
    assert.equal(f.calls(), 3);
    assert.equal(job.status, "queued");
    assert.equal(await rows(), 1);
  });

  it("the same 503 without a key is NOT retried", async () => {
    const f = flaky(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "database_unavailable", message: "later" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    const workmesh = await client({ fetch: f.impl });
    const err = (await workmesh.jobs.submit({ type: "t.x" }).catch((e) => e)) as ApiError;
    assert.equal(f.calls(), 1);
    assert.deepEqual([err.status, err.code], [503, "database_unavailable"]);
  });

  it("gives up after maxRetries and says what happened", async () => {
    const f = flaky(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const workmesh = await client({ fetch: f.impl, maxRetries: 2 });
    const err = (await workmesh.jobs
      .submit({ type: "t.x", idempotencyKey: "k" })
      .catch((e) => e)) as ApiError;
    assert.equal(f.calls(), 3, "1 attempt + 2 retries");
    assert.equal(err.status, 502);
  });

  it("mistakes by the caller are not retried: a wrong key (401) and a key of the wrong kind (403)", async () => {
    const f = flaky((_c, real) => real());
    const wrongKey = new WorkMesh({
      apiUrl: server.url,
      apiKey: `wm_deadbeef_${"x".repeat(43)}`,
      fetch: f.impl,
    });
    const e1 = (await wrongKey.jobs
      .submit({ type: "t.x", idempotencyKey: "k" })
      .catch((e) => e)) as ApiError;
    assert.deepEqual([e1.status, e1.code], [401, "unauthenticated"]);
    assert.equal(f.calls(), 1, "a 401 is not worth repeating, even with a key");

    const workerKeyClient = new WorkMesh({
      apiUrl: server.url,
      apiKey: await newKey("worker"),
      fetch: f.impl,
    });
    const e2 = (await workerKeyClient.jobs
      .submit({ type: "t.x", idempotencyKey: "k2" })
      .catch((e) => e)) as ApiError;
    assert.deepEqual([e2.status, e2.code], [403, "forbidden"], "a worker key cannot submit");
    assert.equal(f.calls(), 2);
  });

  it("obvious mistakes are caught locally, before any request is made", async () => {
    const f = flaky((_c, real) => real());
    const workmesh = await client({ fetch: f.impl });
    const bad = [
      { type: "Generate Invoice" },
      { type: "a/b" },
      { type: "" },
      { type: "t.x", payload: "text" as never },
      { type: "t.x", payload: [] as never },
      { type: "t.x", payload: { blob: "x".repeat(70_000) } },
      { type: "t.x", priority: 101 },
      { type: "t.x", priority: 1.5 },
      { type: "t.x", maxAttempts: 0 },
      { type: "t.x", runAt: "not a date" },
      { type: "t.x", idempotencyKey: "has space" },
      { type: "t.x", idempotencyKey: "x".repeat(129) },
    ];
    for (const input of bad) {
      const err = (await workmesh.jobs.submit(input).catch((e) => e)) as ApiError;
      assert.ok(err instanceof ApiError, JSON.stringify(input).slice(0, 60));
      assert.deepEqual([err.status, err.code], [0, "invalid_input"]);
    }
    assert.equal(f.calls(), 0, "not one request was sent");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.match(
      String(await workmesh.jobs.submit({ type: "t.x", payload: cyclic }).catch((e) => e.message)),
      /plain JSON/,
    );
  });

  it("jobs.get returns your job, and 404 for an unknown one or another organisation's", async () => {
    const mine = await client();
    const theirs = new WorkMesh({ apiUrl: server.url, apiKey: await newKey("client", "globex") });
    const job = await mine.jobs.submit({ type: "t.x" });
    assert.equal((await mine.jobs.get(job.id)).id, job.id);
    for (const id of [job.id, "00000000-0000-4000-8000-000000000000"]) {
      const err = (await theirs.jobs.get(id).catch((e) => e)) as ApiError;
      assert.deepEqual([err.status, err.code], [404, "job_not_found"], id);
    }
  });

  it("a request that hangs times out instead of waiting forever", async () => {
    const hang = ((_i: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const workmesh = await client({ fetch: hang, timeoutMs: 150, maxRetries: 1 });
    const started = Date.now();
    const err = (await workmesh.jobs
      .submit({ type: "t.x", idempotencyKey: "k" })
      .catch((e) => e)) as ApiError;
    assert.equal(err.code, "network");
    assert.ok(Date.now() - started < 3000);
  });

  it("the API key never appears in an error or its text", async () => {
    const key = `wm_deadbeef_${"S".repeat(43)}`;
    const leaks = (err: ApiError): boolean =>
      `${err.message} ${String(err)} ${JSON.stringify(err)} ${err.stack ?? ""}`.includes(
        "S".repeat(20),
      );

    // An error the SERVER sent (a 401)...
    const refused = new WorkMesh({ apiUrl: server.url, apiKey: key });
    assert.ok(!leaks((await refused.jobs.submit({ type: "t.x" }).catch((e) => e)) as ApiError));

    // ...and a failure that never reached the server (the network path builds its own message).
    const broken = new WorkMesh({
      apiUrl: server.url,
      apiKey: key,
      fetch: (async () => {
        throw new TypeError("connection refused");
      }) as typeof fetch,
    });
    for (const call of [
      () => broken.jobs.submit({ type: "t.x" }),
      () => broken.jobs.submit({ type: "t.x", idempotencyKey: "k" }),
      () => broken.jobs.get("00000000-0000-4000-8000-000000000000"),
    ]) {
      const err = (await call().catch((e) => e)) as ApiError;
      assert.equal(err.code, "network");
      assert.ok(!leaks(err));
    }
  });

  it("refuses to be constructed without a key", () => {
    assert.throws(() => new WorkMesh({ apiUrl: server.url, apiKey: "" }), /apiKey is required/);
  });
});
