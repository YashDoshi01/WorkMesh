import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { createApp, createPool, migrate, type Db } from "@workmesh/api";

// Real PostgreSQL, never a mock. A dedicated database keeps tests away from dev data.
const baseUrl = process.env.DATABASE_URL ?? "postgres://workmesh:workmesh@localhost:5432/workmesh";
const TEST_DB = "workmesh_test";
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${TEST_DB}`;

async function ensureTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DB]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
}

interface Started {
  server: Server;
  url: string;
}

function start(db: Db): Promise<Started> {
  return new Promise((resolve) => {
    const server = createApp(db).listen(0, () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface Page {
  items: { id: string; type: string }[];
  nextCursor: string | null;
}

async function collectIds(url: string, limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const qs: string = `limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
    const page = (await (await fetch(`${url}/jobs?${qs}`)).json()) as Page;
    assert.ok(page.items.length <= limit);
    ids.push(...page.items.map((j) => j.id));
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  return { ids, pages };
}

describe("jobs API (PostgreSQL)", () => {
  let db: Db;
  let started: Started;

  before(async () => {
    await ensureTestDatabase();
    db = createPool(testUrl.toString());
    await migrate(db);
    started = await start(db);
  });

  beforeEach(async () => {
    await db.query("TRUNCATE jobs");
  });

  after(async () => {
    await stop(started.server);
    await db.end();
  });

  it("migrate is idempotent", async () => {
    assert.deepEqual(await migrate(db), []);
  });

  it("POST /jobs persists a queued job and GET /jobs/:id returns it", async () => {
    const res = await post(started.url, {
      type: "email.send",
      payload: { to: "a@b.c" },
      priority: 5,
    });
    assert.equal(res.status, 201);
    const job = (await res.json()) as Record<string, unknown>;
    assert.equal(job.status, "queued");
    assert.equal(job.attemptCount, 0);
    assert.equal(job.priority, 5);
    assert.equal(res.headers.get("location"), `/jobs/${String(job.id)}`);

    const row = await db.query("SELECT type, payload FROM jobs WHERE id = $1", [job.id]);
    assert.deepEqual(row.rows[0], { type: "email.send", payload: { to: "a@b.c" } });

    const got = await fetch(`${started.url}/jobs/${String(job.id)}`);
    assert.equal(got.status, 200);
    assert.deepEqual(await got.json(), job);
  });

  it("a submitted job survives an API restart (new pool, new server)", async () => {
    const created = (await (
      await post(started.url, { type: "report.build", payload: { n: 1 } })
    ).json()) as { id: string };
    await stop(started.server);
    await db.end();

    db = createPool(testUrl.toString());
    started = await start(db);
    const got = await fetch(`${started.url}/jobs/${created.id}`);
    assert.equal(got.status, 200);
    assert.equal(((await got.json()) as { id: string }).id, created.id);
  });

  it("rejects invalid input with 400 and a consistent error body", async () => {
    const res = await post(started.url, { type: "BAD TYPE", payload: [] });
    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      error: { code: string; details: unknown[]; requestId: string };
    };
    assert.equal(body.error.code, "validation_error");
    assert.ok(body.error.details.length >= 2);
    assert.equal(body.error.requestId, res.headers.get("x-request-id"));
    const count = await db.query("SELECT count(*)::int AS n FROM jobs");
    assert.equal(count.rows[0].n, 0);
  });

  it("rejects malformed JSON (400) and oversized bodies (413)", async () => {
    const bad = await fetch(`${started.url}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "invalid_json");

    const big = await post(started.url, { type: "x", payload: { blob: "a".repeat(200_000) } });
    assert.equal(big.status, 413);
  });

  it("GET /jobs/:id returns 404 for unknown ids and 400 for malformed ids", async () => {
    const missing = await fetch(`${started.url}/jobs/00000000-0000-4000-8000-000000000000`);
    assert.equal(missing.status, 404);
    const malformed = await fetch(`${started.url}/jobs/not-a-uuid`);
    assert.equal(malformed.status, 400);
  });

  it("echoes a well-formed inbound X-Request-Id and generates one otherwise", async () => {
    const withId = await fetch(`${started.url}/healthz`, {
      headers: { "x-request-id": "abc-123" },
    });
    assert.equal(withId.headers.get("x-request-id"), "abc-123");
    const without = await fetch(`${started.url}/healthz`);
    assert.match(without.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  });

  it("unknown routes return a JSON 404", async () => {
    const res = await fetch(`${started.url}/nope`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "not_found");
  });

  describe("GET /jobs", () => {
    it("paginates newest-first without gaps or duplicates", async () => {
      const created: string[] = [];
      for (let i = 0; i < 7; i++) {
        const r = await post(started.url, { type: "t.a", payload: { i } });
        created.push(((await r.json()) as { id: string }).id);
      }
      const { ids, pages } = await collectIds(started.url, 3);
      assert.equal(pages, 3);
      assert.deepEqual(ids, [...created].reverse());
    });

    it("pages correctly when many rows share one created_at", async () => {
      // One statement = one transaction timestamp, so all ten rows tie on created_at.
      await db.query(
        `INSERT INTO jobs (type, payload) SELECT 't.same', '{}'::jsonb FROM generate_series(1, 10)`,
      );
      const { ids } = await collectIds(started.url, 4);
      assert.equal(new Set(ids).size, 10);
      assert.equal(ids.length, 10);
    });

    it("filters by type and status", async () => {
      await post(started.url, { type: "t.a", payload: {} });
      await post(started.url, { type: "t.b", payload: {} });
      const a = (await (await fetch(`${started.url}/jobs?type=t.a`)).json()) as Page;
      assert.equal(a.items.length, 1);
      assert.equal(a.items[0]?.type, "t.a");
      const q = (await (await fetch(`${started.url}/jobs?status=queued`)).json()) as Page;
      assert.equal(q.items.length, 2);
    });

    it("rejects out-of-range limits, unknown statuses and garbage cursors", async () => {
      for (const qs of ["limit=1000", "limit=0", "status=bogus", "cursor=garbage"]) {
        const res = await fetch(`${started.url}/jobs?${qs}`);
        assert.equal(res.status, 400, qs);
      }
    });
  });

  it("database constraints reject rows that bypass the API", async () => {
    await assert.rejects(db.query(`INSERT INTO jobs (type, payload) VALUES ('Bad Type', '{}')`));
    await assert.rejects(db.query(`INSERT INTO jobs (type, payload) VALUES ('ok', '[]')`));
    await assert.rejects(
      db.query(`INSERT INTO jobs (type, payload, status) VALUES ('ok', '{}', 'bogus')`),
    );
  });
});
