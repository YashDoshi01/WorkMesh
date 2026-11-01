import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

// End-to-end tests of the REAL deployment: NGINX in front of two API containers and one
// PostgreSQL, started with Docker Compose. Nothing here is mocked, so these tests are slow
// (~1-2 minutes, mostly container start-up) and need Docker. Run with `npm run test:gateway`.
//
// The stack uses its own project name, port and subnet, so it never collides with the
// development database or with `npm run gateway:up`.

const PROJECT = "workmesh-gwtest";
const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;
const SUBNET = "172.28.58";
const OPERATOR_KEY = "gateway-test-operator-key-0123456789";
const VIEWER_KEY = "gateway-test-viewer-key-0123456789ab";

const COMPOSE_ENV = {
  ...process.env,
  GATEWAY_PROJECT: PROJECT,
  GATEWAY_PORT: String(PORT),
  GATEWAY_SUBNET_PREFIX: SUBNET,
  OPERATOR_API_KEY: OPERATOR_KEY,
  VIEWER_API_KEY: VIEWER_KEY,
};

function compose(...args: string[]): string {
  const result = spawnSync("docker", ["compose", "-f", "infra/compose.gateway.yaml", ...args], {
    env: COMPOSE_ENV,
    encoding: "utf8",
    timeout: 400_000,
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Runs docker WITHOUT blocking the event loop. The load generators in these tests run in this same
 * process: a synchronous call would freeze them for as long as the command takes, so the fault
 * would be injected while NO requests are in flight (the first version of these tests did that and
 * overstated how well an instance kill is survived).
 */
const dockerAsync = async (...args: string[]): Promise<void> => {
  await promisify(execFile)("docker", args);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const container = (service: string) => `${PROJECT}-${service}-1`;

async function waitUntil(what: string, timeoutMs: number, check: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      /* not yet */
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

type Reply = { status: number; servedBy: string | null; requestId: string | null; body: any };

// Issued in before() through the operator plane, exactly as a real deployment would.
let clientKey = "";
let workerKey = "";
let sendNoKey = false;

function machineKeyFor(method: string, path: string): string | undefined {
  if (sendNoKey) return undefined;
  if (/^\/(workers)(\/|$)/.test(path)) return workerKey;
  if (method === "POST" && /^\/jobs\/[^/]+\/(heartbeat|complete|fail)$/.test(path))
    return workerKey;
  if (/^\/(jobs|workflows|schedules)(\/|$|\?)/.test(path)) return clientKey;
  return undefined;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; key?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  // The machine plane needs API keys: pick the right kind for the route unless told otherwise.
  const key = options.key ?? machineKeyFor(method, path);
  if (key) headers.authorization = `Bearer ${key}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(
    `${BASE}${path}`,
    body === undefined ? { method, headers } : { method, headers, body },
  );
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* html or plain text */
  }
  return {
    status: res.status,
    servedBy: res.headers.get("x-served-by"),
    requestId: res.headers.get("x-request-id"),
    body: parsed,
  };
}

function countBy<T>(items: T[], key: (item: T) => string | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item) ?? "none";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/** Sends GET requests at a steady, modest rate and records every outcome until stopped. */
function startLoad(path: string, lanes = 4, pauseMs = 60) {
  const outcomes: { ok: boolean; status: number | string; servedBy: string | null }[] = [];
  let running = true;
  const workers = Array.from({ length: lanes }, async () => {
    while (running) {
      try {
        const r = await call("GET", path);
        outcomes.push({ ok: r.status === 200, status: r.status, servedBy: r.servedBy });
      } catch (error) {
        outcomes.push({
          ok: false,
          status: String((error as Error).cause ?? error),
          servedBy: null,
        });
      }
      await sleep(pauseMs);
    }
  });
  return {
    outcomes,
    async stop() {
      running = false;
      await Promise.all(workers);
      return outcomes;
    },
  };
}

describe("gateway: NGINX in front of two API instances and one PostgreSQL", () => {
  before(async () => {
    execFileSync("npm", ["run", "build:dashboard"], { stdio: "ignore", shell: true });
    try {
      compose("down", "-v", "--remove-orphans");
    } catch {
      /* nothing to remove */
    }
    // GATEWAY_TEST_SKIP_BUILD=1 reuses the existing image (building needs to reach the Docker registry).
    compose("up", "-d", ...(process.env.GATEWAY_TEST_SKIP_BUILD === "1" ? [] : ["--build"]));
    await waitUntil(
      "gateway ready",
      120_000,
      async () => (await call("GET", "/readyz")).status === 200,
    );
    for (const kind of ["client", "worker"] as const) {
      const created = await call("POST", "/ops/keys", {
        key: OPERATOR_KEY,
        body: { kind, account: "gwtest", name: `gateway-test-${kind}` },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      if (kind === "client") clientKey = created.body.secret;
      else workerKey = created.body.secret;
    }
  });

  after(() => {
    // GATEWAY_TEST_KEEP=1 leaves the stack running so its logs can be read after a failure.
    if (process.env.GATEWAY_TEST_KEEP === "1") return;
    try {
      compose("down", "-v", "--remove-orphans");
    } catch (error) {
      console.error("cleanup failed:", error);
    }
  });

  test("requests entering at the gateway are spread across both instances", async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < 60; i++) replies.push(await call("GET", "/readyz"));
    const counts = countBy(replies, (r) => r.servedBy);
    console.log("  distribution of 60 sequential requests:", JSON.stringify(counts));
    assert.ok(replies.every((r) => r.status === 200));
    assert.ok(
      (counts["api-1"] ?? 0) >= 20 && (counts["api-2"] ?? 0) >= 20,
      "each instance serves a fair share",
    );
  });

  test("the API containers are not reachable except through the gateway", () => {
    for (const service of ["api-1", "api-2"]) {
      const ports = execFileSync("docker", ["port", container(service)], {
        encoding: "utf8",
      }).trim();
      assert.equal(ports, "", `${service} must publish no host port`);
    }
    const gatewayPorts = execFileSync("docker", ["port", container("gateway")], {
      encoding: "utf8",
    });
    assert.ok(gatewayPorts.includes(String(PORT)), "the gateway is the only published port");
  });

  test("state is shared: a job created through one instance is visible through the other", async () => {
    const created = await call("POST", "/jobs", { body: { type: "gw.shared", payload: { n: 1 } } });
    assert.equal(created.status, 201);
    const seenBy = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const got = await call("GET", `/jobs/${created.body.id}`);
      assert.equal(got.status, 200, "found no matter which instance answers");
      seenBy.add(got.servedBy ?? "?");
    }
    assert.deepEqual([...seenBy].sort(), ["api-1", "api-2"], "both instances answered");
  });

  test("60 concurrent submissions through the gateway all succeed with distinct ids", async () => {
    const replies = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        call("POST", "/jobs", { body: { type: "gw.burst", payload: { i } } }),
      ),
    );
    assert.ok(
      replies.every((r) => r.status === 201),
      "every submission accepted",
    );
    assert.equal(new Set(replies.map((r) => r.body.id)).size, 60, "no id reused");
    console.log("  submissions served by:", JSON.stringify(countBy(replies, (r) => r.servedBy)));
    const list = await call("GET", "/jobs?type=gw.burst&limit=100");
    assert.equal(list.body.items.length, 60, "all 60 are stored exactly once");
  });

  test("concurrent claims through the gateway hand every job to exactly one worker", async () => {
    const TOTAL = 60;
    await Promise.all(
      Array.from({ length: TOTAL }, (_, i) =>
        call("POST", "/jobs", { body: { type: "gw.claim", payload: { i } } }),
      ),
    );
    const workerIds: string[] = [];
    for (let w = 0; w < 6; w++) {
      const r = await call("POST", "/workers", {
        body: { name: `gw-worker-${w}`, jobTypes: ["gw.claim"], concurrency: 5 },
      });
      assert.equal(r.status, 201);
      workerIds.push(r.body.id);
    }
    const claimedBy = new Map<string, string>();
    const duplicates: string[] = [];
    const servedBy: Reply[] = [];
    await Promise.all(
      workerIds.map(async (workerId) => {
        for (;;) {
          const r = await call("POST", `/workers/${workerId}/claim`, { body: { limit: 3 } });
          servedBy.push(r);
          assert.equal(r.status, 200);
          if (r.body.jobs.length === 0) return;
          for (const job of r.body.jobs) {
            if (claimedBy.has(job.id)) duplicates.push(job.id);
            claimedBy.set(job.id, workerId);
          }
        }
      }),
    );
    console.log("  claim calls served by:", JSON.stringify(countBy(servedBy, (r) => r.servedBy)));
    assert.deepEqual(duplicates, [], "no job claimed twice");
    assert.equal(claimedBy.size, TOTAL, "every job claimed");
    assert.equal(
      new Set(servedBy.map((r) => r.servedBy)).size,
      2,
      "claims really crossed both instances",
    );
  });

  test("the gateway replaces a client-supplied request id", async () => {
    const forged = "attacker-chosen-id";
    const r = await call("GET", "/readyz", { headers: { "x-request-id": forged } });
    assert.notEqual(r.requestId, forged);
    assert.match(r.requestId ?? "", /^[0-9a-f]{32}$/, "NGINX generated it");
  });

  test("a spoofed X-Forwarded-For cannot change the recorded client address", async () => {
    const job = await call("POST", "/jobs", { body: { type: "gw.audit", payload: {} } });
    const cancelled = await call("POST", `/ops/jobs/${job.body.id}/cancel`, {
      key: OPERATOR_KEY,
      headers: { "x-forwarded-for": "6.6.6.6, 7.7.7.7" },
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const audit = await call("GET", "/ops/audit?limit=20", { key: VIEWER_KEY });
    const entry = audit.body.items.find((e: any) => e.targetId === job.body.id);
    assert.ok(entry, "the cancel was audited");
    console.log("  recorded client address:", entry.clientIp);
    assert.ok(!String(entry.clientIp).includes("6.6.6.6"), "the forged address is not trusted");
    assert.ok(
      String(entry.clientIp).startsWith(`${SUBNET}.`),
      "an address NGINX actually saw is recorded",
    );
    // If the API did not trust the gateway it would record the gateway itself (.10), which would
    // make every audit row say "from the gateway". It must record the CLIENT the gateway saw.
    assert.notEqual(entry.clientIp, `${SUBNET}.10`, "the client's address, not the gateway's own");
  });

  test("an oversized body is refused by the gateway with a JSON error", async () => {
    const huge = JSON.stringify({ type: "gw.big", payload: { blob: "x".repeat(300_000) } });
    const r = await call("POST", "/jobs", { body: huge });
    assert.equal(r.status, 413);
    // Only an API instance sets X-Served-By, so its absence proves NGINX answered and the body
    // never reached a Node process. (The API has its own limit and the same error code.)
    assert.equal(r.servedBy, null, "refused at the gateway, before reaching any instance");
    assert.equal(r.body.error.code, "payload_too_large");
    assert.equal(r.body.error.requestId, r.requestId, "the body quotes the same id as the header");
  });

  test("the dashboard is served by the gateway with a strict CSP and SPA fallback", async () => {
    const root = await fetch(`${BASE}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/dashboard/", "relative: no internal port leaks");

    const index = await fetch(`${BASE}/dashboard/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.ok(html.includes('<div id="root">'));
    const csp = index.headers.get("content-security-policy") ?? "";
    assert.ok(
      csp.includes("script-src 'self'") &&
        !csp.includes("unsafe-inline") &&
        !csp.includes("unsafe-eval"),
    );
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");

    const deepLink = await fetch(`${BASE}/dashboard/audit`);
    assert.equal(deepLink.status, 200, "a client-side route falls back to index.html");
    assert.ok((await deepLink.text()).includes('<div id="root">'));

    const asset = /\/dashboard\/assets\/[^"]+\.js/.exec(html)?.[0];
    assert.ok(asset, "index.html references a built script");
    const js = await fetch(`${BASE}${asset}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(
      (await fetch(`${BASE}/dashboard/assets/missing.js`)).status,
      404,
      "a missing asset is not index.html",
    );
  });

  test("an unknown path gets a JSON 404 from the gateway, not a Node or NGINX page", async () => {
    const r = await call("GET", "/definitely-not-a-route");
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "not_found");
  });

  test("graceful stop of one instance under load causes no failed requests", async () => {
    const job = await call("POST", "/jobs", { body: { type: "gw.load", payload: {} } });
    const load = startLoad(`/jobs/${job.body.id}`);
    await sleep(1500);
    const before = load.outcomes.length;
    const started = Date.now();
    await dockerAsync("stop", container("api-1"));
    const stopMs = Date.now() - started;
    await sleep(2500);
    const outcomes = await load.stop();
    const failures = outcomes.filter((o) => !o.ok);
    const afterStop = outcomes.slice(before + 5);
    console.log(
      `  graceful stop took ${stopMs} ms; ${outcomes.length} requests, ${failures.length} failed`,
      failures.length ? JSON.stringify(countBy(failures, (f) => String(f.status))) : "",
    );
    console.log(
      "  served by after the stop:",
      JSON.stringify(countBy(afterStop.slice(-20), (o) => o.servedBy)),
    );
    assert.equal(
      failures.length,
      0,
      "no client saw an error while an instance drained and stopped",
    );
    assert.ok(
      afterStop.slice(-20).every((o) => o.servedBy === "api-2"),
      "the survivor serves everything",
    );
  });

  test("the stopped instance rejoins rotation after it is started again", async () => {
    const started = Date.now();
    execFileSync("docker", ["start", container("api-1")], { stdio: "ignore" });
    await waitUntil("api-1 back in rotation", 40_000, async () => {
      const r = await call("GET", "/readyz");
      return r.servedBy === "api-1";
    });
    console.log(`  api-1 served traffic again ${Date.now() - started} ms after docker start`);
    const replies: Reply[] = [];
    for (let i = 0; i < 20; i++) replies.push(await call("GET", "/readyz"));
    assert.equal(new Set(replies.map((r) => r.servedBy)).size, 2, "both instances serve again");
  });

  test("killing an instance outright (no graceful drain) is survived by retrying on the other", async () => {
    const job = await call("POST", "/jobs", { body: { type: "gw.kill", payload: {} } });
    const load = startLoad(`/jobs/${job.body.id}`);
    await sleep(1500);
    await dockerAsync("kill", container("api-2"));
    await sleep(4000);
    const outcomes = await load.stop();
    const failures = outcomes.filter((o) => !o.ok);
    console.log(
      `  after SIGKILL: ${outcomes.length} requests, ${failures.length} failed`,
      failures.length ? JSON.stringify(countBy(failures, (f) => String(f.status))) : "",
    );
    // A request that was ALREADY being served by the killed instance cannot be saved. Everything
    // started afterwards must be retried on the survivor, so failures are bounded by in-flight work.
    assert.ok(
      failures.length <= 4,
      `at most the in-flight requests may fail, got ${failures.length}`,
    );
    assert.ok(outcomes.slice(-20).every((o) => o.ok && o.servedBy === "api-1"));
    execFileSync("docker", ["start", container("api-2")], { stdio: "ignore" });
    await waitUntil(
      "api-2 back",
      40_000,
      async () => (await call("GET", "/readyz")).servedBy === "api-2",
    );
  });

  test("submissions keep working while one instance is down, and nothing is lost", async () => {
    execFileSync("docker", ["stop", container("api-2")], { stdio: "ignore" });
    const replies = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        call("POST", "/jobs", { body: { type: "gw.degraded", payload: { i } } }),
      ),
    );
    assert.ok(
      replies.every((r) => r.status === 201),
      "all accepted by the surviving instance",
    );
    assert.ok(replies.every((r) => r.servedBy === "api-1"));
    execFileSync("docker", ["start", container("api-2")], { stdio: "ignore" });
    await waitUntil(
      "api-2 back",
      40_000,
      async () => (await call("GET", "/readyz")).servedBy === "api-2",
    );
    const list = await call("GET", "/jobs?type=gw.degraded&limit=100");
    assert.equal(list.body.items.length, 30, "visible through the restarted instance too");
  });

  test("with BOTH instances down the gateway answers 502/503 as JSON instead of hanging", async () => {
    execFileSync("docker", ["stop", container("api-1"), container("api-2")], { stdio: "ignore" });
    const started = Date.now();
    const r = await call("GET", "/jobs");
    const tookMs = Date.now() - started;
    console.log(`  both down: HTTP ${r.status} after ${tookMs} ms`);
    // A stopped container's address does not refuse connections, it silently drops them, so NGINX
    // gives up on connect_timeout (2 s) on each of its 2 tries: 504 after ~4 s.
    assert.ok([502, 503, 504].includes(r.status), `unexpected status ${r.status}`);
    assert.ok(r.body?.error?.requestId, "JSON error carrying the request id");
    assert.ok(tookMs < 8000, "fails fast");
    execFileSync("docker", ["start", container("api-1"), container("api-2")], { stdio: "ignore" });
    await waitUntil("recovered", 60_000, async () => {
      const seen = new Set<string | null>();
      for (let i = 0; i < 8; i++) seen.add((await call("GET", "/readyz")).servedBy);
      return seen.has("api-1") && seen.has("api-2");
    });
  });

  test("the machine plane is closed to anyone without an API key, through the gateway", async () => {
    sendNoKey = true;
    try {
      for (const [method, path, body] of [
        ["POST", "/jobs", { type: "gw.nokey", payload: {} }],
        ["GET", "/jobs", undefined],
        ["POST", "/workers", { name: "w", jobTypes: ["x"], concurrency: 1 }],
        ["GET", "/workflows", undefined],
      ] as const) {
        const r = await call(method, path, body === undefined ? {} : { body });
        assert.equal(r.status, 401, `${method} ${path}`);
        assert.equal(r.body.error.code, "unauthenticated");
      }
    } finally {
      sendNoKey = false;
    }
  });

  test("revoking a key takes effect on BOTH instances at once", async () => {
    const created = await call("POST", "/ops/keys", {
      key: OPERATOR_KEY,
      body: { kind: "client", account: "gwtest", name: "to-revoke" },
    });
    const secret = created.body.secret as string;
    const before = await Promise.all(
      Array.from({ length: 12 }, () => call("GET", "/jobs?limit=1", { key: secret })),
    );
    assert.ok(before.every((r) => r.status === 200));
    assert.equal(new Set(before.map((r) => r.servedBy)).size, 2, "both instances accepted it");
    const revoked = await call("POST", `/ops/keys/${created.body.id}/revoke`, {
      key: OPERATOR_KEY,
      body: {},
    });
    assert.equal(revoked.status, 200);
    const after = await Promise.all(
      Array.from({ length: 12 }, () => call("GET", "/jobs?limit=1", { key: secret })),
    );
    assert.ok(
      after.every((r) => r.status === 401),
      "every request, whichever instance, is refused",
    );
    assert.equal(new Set(after.map((r) => r.servedBy)).size, 2, "and both instances refused it");
  });

  test("metrics can be scraped through the gateway with a viewer key, and not without one", async () => {
    const ok = await call("GET", "/ops/metrics", { key: VIEWER_KEY });
    assert.equal(ok.status, 200);
    assert.match(String(ok.body), /# TYPE workmesh_queue_jobs gauge/);
    assert.equal((await call("GET", "/ops/metrics")).status, 401);
    assert.equal(
      (await call("GET", "/metrics")).status,
      404,
      "there is no unauthenticated /metrics",
    );
  });

  // Last on purpose: it exhausts the sign-in probe budget for this client address.
  test("hammering the sign-in probe is rate limited with a 429 and a JSON body", async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < 30; i++)
      replies.push(await call("GET", "/ops/me", { key: "wrong-key-wrong-key-wrong" }));
    const counts = countBy(replies, (r) => String(r.status));
    console.log("  30 rapid /ops/me attempts:", JSON.stringify(counts));
    const limited = replies.filter((r) => r.status === 429);
    assert.ok(limited.length >= 15, "most of the flood was refused");
    assert.equal(limited[0]?.body.error.code, "rate_limited");
    assert.ok(
      replies.slice(0, 5).every((r) => r.status === 401),
      "the first attempts reached the API (and failed auth)",
    );
  });
});
