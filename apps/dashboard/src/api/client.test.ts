import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, query } from "./client";

const json = (status: number, body: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function makeClient(fetchImpl: typeof fetch, options: { onUnauthorized?: () => void } = {}) {
  return new ApiClient({
    ...(options.onUnauthorized ? { onUnauthorized: options.onUnauthorized } : {}),
    fetchImpl,
  });
}

const call = (fetchImpl: ReturnType<typeof vi.fn>, n = 0) =>
  fetchImpl.mock.calls[n] as unknown as [string, RequestInit];
const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

const emptyStats = {
  generatedAt: "2026-01-01T00:00:00Z",
  windowMinutes: 60,
  bucketMinutes: 1,
  queue: { queued: 0, ready: 0, scheduled: 0, running: 0, oldestReadyAgeSeconds: null },
  window: {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    retries: 0,
    leaseExpirations: 0,
    throughputPerMinute: 0,
    executionSeconds: null,
    waitSeconds: null,
  },
  series: [],
  workers: { alive: 0, stale: 0 },
};

const user = {
  id: "u1",
  email: "a@example.com",
  name: "Ada",
  role: "admin",
  createdAt: "2026-01-01T00:00:00Z",
  lastLoginAt: null,
};
const identity = { user, account: { slug: "acme", name: "Acme" } };

describe("ApiClient: how requests are made", () => {
  it("talks to the customer API and sends the browser's cookie, never a credential from JavaScript", async () => {
    const fetchImpl = vi.fn(async () => json(200, emptyStats));
    await makeClient(fetchImpl as unknown as typeof fetch).stats(60);
    const [url, init] = call(fetchImpl);
    expect(url).toBe("/app/overview?windowMinutes=60");
    expect(init.credentials).toBe("same-origin");
    expect(headersOf(init).authorization).toBeUndefined();
    expect(headersOf(init)["x-workmesh-csrf"]).toBeUndefined();
  });

  it("every state-changing request carries the CSRF header", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.retryJob("abc", 3).catch(() => undefined);
    await client.deleteSchedule("s").catch(() => undefined);
    await client.setScheduleEnabled("s", false).catch(() => undefined);
    await client.revokeKey("k").catch(() => undefined);
    await client.logout().catch(() => undefined);
    for (let i = 0; i < 5; i++) {
      expect(headersOf(call(fetchImpl, i)[1])["x-workmesh-csrf"]).toBe("1");
    }
  });

  it("sends JSON bodies with a content type", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await makeClient(fetchImpl as unknown as typeof fetch)
      .retryJob("abc", 3)
      .catch(() => undefined);
    const [url, init] = call(fetchImpl);
    expect(url).toBe("/app/jobs/abc/retry");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ attempts: 3 }));
    expect(headersOf(init)["content-type"]).toBe("application/json");
  });

  it("encodes ids placed in a path", async () => {
    const fetchImpl = vi.fn(async () => json(404, { error: { code: "x", message: "m" } }));
    await makeClient(fetchImpl as unknown as typeof fetch)
      .job("a/b?c")
      .catch(() => undefined);
    expect(call(fetchImpl)[0]).toBe("/app/jobs/a%2Fb%3Fc");
  });

  it("accepts an empty 204 for deletes", async () => {
    const client = makeClient(
      (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    );
    await expect(client.deleteSchedule("s1")).resolves.toBeUndefined();
    await expect(client.removeMember("m1")).resolves.toBeUndefined();
  });

  it("asks for a page of 25 jobs by default and forwards only the filters that are set", async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [], nextCursor: null }));
    await makeClient(fetchImpl as unknown as typeof fetch).jobs({
      status: "",
      type: "email.send",
      cursor: "abc",
    });
    expect(call(fetchImpl)[0]).toBe("/app/jobs?limit=25&type=email.send&cursor=abc");
  });
});

describe("ApiClient: signing in and out", () => {
  it("login posts the credentials and returns who signed in", async () => {
    const fetchImpl = vi.fn(async () => json(200, identity));
    const me = await makeClient(fetchImpl as unknown as typeof fetch).login({
      email: "a@example.com",
      password: "correct horse battery",
    });
    expect(me.user.role).toBe("admin");
    expect(me.account.slug).toBe("acme");
    const [url, init] = call(fetchImpl);
    expect(url).toBe("/app/auth/login");
    expect(JSON.parse(String(init.body))).toEqual({
      email: "a@example.com",
      password: "correct horse battery",
    });
  });

  it("a failed sign-in is an error to show, not a 'session ended' signal", async () => {
    const onUnauthorized = vi.fn();
    const client = makeClient(
      (async () =>
        json(401, {
          error: { code: "invalid_credentials", message: "Invalid email or password" },
        })) as unknown as typeof fetch,
      { onUnauthorized },
    );
    await expect(client.login({ email: "a@b.c", password: "x" })).rejects.toMatchObject({
      status: 401,
      code: "invalid_credentials",
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("the session check returns the identity, or null for a visitor, and is never an error", async () => {
    const signedIn = vi.fn(async () => json(200, { me: identity }));
    expect((await makeClient(signedIn as unknown as typeof fetch).session())?.user.email).toBe(
      "a@example.com",
    );
    expect(call(signedIn)[0]).toBe("/app/auth/session");
    const visitor = vi.fn(async () => json(200, { me: null }));
    expect(await makeClient(visitor as unknown as typeof fetch).session()).toBeNull();
  });

  it("a 401 on anything else means the session ended, and the app is told", async () => {
    const onUnauthorized = vi.fn();
    const client = makeClient(
      (async () =>
        json(401, {
          error: { code: "unauthenticated", message: "Please sign in" },
        })) as unknown as typeof fetch,
      { onUnauthorized },
    );
    await expect(client.stats(60)).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does NOT treat a 403 as a sign-out (the session is fine, the role is not enough)", async () => {
    const onUnauthorized = vi.fn();
    const client = makeClient(
      (async () =>
        json(403, {
          error: { code: "forbidden", message: "Only an admin can do this" },
        })) as unknown as typeof fetch,
      { onUnauthorized },
    );
    await expect(client.cancelJob("x")).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("creating a key returns the secret, which is only ever in this one response", async () => {
    const created = {
      id: "k1",
      prefix: "abcd1234",
      kind: "worker",
      account: "acme",
      name: "w",
      jobTypes: null,
      createdAt: "2026-01-01T00:00:00Z",
      createdBy: "user:a@example.com",
      expiresAt: null,
      revokedAt: null,
      revokedBy: null,
      lastUsedAt: null,
      status: "active",
      secret: "wm_abcd1234_" + "x".repeat(43),
    };
    const fetchImpl = vi.fn(async () => json(201, created));
    const key = await makeClient(fetchImpl as unknown as typeof fetch).createKey({
      kind: "worker",
      name: "w",
    });
    expect(key.secret).toMatch(/^wm_abcd1234_/);
    expect(call(fetchImpl)[0]).toBe("/app/keys");
  });
});

describe("ApiClient: failures", () => {
  it("maps the server's error body onto ApiError, including field details", async () => {
    const body = {
      error: {
        code: "validation_error",
        message: "Invalid job",
        details: [{ path: "type", message: "bad type" }],
      },
    };
    const client = makeClient((async () => json(400, body)) as unknown as typeof fetch);
    const err = await client.submitJob({ type: "X", payload: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect([e.status, e.code, e.message]).toEqual([400, "validation_error", "Invalid job"]);
    expect(e.details).toEqual([{ path: "type", message: "bad type" }]);
  });

  it("turns a network failure into a clear ApiError", async () => {
    const client = makeClient((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    const err = (await client.stats(60).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.code]).toEqual([0, "network"]);
    expect(err.message).toMatch(/Cannot reach the service/);
  });

  it("rejects a response of the wrong shape instead of passing it on", async () => {
    const client = makeClient((async () =>
      json(200, { unexpected: true })) as unknown as typeof fetch);
    const err = (await client.stats(60).catch((e: unknown) => e)) as ApiError;
    expect([err.status, err.code]).toEqual([0, "bad_response"]);
  });

  it("copes with an error body that is not JSON (e.g. a proxy's HTML page)", async () => {
    const client = makeClient(
      (async () =>
        new Response("<html>Bad gateway</html>", { status: 502 })) as unknown as typeof fetch,
    );
    const err = (await client.stats(60).catch((e: unknown) => e)) as ApiError;
    expect([err.status, err.code]).toEqual([502, "unknown"]);
    expect(err.message).toMatch(/502/);
  });

  it("rethrows an abort the CALLER asked for, instead of calling it a network error", async () => {
    const controller = new AbortController();
    const client = makeClient(
      ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as unknown as typeof fetch,
    );
    const pending = client.stats(60, controller.signal);
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("query()", () => {
  it("omits empty, null and undefined values", () => {
    expect(query({ a: "1", b: "", c: undefined, d: null, e: 0 })).toBe("?a=1&e=0");
    expect(query({})).toBe("");
  });

  it("encodes special characters", () => {
    expect(query({ type: "a b&c" })).toBe("?type=a+b%26c");
  });
});
