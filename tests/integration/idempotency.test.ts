import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Db } from "@workmesh/api";
import {
  OPERATOR_KEY,
  SECURE_AUTH,
  api,
  resetTables,
  setupTestDb,
  startApi,
  stopApi,
  type Started,
} from "./helpers.js";

const op = { authorization: `Bearer ${OPERATOR_KEY}` };

describe("idempotent job submission (PostgreSQL)", () => {
  let db: Db;
  let a: Started;
  let b: Started;

  before(async () => {
    db = await setupTestDb();
    a = await startApi(db, {}, SECURE_AUTH);
    b = await startApi(db, {}, SECURE_AUTH);
  });
  beforeEach(() => resetTables(db));
  after(async () => {
    await stopApi(a.server);
    await stopApi(b.server);
    await db.end();
  });

  const clientKey = async (account = "acme"): Promise<string> =>
    (await api(a.url, "POST", "/ops/keys", { kind: "client", account, name: "k" }, op)).body.secret;
  const submit = (
    key: string,
    body: object,
    idem?: string,
    server: Started = a,
  ): ReturnType<typeof api> =>
    api(server.url, "POST", "/jobs", body, {
      authorization: `Bearer ${key}`,
      ...(idem === undefined ? {} : { "idempotency-key": idem }),
    });
  const rows = async (): Promise<number> =>
    (await db.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n;
  const JOB = { type: "invoice.generate", payload: { orderId: "ORD-1024" } };

  it("without a key every request is a new job (nothing changes for existing clients)", async () => {
    const k = await clientKey();
    const first = await submit(k, JOB);
    const second = await submit(k, JOB);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.id, second.body.id);
    assert.equal(await rows(), 2);
  });

  it("the same key and the same request returns the original job, and creates nothing", async () => {
    const k = await clientKey();
    const first = await submit(k, JOB, "order-ORD-1024");
    assert.equal(first.status, 201);
    assert.equal(first.headers.get("idempotent-replayed"), null);

    const repeat = await submit(k, JOB, "order-ORD-1024");
    assert.equal(repeat.status, 200, "a repeat is 200, not 201");
    assert.equal(repeat.headers.get("idempotent-replayed"), "true");
    assert.equal(repeat.body.id, first.body.id);
    assert.match(String(repeat.headers.get("location")), new RegExp(first.body.id));
    assert.equal(await rows(), 1);
  });

  it("JSON key order does not matter: the same request in another order is still the same request", async () => {
    const k = await clientKey();
    const first = await submit(
      k,
      { type: "t.x", payload: { a: 1, b: { c: 2, d: 3 } }, priority: 5 },
      "k1",
    );
    const reordered = await submit(
      k,
      { priority: 5, payload: { b: { d: 3, c: 2 }, a: 1 }, type: "t.x" },
      "k1",
    );
    assert.equal(reordered.status, 200);
    assert.equal(reordered.body.id, first.body.id);
  });

  it("the same key for a DIFFERENT request is refused, and the original job is untouched", async () => {
    const k = await clientKey();
    const first = await submit(k, JOB, "reused");
    const variants: object[] = [
      { ...JOB, payload: { orderId: "ORD-9999" } },
      { ...JOB, type: "other.type" },
      { ...JOB, priority: 9 },
      { ...JOB, maxAttempts: 7 },
      { ...JOB, runAt: "2099-01-01T00:00:00Z" },
    ];
    for (const body of variants) {
      const r = await submit(k, body, "reused");
      assert.equal(r.status, 422, JSON.stringify(body));
      assert.equal(r.body.error.code, "idempotency_key_reused");
    }
    assert.equal(await rows(), 1);
    assert.equal(
      (
        await api(a.url, "GET", `/jobs/${first.body.id}`, undefined, {
          authorization: `Bearer ${k}`,
        })
      ).body.payload.orderId,
      "ORD-1024",
    );
  });

  it("25 simultaneous requests with one key, spread over two instances, create exactly one job", async () => {
    const k = await clientKey();
    const replies = await Promise.all(
      Array.from({ length: 25 }, (_, i) => submit(k, JOB, "burst", i % 2 === 0 ? a : b)),
    );
    assert.equal(replies.filter((r) => r.status === 201).length, 1, "exactly one creates");
    assert.equal(replies.filter((r) => r.status === 200).length, 24, "the rest are replays");
    assert.equal(new Set(replies.map((r) => r.body.id)).size, 1, "everyone got the same job");
    assert.equal(await rows(), 1);
  });

  it("keys belong to an organisation: another organisation can use the same string", async () => {
    const acme = await clientKey("acme");
    const globex = await clientKey("globex");
    const one = await submit(acme, JOB, "shared-string");
    const two = await submit(globex, JOB, "shared-string");
    assert.equal(one.status, 201);
    assert.equal(two.status, 201);
    assert.notEqual(one.body.id, two.body.id);
    assert.equal(two.body.account, "globex", "and it never returns another organisation's job");
    assert.equal(await rows(), 2);
  });

  it("a repeat after the job has finished returns the job as it is now", async () => {
    const k = await clientKey();
    const worker = (
      await api(a.url, "POST", "/ops/keys", { kind: "worker", account: "acme", name: "w" }, op)
    ).body.secret;
    const first = await submit(k, JOB, "will-finish");
    const w = (
      await api(
        a.url,
        "POST",
        "/workers",
        { name: "w", jobTypes: ["invoice.generate"], concurrency: 1 },
        { authorization: `Bearer ${worker}` },
      )
    ).body;
    await api(
      a.url,
      "POST",
      `/workers/${w.id}/claim`,
      { limit: 1 },
      { authorization: `Bearer ${worker}` },
    );
    await api(
      a.url,
      "POST",
      `/jobs/${first.body.id}/complete`,
      { workerId: w.id, attempt: 1 },
      { authorization: `Bearer ${worker}` },
    );
    const repeat = await submit(k, JOB, "will-finish");
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.status, "succeeded", "it does not queue the job again");
    assert.equal(await rows(), 1);
  });

  it("a request that fails validation does not use up the key", async () => {
    const k = await clientKey();
    const bad = await submit(k, { type: "Not Valid", payload: {} }, "retry-me");
    assert.equal(bad.status, 400);
    assert.equal(await rows(), 0);
    const fixed = await submit(k, JOB, "retry-me");
    assert.equal(fixed.status, 201, "the same key works once the request is right");
  });

  it("an unauthenticated request stores nothing, key or not", async () => {
    const r = await api(a.url, "POST", "/jobs", JOB, { "idempotency-key": "x" });
    assert.equal(r.status, 401);
    assert.equal(await rows(), 0);
  });

  it("refuses a malformed Idempotency-Key", async () => {
    const k = await clientKey();
    for (const bad of ["has space", "x".repeat(129), "café", "a/b", "semi;colon"]) {
      const r = await submit(k, JOB, bad);
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.error.code, "validation_error");
    }
    assert.equal(await rows(), 0);
    assert.equal((await submit(k, JOB, "x".repeat(128))).status, 201, "128 characters is allowed");
  });

  it("the key and the request fingerprint are never exposed in responses", async () => {
    const k = await clientKey();
    const r = await submit(k, JOB, "secret-ish-key");
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes("secret-ish-key") && !/request_?hash|idempotency/i.test(text));
  });
});
